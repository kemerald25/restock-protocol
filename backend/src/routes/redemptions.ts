import { Router, Request, Response } from "express";
import { provider, claimToken, addresses } from "../lib/contracts";
import { canonicalizeAndHashAddress } from "../lib/utils";
import { readDB, writeDB } from "../lib/db";
import { requireScope } from "../middleware/auth";
import { ethers } from "ethers";

const router = Router();

/**
 * POST /skus/{skuId}/redeem
 * Body: {
 *   "holder": "0xWalletAddress",
 *   "quantity": 1,
 *   "txHash": "0x...",
 *   "shippingAddress": "123 Web3 Boulevard, San Francisco, CA 94103, US",
 *   "shippingRef": "ref_..." // Optional
 * }
 * 
 * Flow:
 * 1. Calculate expected `shippingRef` using canonicalizeAndHashAddress.
 * 2. Fetch the transaction from Base Sepolia and decode it.
 * 3. Verify:
 *    - Transaction is mined and succeeded.
 *    - Transaction recipient is ClaimToken.
 *    - Input method is `redeem`.
 *    - Transaction sender matches `holder`.
 *    - `skuId` and `quantity` match onchain args.
 *    - `shippingRef` matches the calculated hash.
 * 4. Retrieve `redemptionId` from event logs.
 * 5. Save the redemption in the local JSON database.
 */
router.post("/skus/:skuId/redeem", requireScope("buyer:transact"), async (req: Request, res: Response) => {
  const { skuId } = req.params;
  const { holder, quantity, txHash, shippingAddress, shippingRef } = req.body;

  if (!holder || !quantity || !txHash || !shippingAddress) {
    return res.status(400).json({
      error: "Missing required fields (holder, quantity, txHash, shippingAddress) in request body"
    });
  }

  try {
    // 1. Calculate expected shippingRef from plain-text address
    const expectedShippingRef = canonicalizeAndHashAddress(shippingAddress);

    // If shippingRef was provided, make sure it matches the calculated hash
    if (shippingRef && shippingRef !== expectedShippingRef) {
      return res.status(400).json({
        error: "Provided shippingRef does not match shippingAddress hash"
      });
    }

    // 2. Fetch transaction from blockchain
    const tx = await provider.getTransaction(txHash);
    if (!tx) {
      return res.status(404).json({ error: "Transaction not found onchain" });
    }

    // 3. Decode input data to verify hash matching early
    const parsedTx = claimToken.interface.parseTransaction({
      data: tx.data,
      value: tx.value
    });

    if (!parsedTx || parsedTx.name !== "redeem") {
      return res.status(400).json({ error: "Transaction is not a ClaimToken.redeem call" });
    }

    const [txSkuId, txQuantity, txShippingRef] = parsedTx.args;

    // 4. Assert hash match between address and transaction input parameter (Security check first)
    if (txShippingRef !== expectedShippingRef) {
      return res.status(400).json({
        error: "Transaction shippingRef mismatch",
        details: `The shippingAddress provided does not hash to the shippingRef found in the onchain transaction. Onchain ref: ${txShippingRef}, calculated ref: ${expectedShippingRef}.`
      });
    }

    // 5. Idempotency Check: Return existing record if transaction has already been processed
    const db = readDB();
    const existing = Object.values(db.redemptions).find(
      (r) => r.txHash.toLowerCase() === txHash.toLowerCase()
    );
    if (existing) {
      return res.json({
        redemptionId: existing.redemptionId,
        fulfillmentStatus: existing.fulfillmentStatus,
        txHash: existing.txHash
      });
    }

    // 6. Fetch receipt to verify receipt status and other parameters
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      return res.status(400).json({ error: "Transaction is not yet mined/confirmed" });
    }

    if (receipt.status !== 1) {
      return res.status(400).json({ error: "Transaction failed/reverted onchain" });
    }

    // Verify transaction recipient is ClaimToken
    if (!tx.to || tx.to.toLowerCase() !== addresses.ClaimToken.toLowerCase()) {
      return res.status(400).json({ error: "Transaction recipient is not the ClaimToken contract" });
    }

    // Verify parameters match request
    if (txSkuId.toString() !== skuId) {
      return res.status(400).json({ error: "Transaction SKU ID does not match endpoint parameter" });
    }

    if (Number(txQuantity) !== Number(quantity)) {
      return res.status(400).json({ error: "Transaction quantity does not match request quantity" });
    }

    if (tx.from.toLowerCase() !== holder.toLowerCase()) {
      return res.status(400).json({ error: "Transaction sender does not match holder address" });
    }

    // 6. Retrieve redemptionId from UnitsRedeemed event log
    let redemptionId = "";
    for (const log of receipt.logs) {
      try {
        const parsedLog = claimToken.interface.parseLog(log);
        if (parsedLog && parsedLog.name === "UnitsRedeemed") {
          redemptionId = parsedLog.args.redemptionId.toString();
          break;
        }
      } catch (err) {
        // Ignore logs that don't match
      }
    }

    if (!redemptionId) {
      return res.status(400).json({ error: "UnitsRedeemed event log not found in transaction receipt" });
    }

    // 7. Store offchain fulfillment details in JSON database
    const finalDb = readDB();
    finalDb.redemptions[redemptionId] = {
      redemptionId,
      skuId,
      holder,
      quantity: Number(quantity),
      shippingRef: expectedShippingRef,
      shippingAddressResolved: shippingAddress,
      fulfillmentStatus: "Pending",
      txHash,
      createdAt: Math.floor(Date.now() / 1000)
    };
    finalDb.shippingAddresses[expectedShippingRef] = shippingAddress;
    writeDB(finalDb);

    res.json({
      redemptionId,
      fulfillmentStatus: "Pending",
      txHash
    });
  } catch (error: any) {
    console.error("[Redemptions Route Error]:", error);
    res.status(500).json({ error: "Internal server error during redemption validation", details: error.message });
  }
});

export default router;

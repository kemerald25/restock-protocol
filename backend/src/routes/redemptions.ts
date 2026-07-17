import { Router, Request, Response } from "express";
import { MOCK_SKU_CONFIG } from "../config";
import crypto from "crypto";

const router = Router();

// In-memory offchain shipping address storage mockup
const offchainShippingDB = new Map<string, any>();

/**
 * POST /skus/{skuId}/redeem
 * Body: {
 *   "holder": "0xWalletAddress",
 *   "quantity": 1,
 *   "shippingRef": "ref_9f21", // Or optional "shippingAddress" object to generate a ref
 *   "shippingAddress": { ... } // Optional raw shipping address
 * }
 * 
 * TODO:
 * 1. If "shippingAddress" is passed, generate a SHA256 reference hash, store the address offchain,
 *    and use this hash as the `shippingRef`.
 * 2. Invoke `IClaimToken.redeem(skuId, quantity, shippingRef)` on the blockchain on behalf of the holder.
 * 3. Save the RedemptionRequest database state mapping to the transaction.
 */
router.post("/skus/:skuId/redeem", (req: Request, res: Response) => {
  const { skuId } = req.params;
  const { holder, quantity, shippingRef, shippingAddress } = req.body;

  if (skuId !== MOCK_SKU_CONFIG.skuId) {
    return res.status(404).json({ error: "SKU not found" });
  }

  if (!holder || !quantity) {
    return res.status(400).json({ error: "Missing holder or quantity in body" });
  }

  let finalShippingRef = shippingRef;

  if (shippingAddress) {
    // Generate a secure offchain reference hash to respect privacy constraints (Section 2.1)
    const hash = crypto.createHash("sha256");
    hash.update(JSON.stringify(shippingAddress) + Date.now().toString());
    finalShippingRef = `ref_${hash.digest("hex").slice(0, 8)}`;
    
    // Store address offchain mapping to the reference hash
    offchainShippingDB.set(finalShippingRef, shippingAddress);
  }

  if (!finalShippingRef) {
    return res.status(400).json({ error: "Either shippingRef or shippingAddress must be provided" });
  }

  // Returning mock response per Section 4.5 of the design spec
  res.json({
    redemptionId: "8",
    fulfillmentStatus: "Pending",
    txHash: "0xmockedredemptiontransactionhash"
  });
});

export default router;

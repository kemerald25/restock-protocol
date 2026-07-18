import { Router, Request, Response } from "express";
import { skuRegistryWithSigner, merchantSigner } from "../lib/contracts";
import { readDB, writeDB } from "../lib/db";
import { ethers } from "ethers";

const router = Router();

/**
 * GET /admin/redemptions?status=Pending
 * 
 * Retrieve all redemption requests from the offchain store, filtered by status.
 */
router.get("/admin/redemptions", (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    const db = readDB();
    
    let redemptionsList = Object.values(db.redemptions);
    
    if (status) {
      const statusFilter = String(status).toLowerCase();
      redemptionsList = redemptionsList.filter(
        (r) => r.fulfillmentStatus.toLowerCase() === statusFilter
      );
    }
    
    res.json({ redemptions: redemptionsList });
  } catch (error: any) {
    console.error("[Admin Redemptions GET Error]:", error);
    res.status(500).json({ error: "Failed to retrieve redemptions", details: error.message });
  }
});

/**
 * POST /admin/redemptions/{redemptionId}/mark-shipped
 * 
 * Update offchain fulfillment status. This does not touch the blockchain.
 */
router.post("/admin/redemptions/:redemptionId/mark-shipped", (req: Request, res: Response) => {
  const { redemptionId } = req.params;
  
  try {
    const db = readDB();
    const redemption = db.redemptions[redemptionId];
    
    if (!redemption) {
      return res.status(404).json({ error: "Redemption request not found in offchain database" });
    }
    
    redemption.fulfillmentStatus = "Shipped";
    writeDB(db);
    
    res.json({
      redemptionId,
      fulfillmentStatus: "Shipped",
      updatedAt: Math.floor(Date.now() / 1000),
    });
  } catch (error: any) {
    console.error("[Admin Mark-Shipped Error]:", error);
    res.status(500).json({ error: "Failed to update redemption status", details: error.message });
  }
});

/**
 * POST /admin/skus/{skuId}/basis-value
 * Body: { "value": "155.00" }
 * 
 * Execute an onchain transaction calling `SKURegistry.updateBasisValue(...)`
 * using the merchant signer wallet.
 */
router.post("/admin/skus/:skuId/basis-value", async (req: Request, res: Response) => {
  const { skuId } = req.params;
  const { value } = req.body;
  
  if (!value) {
    return res.status(400).json({ error: "Missing value in request body" });
  }
  
  if (!merchantSigner) {
    return res.status(500).json({
      error: "Merchant private key not configured on server. Cannot execute onchain admin transactions."
    });
  }
  
  try {
    const skuIdBigInt = BigInt(skuId);
    
    // Parse value into USDC (6 decimals)
    const newBasisValueRaw = ethers.parseUnits(String(value), 6);
    
    console.log(`[Admin Basis Value] Calling updateBasisValue for SKU ${skuId} with value ${newBasisValueRaw.toString()}...`);
    
    // Call the contract
    const tx = await skuRegistryWithSigner.updateBasisValue(skuIdBigInt, newBasisValueRaw);
    console.log(`[Admin Basis Value] Transaction submitted: ${tx.hash}`);
    
    const receipt = await tx.wait();
    console.log(`[Admin Basis Value] Transaction confirmed in block: ${receipt?.blockNumber}`);
    
    res.json({
      skuId: skuId,
      newBasisValue: value,
      status: "Success",
      txHash: tx.hash,
    });
  } catch (error: any) {
    console.error("[Admin Basis-Value Error]:", error);
    res.status(500).json({ error: "Failed to update basis value onchain", details: error.message });
  }
});

export default router;

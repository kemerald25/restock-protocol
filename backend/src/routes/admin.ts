import { Router, Request, Response } from "express";
import { MOCK_SKU_CONFIG } from "../config";

const router = Router();

/**
 * GET /admin/redemptions?status=Pending
 * 
 * TODO: Retrieve all redemption requests from the smart contract registry or local cache
 * along with their offchain resolved shipping addresses.
 */
router.get("/admin/redemptions", (req: Request, res: Response) => {
  const { status } = req.query;

  // Mock response showing pending redemptions
  res.json({
    redemptions: [
      {
        redemptionId: "8",
        skuId: MOCK_SKU_CONFIG.skuId,
        holder: "0xAgentWalletAddress",
        quantity: 1,
        shippingRef: "ref_9f21",
        shippingAddressResolved: {
          fullName: "Autonomous Agent Principal",
          street1: "123 Web3 Boulevard",
          city: "San Francisco",
          state: "CA",
          postalCode: "94103",
          country: "US"
        },
        fulfillmentStatus: status || "Pending",
        createdAt: Math.floor(Date.now() / 1000) - 600
      }
    ]
  });
});

/**
 * POST /admin/redemptions/{redemptionId}/mark-shipped
 * 
 * TODO: Trigger offchain notification and update database status. 
 * (For Phase 0/1 this is tracked in-memory or mock DB).
 */
router.post("/admin/redemptions/:redemptionId/mark-shipped", (req: Request, res: Response) => {
  const { redemptionId } = req.params;

  res.json({
    redemptionId: redemptionId,
    fulfillmentStatus: "Shipped",
    updatedAt: Math.floor(Date.now() / 1000)
  });
});

/**
 * POST /admin/skus/{skuId}/basis-value
 * Body: { "value": "155.00" }
 * 
 * TODO: Execute onchain transaction to call `ISKURegistry.updateBasisValue(...)`
 * on behalf of the SKU's owner (merchant wallet).
 */
router.post("/admin/skus/:skuId/basis-value", (req: Request, res: Response) => {
  const { skuId } = req.params;
  const { value } = req.body;

  if (skuId !== MOCK_SKU_CONFIG.skuId) {
    return res.status(404).json({ error: "SKU not found" });
  }

  if (!value) {
    return res.status(400).json({ error: "Missing value in body" });
  }

  res.json({
    skuId: skuId,
    newBasisValue: value,
    status: "Success",
    txHash: "0xmockedupdatebasisvaluetxhash"
  });
});

export default router;

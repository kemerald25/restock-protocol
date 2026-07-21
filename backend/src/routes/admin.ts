import { Router, Request, Response } from "express";
import { skuRegistryWithSigner, merchantSigner } from "../lib/contracts";
import { readDB, writeDB } from "../lib/db";
import { requireScope } from "../middleware/auth";
import { ethers } from "ethers";

const router = Router();

/**
 * GET /admin/redemptions?status=Pending
 * 
 * Retrieve all redemption requests from the offchain store, filtered by status.
 */
router.get("/admin/redemptions", requireScope("admin:read"), (req: Request, res: Response) => {
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
router.post("/admin/redemptions/:redemptionId/mark-shipped", requireScope("admin:write"), (req: Request, res: Response) => {
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
router.post("/admin/skus/:skuId/basis-value", requireScope("admin:write"), async (req: Request, res: Response) => {
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

/**
 * GET /admin/sku-requests?status=PENDING
 * Requires admin:read scope.
 */
router.get("/admin/sku-requests", requireScope("admin:read"), (req: Request, res: Response) => {
  const db = readDB();
  const { status } = req.query;

  let requests = Object.values(db.pendingSkuRequests);
  if (status) {
    const sFilter = String(status).toUpperCase();
    requests = requests.filter((r) => r.status.toUpperCase() === sFilter);
  }

  res.json({ requests });
});

/**
 * POST /admin/sku-requests/:id/approve
 * Requires admin:write scope.
 * Submits the deferred Tier 0 SKU creation onchain.
 */
router.post("/admin/sku-requests/:id/approve", requireScope("admin:write"), async (req: Request, res: Response) => {
  const { id } = req.params;
  const db = readDB();
  const request = db.pendingSkuRequests[id];

  if (!request) {
    return res.status(404).json({ error: "Pending SKU request not found" });
  }

  if (request.status !== "PENDING") {
    return res.status(400).json({ error: `Cannot approve SKU request with status '${request.status}'` });
  }

  if (!merchantSigner || !skuRegistryWithSigner) {
    return res.status(500).json({ error: "Server relayer / merchant signer not configured for onchain submission" });
  }

  try {
    const basisValueRaw = ethers.parseUnits(String(request.initialBasisValue), 6);
    const tx = await skuRegistryWithSigner.createSKU(
      BigInt(request.maxSupply),
      BigInt(request.royaltyBps),
      basisValueRaw,
      request.metadataURI
    );

    const receipt = await tx.wait();

    let newSkuId = 1;
    if (receipt?.logs) {
      for (const log of receipt.logs) {
        try {
          const parsed = skuRegistryWithSigner.interface.parseLog(log);
          if (parsed && parsed.name === "SKUCreated") {
            newSkuId = Number(parsed.args.skuId);
            break;
          }
        } catch (e) {}
      }
    }

    request.status = "APPROVED";
    request.reviewedAt = Math.floor(Date.now() / 1000);
    request.onchainSkuId = newSkuId;
    request.txHash = tx.hash;

    // Index SKU under merchant
    if (!db.merchantSkus[request.merchantId]) db.merchantSkus[request.merchantId] = [];
    if (!db.merchantSkus[request.merchantId].includes(String(newSkuId))) {
      db.merchantSkus[request.merchantId].push(String(newSkuId));
    }

    writeDB(db);

    return res.json({
      status: "APPROVED",
      requestId: id,
      onchainSkuId: newSkuId,
      txHash: tx.hash
    });
  } catch (err: any) {
    console.error("[Admin SKU Approval Error]:", err);
    return res.status(500).json({ error: "Failed to submit SKU creation onchain", details: err.message });
  }
});

/**
 * POST /admin/sku-requests/:id/reject
 * Requires admin:write scope.
 */
router.post("/admin/sku-requests/:id/reject", requireScope("admin:write"), (req: Request, res: Response) => {
  const { id } = req.params;
  const { reason } = req.body;
  const db = readDB();

  const request = db.pendingSkuRequests[id];
  if (!request) {
    return res.status(404).json({ error: "Pending SKU request not found" });
  }

  request.status = "REJECTED";
  request.reviewedAt = Math.floor(Date.now() / 1000);
  if (reason) request.rejectionReason = String(reason);

  writeDB(db);

  return res.json({
    status: "REJECTED",
    requestId: id,
    rejectionReason: request.rejectionReason
  });
});

/**
 * GET /admin/audit-logs
 * Requires admin:read scope.
 * Query parameters: ownerId, route, limit
 */
router.get("/admin/audit-logs", requireScope("admin:read"), (req: Request, res: Response) => {
  const db = readDB();
  const { ownerId, route: routeFilter, limit } = req.query;

  let logs = db.auditLogs;

  if (ownerId) {
    logs = logs.filter((l) => l.ownerId === String(ownerId));
  }

  if (routeFilter) {
    const rStr = String(routeFilter).toLowerCase();
    logs = logs.filter((l) => l.route.toLowerCase().includes(rStr));
  }

  const maxEntries = limit ? parseInt(String(limit), 10) : 100;
  if (!isNaN(maxEntries) && maxEntries > 0) {
    logs = logs.slice(0, maxEntries);
  }

  res.json({ logs });
});

export default router;


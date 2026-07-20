import { Router, Request, Response } from "express";
import { skuRegistry } from "../lib/contracts";
import { getOpenListingsForSKU } from "../lib/queries";

const router = Router();

/**
 * GET /skus/{skuId}/listings
 * 
 * Query the Marketplace contract for all open, active listings for the given SKU,
 * sorted by price per unit ascending.
 */
router.get("/skus/:skuId/listings", async (req: Request, res: Response) => {
  const { skuId } = req.params;

  try {
    const skuIdBigInt = BigInt(skuId);

    // Verify SKU exists onchain; throws if not found
    await skuRegistry.getSKU(skuIdBigInt);

    // Fetch open listings
    const listings = await getOpenListingsForSKU(skuIdBigInt);

    // Sort listings by price ascending
    listings.sort((a, b) => parseFloat(a.pricePerUnit) - parseFloat(b.pricePerUnit));

    res.json({
      skuId: skuId,
      listings: listings
    });
  } catch (error: any) {
    // If the contract reverted, it's likely SKU doesn't exist
    if (error.message && error.message.includes("SKU does not exist")) {
      return res.status(404).json({ error: "SKU not found" });
    }

    // Check if error is due to RPC rate limiting / network failure after retries exhausted
    const errStr = String(error?.message || "") + " " + String(error?.code || "") + " " + JSON.stringify(error || {});
    const isRpcError = 
      errStr.includes("rate limit") ||
      errStr.includes("over rate limit") ||
      errStr.includes("429") ||
      errStr.includes("-32016") ||
      errStr.includes("ECONNRESET") ||
      errStr.includes("ETIMEDOUT") ||
      errStr.includes("ENOTFOUND") ||
      error?.code === "TIMEOUT" ||
      error?.code === "SERVER_ERROR";

    if (isRpcError) {
      console.error("[Listings Route RPC Error]:", error.message || error);
      return res.status(503).json({
        error: "Upstream RPC rate limited or temporarily unavailable",
        details: error.message
      });
    }

    console.error("[Listings Route Error]:", error);
    res.status(500).json({ error: "Failed to retrieve listings from blockchain", details: error.message });
  }
});

export default router;

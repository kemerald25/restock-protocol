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
    console.error("[Listings Route Error]:", error);
    res.status(500).json({ error: "Failed to retrieve listings from blockchain", details: error.message });
  }
});

export default router;

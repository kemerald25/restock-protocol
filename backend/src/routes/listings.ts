import { Router, Request, Response } from "express";
import { MOCK_SKU_CONFIG } from "../config";

const router = Router();

/**
 * GET /skus/{skuId}/listings
 * 
 * TODO: Query the smart contract or an indexer for active, open listings on the IMarketplace contract.
 * Results must be sorted by price per unit ascending so agents can discover the cheapest available unit.
 */
router.get("/skus/:skuId/listings", (req: Request, res: Response) => {
  const { skuId } = req.params;

  if (skuId !== MOCK_SKU_CONFIG.skuId) {
    return res.status(404).json({ error: "SKU not found" });
  }

  // Returning mock listings sorted by price ascending
  res.json({
    skuId: skuId,
    listings: [
      {
        listingId: 7,
        skuId: skuId,
        seller: "0xSellerAddressPlaceholder",
        quantity: 5,
        pricePerUnit: MOCK_SKU_CONFIG.lowestListingPrice,
        status: "Open",
        createdAt: Math.floor(Date.now() / 1000) - 3600
      },
      {
        listingId: 8,
        skuId: skuId,
        seller: "0xAnotherSellerAddress",
        quantity: 2,
        pricePerUnit: "165.00",
        status: "Open",
        createdAt: Math.floor(Date.now() / 1000) - 1800
      }
    ]
  });
});

export default router;

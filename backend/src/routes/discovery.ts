import { Router, Request, Response } from "express";
import { MOCK_SKU_CONFIG } from "../config";

const router = Router();

/**
 * GET /skus?category=sneakers&maxPrice=250&available=true
 * 
 * TODO: Implement database search/indexing to retrieve live SKUs and current availability.
 * Currently returns the mock SKU RS-01 as the only results matching the Phase 0 spec.
 */
router.get("/skus", (req: Request, res: Response) => {
  const { category, maxPrice, available } = req.query;

  // Returning mock response per Section 4.1 of the design spec
  res.json({
    results: [
      {
        skuId: MOCK_SKU_CONFIG.skuId,
        name: MOCK_SKU_CONFIG.name,
        variant: MOCK_SKU_CONFIG.variant,
        merchant: MOCK_SKU_CONFIG.merchant,
        maxSupply: MOCK_SKU_CONFIG.maxSupply,
        mintedSupply: MOCK_SKU_CONFIG.mintedSupply,
        redeemedSupply: MOCK_SKU_CONFIG.redeemedSupply,
        availableUnits: MOCK_SKU_CONFIG.availableUnits,
        basisValue: MOCK_SKU_CONFIG.basisValue,
        lowestListingPrice: MOCK_SKU_CONFIG.lowestListingPrice,
        royaltyBps: MOCK_SKU_CONFIG.royaltyBps,
        metadataURI: MOCK_SKU_CONFIG.metadataURI
      }
    ]
  });
});

export default router;

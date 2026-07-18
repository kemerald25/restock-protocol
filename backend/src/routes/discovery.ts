import { Router, Request, Response } from "express";
import { getSKUs } from "../lib/queries";

const router = Router();

/**
 * GET /skus?category=sneakers&maxPrice=250&available=true
 * 
 * Retrieve live SKUs from the smart contract registry and calculate availability based on listings.
 */
router.get("/skus", async (req: Request, res: Response) => {
  try {
    const { category, maxPrice, available } = req.query;

    const allSkus = await getSKUs();
    let results = allSkus;

    // Apply category filter (case-insensitive)
    if (category) {
      const catFilter = String(category).toLowerCase();
      results = results.filter((sku) => sku.category.toLowerCase() === catFilter);
    }

    // Apply maxPrice filter
    if (maxPrice) {
      const maxVal = parseFloat(String(maxPrice));
      if (!isNaN(maxVal)) {
        results = results.filter(
          (sku) => sku.lowestListingPrice !== null && parseFloat(sku.lowestListingPrice) <= maxVal
        );
      }
    }

    // Apply available filter (units must be > 0 if true, == 0 if false)
    if (available !== undefined) {
      const isAvailable = String(available).toLowerCase() === "true";
      results = results.filter((sku) =>
        isAvailable ? sku.availableUnits > 0 : sku.availableUnits === 0
      );
    }

    res.json({ results });
  } catch (error: any) {
    console.error("[Discovery Route Error]:", error);
    res.status(500).json({ error: "Failed to retrieve SKUs from blockchain", details: error.message });
  }
});

export default router;

import { Router, Request, Response } from "express";

const router = Router();

/**
 * POST /listings/{listingId}/reserve
 * Body: { "buyer": "0xAgentWallet", "quantity": 1 }
 * 
 * TODO: implement in Phase 3, Part 2 (x402 integration)
 */
router.post("/listings/:listingId/reserve", (req: Request, res: Response) => {
  res.status(501).json({
    error: "Not Implemented",
    message: "Reservation endpoints are deferred to Phase 3, Part 2 (x402 integration)."
  });
});

/**
 * POST /reservations/{reservationId}/pay
 * Headers: X-Payment-Proof
 * 
 * TODO: implement in Phase 3, Part 2 (x402 integration)
 */
router.post("/reservations/:reservationId/pay", (req: Request, res: Response) => {
  res.status(501).json({
    error: "Not Implemented",
    message: "Payment endpoints are deferred to Phase 3, Part 2 (x402 integration)."
  });
});

export default router;

import { Router, Request, Response } from "express";
import { MOCK_SKU_CONFIG } from "../config";

const router = Router();

/**
 * POST /listings/{listingId}/reserve
 * Body: { "buyer": "0xAgentWallet", "quantity": 1 }
 * 
 * TODO: Invoke IMarketplace.reserve(...) onchain to lock inventory.
 * In a real application, the backend should index this onchain reservation event 
 * and return the created reservation parameters.
 */
router.post("/listings/:listingId/reserve", (req: Request, res: Response) => {
  const { listingId } = req.params;
  const { buyer, quantity } = req.body;

  if (!buyer || !quantity) {
    return res.status(400).json({ error: "Missing buyer or quantity in request body" });
  }

  const reservationTTLSeconds = MOCK_SKU_CONFIG.reservationTTL;
  const expiresAt = new Date(Date.now() + reservationTTLSeconds * 1000).toISOString();

  // Returning mock response per Section 4.3 of the design spec
  res.json({
    reservationId: "42",
    listingId: listingId,
    quantity: quantity,
    expiresAt: expiresAt,
    totalDue: MOCK_SKU_CONFIG.lowestListingPrice,
    paymentEndpoint: `/reservations/42/pay`
  });
});

/**
 * POST /reservations/{reservationId}/pay
 * Headers: X-Payment-Proof (optional, used by x402 agents to send TX hash or signature)
 * 
 * TODO: Implement x402 payment verification loop.
 * - If no X-Payment-Proof header is provided: return HTTP 402 Payment Required
 *   specifying payment details (USDC address, merchant recipient wallet, amount, and chainId).
 * - If X-Payment-Proof is provided: verify the payment transaction on Base Sepolia,
 *   invoke IMarketplace.fulfillReservation(...) onchain to finalize purchase, and return success.
 */
router.post("/reservations/:reservationId/pay", (req: Request, res: Response) => {
  const { reservationId } = req.params;
  const paymentProof = req.headers["x-payment-proof"];

  const paymentTokenAddress = process.env.TESTNET_USDC_ADDRESS || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const merchantAddress = MOCK_SKU_CONFIG.merchant;
  const amountDue = MOCK_SKU_CONFIG.lowestListingPrice;
  const chainId = 84532; // Base Sepolia

  if (!paymentProof) {
    // Return HTTP 402 Payment Required with headers and JSON details
    res.setHeader("X-Payment-Token", paymentTokenAddress);
    res.setHeader("X-Payment-Chain-Id", chainId.toString());
    res.setHeader("X-Payment-Amount", amountDue);
    res.setHeader("X-Payment-Address", merchantAddress);

    return res.status(402).json({
      error: "Payment Required",
      paymentRequirements: {
        amount: amountDue,
        tokenAddress: paymentTokenAddress,
        recipientAddress: merchantAddress,
        chainId: chainId,
        note: "Submit transaction hash on Base Sepolia in the 'X-Payment-Proof' header to complete."
      }
    });
  }

  // If payment proof is present, simulate successful verification and onchain execution
  res.json({
    status: "completed",
    redemptionId: null, // Purchase completes and returns tokens to buyer; redemption is a separate step
    claimTokenBalance: 1,
    txHash: String(paymentProof) // Mock returning the verified proof transaction hash
  });
});

export default router;

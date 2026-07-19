import { Router, Request, Response } from "express";
import { ethers } from "ethers";
// @ts-ignore
import { HTTPFacilitatorClient } from "@x402/core/server";
// @ts-ignore
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { readDB, writeDB, ReservationRecord } from "../lib/db";
import {
  marketplace,
  marketplaceWithRelayer,
  claimToken,
  claimTokenWithRelayer,
  usdc,
  usdcWithRelayer,
  addresses,
  relayerSigner
} from "../lib/contracts";
import { getListingActiveReservations } from "../lib/queries";
import { triggerRefund } from "../lib/reconciliation";

const router = Router();

const facilitatorClient = new HTTPFacilitatorClient({
  url: "https://x402.org/facilitator"
});

/**
 * POST /listings/:listingId/reserve
 * Body: { "buyer": "0xAgentWallet", "quantity": 1 }
 */
router.post("/listings/:listingId/reserve", async (req: Request, res: Response) => {
  try {
    const listingId = Number(req.params.listingId);
    const { buyer, quantity } = req.body;

    if (!buyer || !ethers.isAddress(buyer)) {
      return res.status(400).json({ error: "Invalid buyer address" });
    }
    if (!quantity || Number(quantity) <= 0) {
      return res.status(400).json({ error: "Quantity must be greater than zero" });
    }

    // 1. Check listing status
    const listing = await marketplace.getListing(listingId);
    if (Number(listing.status) !== 0) {
      return res.status(400).json({ error: "Listing is not open" });
    }

    // 2. Check available quantity (accounting for other active reservations)
    const reservedQty = await getListingActiveReservations(listingId);
    const available = Number(listing.quantity) - Number(reservedQty);
    if (quantity > available) {
      return res.status(400).json({ error: "Insufficient available units on listing" });
    }

    if (!relayerSigner) {
      return res.status(500).json({ error: "Relayer wallet not configured" });
    }

    console.log(`[Reserve Route] Reserving ${quantity} units of listing ${listingId} using relayer...`);

    // 3. Perform on-chain reservation
    const tx = await marketplaceWithRelayer.reserve(listingId, quantity);
    const receipt = await tx.wait();

    // 4. Parse Reserved event
    const parsedLogs = receipt.logs.map((log: any) => {
      try {
        return marketplaceWithRelayer.interface.parseLog(log);
      } catch (e) {
        return null;
      }
    });
    const reservedEvent = parsedLogs.find((l: any) => l && l.name === "Reserved");
    if (!reservedEvent) {
      throw new Error("Reserved event not found in transaction receipt");
    }

    const reservationId = reservedEvent.args[0].toString();
    const expiresAt = Number(reservedEvent.args[4]);

    const pricePerUnit = (Number(listing.pricePerUnit) / 1000000).toFixed(2);
    const totalDue = (Number(listing.pricePerUnit) * quantity / 1000000).toFixed(2);

    // 5. Store record in db.json
    const db = readDB();
    const record: ReservationRecord = {
      reservationId,
      listingId,
      buyer: ethers.getAddress(buyer),
      quantity,
      status: "PENDING_SIGNATURE",
      pricePerUnit,
      totalDue,
      expiresAt,
      retryCount: 0,
      updatedAt: Math.floor(Date.now() / 1000)
    };

    db.reservations[reservationId] = record;
    writeDB(db);

    console.log(`[Reserve Route] Reservation ${reservationId} created. Expires at ${expiresAt}`);

    return res.status(200).json({
      reservationId,
      status: record.status,
      totalDue,
      expiresAt
    });
  } catch (err: any) {
    console.error(`[Reserve Route] Error:`, err.message || err);
    return res.status(500).json({ error: "Failed to create reservation", message: err.message });
  }
});

/**
 * POST /reservations/:reservationId/pay
 */
router.post("/reservations/:reservationId/pay", async (req: Request, res: Response) => {
  try {
    const { reservationId } = req.params;
    const db = readDB();
    const record = db.reservations[reservationId];

    if (!record) {
      return res.status(404).json({ error: "Reservation not found" });
    }

    if (record.status !== "PENDING_SIGNATURE") {
      return res.status(400).json({
        error: "Invalid reservation status",
        message: `Reservation is currently in ${record.status} state`
      });
    }

    const paymentSigHeader = req.headers["payment-signature"] as string;

    // 1. If payment-signature header is missing, challenge client with 402 Payment Required
    if (!paymentSigHeader) {
      if (!relayerSigner) {
        return res.status(500).json({ error: "Relayer wallet not configured" });
      }

      const paymentRequired = {
        x402Version: 2,
        resource: {
          url: `/reservations/${reservationId}/pay`,
          description: `Payment for Restock Protocol Reservation #${reservationId}`
        },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:84532" as const,
            asset: addresses.USDC,
            amount: ethers.parseUnits(record.totalDue, 6).toString(),
            payTo: relayerSigner.address,
            maxTimeoutSeconds: 120,
            extra: {
              name: "USDC",
              version: "2"
            }
          }
        ]
      };

      const encodedHeader = encodePaymentRequiredHeader(paymentRequired);
      res.setHeader("PAYMENT-REQUIRED", encodedHeader);
      return res.status(402).json(paymentRequired);
    }

    // 2. Decode payment payload
    console.log(`[Pay Route] Decoding payment signature header for reservation ${reservationId}...`);
    const paymentPayload = decodePaymentSignatureHeader(paymentSigHeader);

    // 3. Verify signature using x402 facilitator
    console.log(`[Pay Route] Verifying signature against facilitator...`);
    const verifyResult = await facilitatorClient.verify(paymentPayload, paymentPayload.accepted);
    if (!verifyResult.isValid) {
      return res.status(400).json({
        error: "Invalid payment signature",
        message: verifyResult.invalidMessage
      });
    }

    // 4. Settle payment (broadcasting on-chain EIP-3009 transaction)
    console.log(`[Pay Route] Settling EIP-3009 payment...`);
    const settleResult = await facilitatorClient.settle(paymentPayload, paymentPayload.accepted);
    if (!settleResult.success) {
      return res.status(400).json({
        error: "Payment settlement failed",
        message: settleResult.errorMessage
      });
    }

    const paymentTxHash = settleResult.transaction;
    console.log(`[Pay Route] Payment settled successfully. Tx hash: ${paymentTxHash}`);

    // Update state to PAID
    record.status = "PAID";
    record.paymentTxHash = paymentTxHash;
    record.updatedAt = Math.floor(Date.now() / 1000);
    writeDB(db);

    // Wait for relayer USDC balance to reflect the payment
    console.log(`[Pay Route] Waiting for relayer USDC balance to sync...`);
    const neededUSDC = ethers.parseUnits(record.totalDue, 6);
    let usdcSynced = false;
    for (let i = 0; i < 15; i++) {
      const balance = await usdc.balanceOf(relayerSigner!.address);
      if (balance >= neededUSDC) {
        usdcSynced = true;
        break;
      }
      console.log(`[Pay Route] Relayer USDC balance not yet synced, retrying in 2s...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!usdcSynced) {
      console.warn(`[Pay Route] Warning: Relayer USDC balance not synced on RPC, continuing anyway...`);
    }

    // 5. Try to fulfill reservation immediately (Inline Try/Catch)
    try {
      console.log(`[Pay Route] Calling fulfillReservation on-chain...`);
      const fulfillTx = await marketplaceWithRelayer.fulfillReservation(reservationId);
      console.log(`[Pay Route] Fulfillment TX submitted: ${fulfillTx.hash}`);
      record.fulfillmentTxHash = fulfillTx.hash;
      writeDB(db);

      const fulfillReceipt = await fulfillTx.wait();
      if (!fulfillReceipt || fulfillReceipt.status !== 1) {
        throw new Error("Fulfillment transaction reverted on-chain");
      }

      console.log(`[Pay Route] Fulfillment confirmed. State: FULFILLED`);
      record.status = "FULFILLED";
      record.updatedAt = Math.floor(Date.now() / 1000);
      writeDB(db);

      // 6. Try to deliver claim tokens immediately
      console.log(`[Pay Route] Fetching listing details to deliver claim tokens...`);
      const listing = await marketplace.getListing(record.listingId);
      const skuId = listing.skuId;

      const relayerAddress = relayerSigner!.address;
      
      console.log(`[Pay Route] Waiting for relayer ClaimToken balance to sync...`);
      let balanceVerified = false;
      for (let i = 0; i < 15; i++) {
        const bal = await claimToken.balanceOf(relayerAddress, skuId);
        if (Number(bal) >= record.quantity) {
          balanceVerified = true;
          break;
        }
        console.log(`[Pay Route] Relayer balance not yet visible on RPC, retrying in 2s...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (!balanceVerified) {
        throw new Error("Relayer ClaimToken balance failed to sync on RPC");
      }

      console.log(`[Pay Route] Delivering SKU token ${skuId} to client ${record.buyer}...`);
      const deliveryTx = await claimTokenWithRelayer.safeTransferFrom(
        relayerAddress,
        record.buyer,
        skuId,
        record.quantity,
        "0x"
      );
      console.log(`[Pay Route] Delivery TX submitted: ${deliveryTx.hash}`);
      record.deliveryTxHash = deliveryTx.hash;
      writeDB(db);

      const deliveryReceipt = await deliveryTx.wait();
      if (!deliveryReceipt || deliveryReceipt.status !== 1) {
        throw new Error("Delivery transaction reverted on-chain");
      }

      console.log(`[Pay Route] Claim tokens delivered. State: DELIVERED`);
      record.status = "DELIVERED";
      record.updatedAt = Math.floor(Date.now() / 1000);
      writeDB(db);

      // Set successful PAYMENT-RESPONSE header
      const encodedResponseHeader = encodePaymentResponseHeader(settleResult);
      res.setHeader("PAYMENT-RESPONSE", encodedResponseHeader);

      return res.status(200).json({
        status: record.status,
        paymentTxHash: record.paymentTxHash,
        fulfillmentTxHash: record.fulfillmentTxHash,
        deliveryTxHash: record.deliveryTxHash
      });

    } catch (fulfillmentErr: any) {
      console.error(`[Pay Route] Fulfillment/Delivery failed. Triggering refund. Error:`, fulfillmentErr.message || fulfillmentErr);
      await triggerRefund(record, db, fulfillmentErr.message || "Fulfillment/delivery reverted");
      
      return res.status(500).json({
        status: record.status,
        error: "Fulfillment failed, client has been refunded",
        message: fulfillmentErr.message,
        paymentTxHash: record.paymentTxHash,
        refundTxHash: record.refundTxHash
      });
    }

  } catch (err: any) {
    console.error(`[Pay Route] Error:`, err.message || err);
    return res.status(500).json({ error: "Failed to process payment", message: err.message });
  }
});

export default router;

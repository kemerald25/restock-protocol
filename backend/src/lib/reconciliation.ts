import { ethers } from "ethers";
import { readDB, writeDB, ReservationRecord } from "./db";
import {
  provider,
  marketplaceWithRelayer,
  claimTokenWithRelayer,
  usdcWithRelayer,
  fundRelayerIfNecessary
} from "./contracts";

let isRunning = false;
let jobInterval: NodeJS.Timeout | null = null;

// Retry ceiling definition
const RETRY_CEILING = 5;

async function waitForRelayerUSDC(neededAmount: bigint) {
  try {
    const relayerAddress = await usdcWithRelayer.runner.getAddress();
    console.log(`[Reconciliation] Waiting for relayer USDC balance to sync to at least ${neededAmount.toString()}...`);
    let synced = false;
    for (let i = 0; i < 15; i++) {
      const balance = await usdcWithRelayer.balanceOf(relayerAddress);
      if (balance >= neededAmount) {
        synced = true;
        break;
      }
      console.log(`[Reconciliation] Relayer USDC balance not yet synced, retrying in 2s...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!synced) {
      console.warn(`[Reconciliation] Warning: Relayer USDC balance not synced on RPC, continuing anyway...`);
    }
  } catch (err: any) {
    console.error(`[Reconciliation] Error checking relayer USDC balance:`, err.message || err);
  }
}

/**
 * Main reconciliation function. Scans db.json for intermediate transaction states and processes them.
 */
export async function reconcileTransactions() {
  if (isRunning) return;
  isRunning = true;

  try {
    const db = readDB();
    const reservations = Object.values(db.reservations);
    
    for (const record of reservations) {
      // Skip completed or escalated failed states
      if (
        record.status === "DELIVERED" ||
        record.status === "REFUNDED" ||
        record.status === "FAILED_ESCALATED" ||
        record.status === "REFUND_FAILED_ESCALATED"
      ) {
        continue;
      }

      try {
        await processRecord(record);
      } catch (err: any) {
        console.error(`[Reconciliation] Error processing reservation ${record.reservationId}:`, err.message || err);
      }
    }
  } catch (err: any) {
    console.error("[Reconciliation] Global error in reconciliation cycle:", err.message || err);
  } finally {
    isRunning = false;
  }
}

/**
 * Processes a single reservation record based on its state.
 */
async function processRecord(record: ReservationRecord) {
  const db = readDB();
  const currentRecord = db.reservations[record.reservationId];
  if (!currentRecord) return;

  const now = Math.floor(Date.now() / 1000);

  // 1. Handle SUBMITTED_PAYMENT state (mempool tracking)
  if (currentRecord.status === "SUBMITTED_PAYMENT") {
    if (currentRecord.paymentTxHash) {
      try {
        const receipt = await provider.getTransactionReceipt(currentRecord.paymentTxHash);
        if (receipt) {
          if (receipt.status === 1) {
            console.log(`[Reconciliation] Payment TX confirmed for reservation ${record.reservationId}`);
            currentRecord.status = "PAID";
            currentRecord.updatedAt = now;
            writeDB(db);
            // Immediately transition to next step
            await processRecord(currentRecord);
          } else {
            console.warn(`[Reconciliation] Payment TX reverted for reservation ${record.reservationId}`);
            currentRecord.status = "PENDING_SIGNATURE";
            currentRecord.lastError = "Payment transaction reverted on-chain";
            currentRecord.updatedAt = now;
            writeDB(db);
          }
          return;
        }
      } catch (err: any) {
        console.error(`[Reconciliation] Error fetching receipt for payment ${currentRecord.paymentTxHash}:`, err.message);
      }
    }

    // Timeout check: if submitted for > 5 minutes, reset to signature request
    if (now - currentRecord.updatedAt > 300) {
      console.warn(`[Reconciliation] Payment TX timed out in mempool for reservation ${record.reservationId}. Resetting to PENDING_SIGNATURE.`);
      currentRecord.status = "PENDING_SIGNATURE";
      currentRecord.lastError = "Payment transaction submission timed out";
      currentRecord.updatedAt = now;
      writeDB(db);
    }
    return;
  }

  // 2. Handle PAID state (Payment succeeded, needs fulfillment)
  if (currentRecord.status === "PAID") {
    // Check if reservation is expired on-chain
    try {
      const onchainRes = await marketplaceWithRelayer.getReservation(currentRecord.reservationId);
      const onchainStatus = Number(onchainRes.status); // 0=Active, 1=Completed, 2=Expired, 3=Cancelled
      const onchainExpiresAt = Number(onchainRes.expiresAt);

      if (onchainStatus !== 0 || now > onchainExpiresAt) {
        console.warn(`[Reconciliation] Reservation ${record.reservationId} is expired or completed on-chain. Initiating refund.`);
        await triggerRefund(currentRecord, db, `Reservation expired or inactive on-chain (status: ${onchainStatus})`);
        return;
      }
    } catch (err: any) {
      console.error(`[Reconciliation] Failed to query reservation ${record.reservationId} details:`, err.message);
      // Keep retrying unless retry ceiling hit
    }

    // Try to fulfill reservation
    try {
      console.log(`[Reconciliation] Attempting fulfillment for reservation ${record.reservationId}...`);
      const tx = await marketplaceWithRelayer.fulfillReservation(currentRecord.reservationId);
      console.log(`[Reconciliation] Fulfillment TX submitted: ${tx.hash}`);
      currentRecord.fulfillmentTxHash = tx.hash;
      
      const receipt = await tx.wait();
      if (receipt && receipt.status === 1) {
        console.log(`[Reconciliation] Fulfillment TX confirmed for reservation ${record.reservationId}`);
        currentRecord.status = "FULFILLED";
        currentRecord.updatedAt = now;
        writeDB(db);
        // Progress to delivery
        await processRecord(currentRecord);
      } else {
        throw new Error("Fulfillment transaction reverted on-chain");
      }
    } catch (err: any) {
      console.error(`[Reconciliation] Fulfillment failed for reservation ${record.reservationId}:`, err.message || err);
      currentRecord.retryCount++;
      currentRecord.lastError = err.message || "Fulfillment reverted";
      currentRecord.updatedAt = now;
      writeDB(db);

      if (currentRecord.retryCount >= RETRY_CEILING) {
        console.error(`[Reconciliation] Retry ceiling reached for reservation ${record.reservationId} fulfillment. Escalating and refunding.`);
        currentRecord.status = "FAILED_ESCALATED";
        writeDB(db);
        await triggerRefund(currentRecord, db, "Fulfillment retry ceiling exceeded");
      }
    }
    return;
  }

  // 3. Handle FULFILLED state (Fulfillment succeeded, needs claim token delivery)
  if (currentRecord.status === "FULFILLED") {
    try {
      console.log(`[Reconciliation] Attempting delivery of claim tokens for reservation ${record.reservationId}...`);
      
      // Get SKU id from listing
      const listing = await marketplaceWithRelayer.getListing(currentRecord.listingId);
      const skuId = listing.skuId;

      const relayerAddress = await marketplaceWithRelayer.runner.getAddress();
      
      console.log(`[Reconciliation] Waiting for relayer ClaimToken balance to sync...`);
      let balanceVerified = false;
      for (let i = 0; i < 15; i++) {
        const bal = await claimTokenWithRelayer.balanceOf(relayerAddress, skuId);
        if (Number(bal) >= currentRecord.quantity) {
          balanceVerified = true;
          break;
        }
        console.log(`[Reconciliation] Relayer balance not yet visible on RPC, retrying in 2s...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (!balanceVerified) {
        throw new Error("Relayer ClaimToken balance failed to sync on RPC");
      }

      // Transfer claim tokens from relayer back to final client buyer
      const tx = await claimTokenWithRelayer.safeTransferFrom(
        relayerAddress,
        currentRecord.buyer,
        skuId,
        currentRecord.quantity,
        "0x"
      );
      console.log(`[Reconciliation] Delivery TX submitted: ${tx.hash}`);
      currentRecord.deliveryTxHash = tx.hash;

      const receipt = await tx.wait();
      if (receipt && receipt.status === 1) {
        console.log(`[Reconciliation] Claim tokens delivered for reservation ${record.reservationId}`);
        currentRecord.status = "DELIVERED";
        currentRecord.updatedAt = now;
        writeDB(db);
      } else {
        throw new Error("Delivery transaction reverted on-chain");
      }
    } catch (err: any) {
      console.error(`[Reconciliation] Delivery failed for reservation ${record.reservationId}:`, err.message || err);
      currentRecord.retryCount++;
      currentRecord.lastError = err.message || "Delivery reverted";
      currentRecord.updatedAt = now;
      writeDB(db);

      if (currentRecord.retryCount >= RETRY_CEILING) {
        console.error(`[Reconciliation] Retry ceiling reached for reservation ${record.reservationId} delivery. Escalating and refunding.`);
        currentRecord.status = "FAILED_ESCALATED";
        writeDB(db);
        await triggerRefund(currentRecord, db, "Delivery retry ceiling exceeded");
      }
    }
    return;
  }

  // 4. Handle FAILED_REFUNDING state (Needs refund execution or confirmation)
  if (currentRecord.status === "FAILED_REFUNDING") {
    if (currentRecord.refundTxHash) {
      try {
        const receipt = await provider.getTransactionReceipt(currentRecord.refundTxHash);
        if (receipt) {
          if (receipt.status === 1) {
            console.log(`[Reconciliation] Refund TX confirmed for reservation ${record.reservationId}`);
            currentRecord.status = "REFUNDED";
            currentRecord.updatedAt = now;
            writeDB(db);
          } else {
            console.warn(`[Reconciliation] Refund TX reverted for reservation ${record.reservationId}. Will retry submission.`);
            currentRecord.refundTxHash = undefined;
            currentRecord.updatedAt = now;
            writeDB(db);
          }
          return;
        }
      } catch (err: any) {
        console.error(`[Reconciliation] Error fetching receipt for refund ${currentRecord.refundTxHash}:`, err.message);
      }
    }

    // Submit refund transaction if not submitted or reverted
    if (!currentRecord.refundTxHash) {
      try {
        console.log(`[Reconciliation] Executing refund for reservation ${record.reservationId}...`);
        
        // Convert totalDue back to USDC atomic units (6 decimals)
        const refundAmountAtomic = ethers.parseUnits(currentRecord.totalDue, 6);
        await waitForRelayerUSDC(refundAmountAtomic);
        
        // Call transfer(buyer, amount)
        const tx = await usdcWithRelayer.transfer(currentRecord.buyer, refundAmountAtomic);
        console.log(`[Reconciliation] Refund TX submitted: ${tx.hash}`);
        currentRecord.refundTxHash = tx.hash;
        currentRecord.updatedAt = now;
        writeDB(db);
        
        const receipt = await tx.wait();
        if (receipt && receipt.status === 1) {
          console.log(`[Reconciliation] Refund TX confirmed: ${tx.hash}`);
          currentRecord.status = "REFUNDED";
          currentRecord.updatedAt = now;
          writeDB(db);
        } else {
          throw new Error("Refund transaction reverted on-chain");
        }
      } catch (err: any) {
        console.error(`[Reconciliation] Refund submission failed for reservation ${record.reservationId}:`, err.message || err);
        currentRecord.retryCount++;
        currentRecord.lastError = `Refund failed: ${err.message || "reverted"}`;
        currentRecord.updatedAt = now;
        writeDB(db);

        if (currentRecord.retryCount >= RETRY_CEILING * 2) {
          console.error(`[Reconciliation] Refund retry ceiling reached for reservation ${record.reservationId}. Escalating as REFUND_FAILED_ESCALATED.`);
          currentRecord.status = "REFUND_FAILED_ESCALATED";
          writeDB(db);
        }
      }
    }
  }
}

/**
 * Triggers a refund by moving the record to FAILED_REFUNDING and resetting retryCount
 */
export async function triggerRefund(record: ReservationRecord, db: any, reason: string) {
  console.log(`[Reconciliation] Triggering refund for reservation ${record.reservationId}. Reason: ${reason}`);
  record.status = "FAILED_REFUNDING";
  record.lastError = reason;
  record.retryCount = 0; // reset for refund retries
  record.refundTxHash = undefined;
  record.updatedAt = Math.floor(Date.now() / 1000);
  writeDB(db);

  // Attempt inline immediate refund submission
  try {
    const refundAmountAtomic = ethers.parseUnits(record.totalDue, 6);
    await waitForRelayerUSDC(refundAmountAtomic);
    const tx = await usdcWithRelayer.transfer(record.buyer, refundAmountAtomic);
    console.log(`[Reconciliation] Immediate refund TX submitted: ${tx.hash}`);
    record.refundTxHash = tx.hash;
    writeDB(db);
  } catch (err: any) {
    console.error(`[Reconciliation] Immediate refund submission failed:`, err.message || err);
  }
}

/**
 * Starts the reconciliation background job.
 */
export function startReconciliationJob() {
  if (jobInterval) return;
  
  console.log("[Reconciliation] Starting transaction reconciliation loop (every 30 seconds)");
  
  // Run once immediately on startup
  reconcileTransactions();
  
  jobInterval = setInterval(() => {
    reconcileTransactions();
  }, 30000);
}

/**
 * Stops the reconciliation background job.
 */
export function stopReconciliationJob() {
  if (jobInterval) {
    clearInterval(jobInterval);
    jobInterval = null;
    console.log("[Reconciliation] Stopped transaction reconciliation loop");
  }
}

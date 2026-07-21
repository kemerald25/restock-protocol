import { Router, Request, Response } from "express";
import { ethers } from "ethers";
import * as crypto from "crypto";
import { readDB, writeDB } from "../lib/db";
import { requireScope } from "../middleware/auth";
import { BindingChallenge, MerchantWallet } from "../types";

const router = Router();

export const EIP712_PLATFORM_DOMAIN = {
  name: "RestockProtocolPlatform",
  version: "1",
  chainId: 84532, // Base Sepolia
  verifyingContract: "0x0000000000000000000000000000000000000000"
};

export const BIND_WALLET_TYPES = {
  BindWallet: [
    { name: "merchantId", type: "string" },
    { name: "walletAddress", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
};

/**
 * POST /merchant/wallets/challenge
 * Requires merchant:write or merchant:keys:write scope.
 * Body: { "merchantId": "mer_...", "walletAddress": "0x..." }
 */
router.post("/merchant/wallets/challenge", requireScope("merchant:write"), (req: Request, res: Response) => {
  const { merchantId, walletAddress } = req.body;

  if (!merchantId || !walletAddress || !ethers.isAddress(walletAddress)) {
    return res.status(400).json({ error: "Missing or invalid merchantId or walletAddress" });
  }

  const db = readDB();
  const merchant = db.merchants[merchantId];
  if (!merchant) {
    return res.status(404).json({ error: "Merchant account not found" });
  }

  // Generate random uint256 nonce
  const nonce = ethers.toBigInt(crypto.randomBytes(32)).toString();
  const now = Math.floor(Date.now() / 1000);
  const deadline = now + 300; // 5-minute validity window

  const challenge: BindingChallenge = {
    merchantId,
    walletAddress: ethers.getAddress(walletAddress),
    nonce,
    deadline,
    consumed: false,
    createdAt: now
  };

  db.bindingChallenges[nonce] = challenge;
  writeDB(db);

  res.json({
    merchantId,
    walletAddress: challenge.walletAddress,
    nonce: challenge.nonce,
    deadline: challenge.deadline,
    domain: EIP712_PLATFORM_DOMAIN,
    types: BIND_WALLET_TYPES
  });
});

/**
 * POST /merchant/wallets/verify
 * Body: { "merchantId": "mer_...", "walletAddress": "0x...", "nonce": "...", "signature": "0x..." }
 */
router.post("/merchant/wallets/verify", requireScope("merchant:write"), (req: Request, res: Response) => {
  const { merchantId, walletAddress, nonce, signature } = req.body;

  if (!merchantId || !walletAddress || !nonce || !signature) {
    return res.status(400).json({ error: "Missing required fields (merchantId, walletAddress, nonce, signature)" });
  }

  const db = readDB();
  const challenge = db.bindingChallenges[nonce];

  if (!challenge) {
    return res.status(400).json({ error: "Challenge not found or invalid nonce" });
  }

  if (challenge.consumed) {
    return res.status(400).json({ error: "Replay attempt rejected: challenge nonce has already been consumed" });
  }

  const now = Math.floor(Date.now() / 1000);
  if (challenge.deadline < now) {
    return res.status(400).json({ error: "Challenge expired: signature deadline exceeded" });
  }

  if (
    challenge.merchantId !== merchantId ||
    challenge.walletAddress.toLowerCase() !== walletAddress.toLowerCase()
  ) {
    return res.status(400).json({ error: "Challenge parameter mismatch" });
  }

  try {
    const recoveredAddress = ethers.verifyTypedData(
      EIP712_PLATFORM_DOMAIN,
      BIND_WALLET_TYPES,
      {
        merchantId: challenge.merchantId,
        walletAddress: ethers.getAddress(challenge.walletAddress),
        nonce: BigInt(challenge.nonce),
        deadline: BigInt(challenge.deadline)
      },
      signature
    );

    if (ethers.getAddress(recoveredAddress) !== ethers.getAddress(walletAddress)) {
      return res.status(400).json({ error: "Signature verification failed: recovered address mismatch" });
    }

    // Mark challenge consumed
    challenge.consumed = true;

    const merchant = db.merchants[merchantId];
    if (!merchant) {
      return res.status(404).json({ error: "Merchant account not found" });
    }

    const canonicalWallet = ethers.getAddress(walletAddress);
    const existingWallet = merchant.wallets.find((w) => w.address.toLowerCase() === canonicalWallet.toLowerCase());

    if (!existingWallet) {
      const newWalletRecord: MerchantWallet = {
        address: canonicalWallet,
        role: "LISTING_SIGNER",
        addedAt: now,
        signatureProof: signature
      };
      merchant.wallets.push(newWalletRecord);
      merchant.updatedAt = now;
    }

    writeDB(db);

    return res.json({
      status: "SUCCESS",
      merchantId,
      boundWallet: canonicalWallet,
      walletCount: merchant.wallets.length
    });
  } catch (err: any) {
    console.error("[Wallet Verification Error]:", err);
    return res.status(400).json({ error: "EIP-712 signature verification error", details: err.message });
  }
});

export default router;

import { Router, Request, Response } from "express";
import { ethers } from "ethers";
import * as crypto from "crypto";
import { readDB, writeDB } from "../lib/db";
import { requireScope } from "../middleware/auth";
import { generateApiKey, hashApiKey } from "../lib/auth";
import { skuRegistry, skuRegistryWithSigner, marketplaceWithRelayer, marketplaceWithMerchant, merchantSigner, claimToken, ClaimTokenABI, addresses } from "../lib/contracts";
import { PendingSkuRequest, ApiKeyScope } from "../types";
import { BIND_WALLET_TYPES, EIP712_PLATFORM_DOMAIN } from "./merchantWallets";

const router = Router();

/**
 * Helper to calculate active (unpaused) SKU count for a merchant against their trust tier.
 * Only SKUs with onchain status == 0 (Active) count against maxActiveSKUs.
 * Pausing a SKU frees up a slot.
 */
export async function getActiveSKUsCount(merchantId: string): Promise<number> {
  const db = readDB();
  const ownedSkuIds = db.merchantSkus[merchantId] || [];
  if (ownedSkuIds.length === 0) return 0;

  let activeCount = 0;
  for (const idStr of ownedSkuIds) {
    try {
      const skuPromise = skuRegistry.getSKU(BigInt(idStr));
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("RPC Timeout")), 1500));
      const sku: any = await Promise.race([skuPromise, timeoutPromise]);
      // status 0 = Active, 1 = Paused
      if (sku && Number(sku.status) === 0) {
        activeCount++;
      }
    } catch (err) {
      // Fallback: if RPC error, timeout, or local test setup, count owned SKUs
      activeCount++;
    }
  }

  return activeCount;
}

/**
 * POST /merchant/skus
 * Requires merchant:write scope.
 * Body: { "maxSupply": 100, "royaltyBps": 500, "initialBasisValue": "150.00", "metadataURI": "https://..." }
 */
router.post("/merchant/skus", requireScope("merchant:write"), async (req: Request, res: Response) => {
  const { maxSupply, royaltyBps, initialBasisValue, metadataURI, name, category, variant } = req.body;

  if (!maxSupply || royaltyBps === undefined || !initialBasisValue || !metadataURI) {
    return res.status(400).json({ error: "Missing required fields (maxSupply, royaltyBps, initialBasisValue, metadataURI)" });
  }

  const db = readDB();
  const merchant = req.merchant || (req.apiKey?.ownerId ? db.merchants[req.apiKey.ownerId] : null);

  if (!merchant) {
    return res.status(404).json({ error: "Merchant account not found for authenticated key owner" });
  }

  // 1. Enforce Trust Tier Royalty BPS limit before chain call
  if (Number(royaltyBps) > merchant.trustTier.maxRoyaltyBps) {
    return res.status(422).json({
      error: {
        code: "TRUST_TIER_ROYALTY_EXCEEDED",
        message: `Requested royalty BPS (${royaltyBps}) exceeds maximum limit (${merchant.trustTier.maxRoyaltyBps} BPS) for trust tier ${merchant.trustTier.tierLevel}.`
      }
    });
  }

  // 2. Enforce Trust Tier Active SKU Limit
  const activeSKUsCount = await getActiveSKUsCount(merchant.id);
  if (activeSKUsCount >= merchant.trustTier.maxActiveSKUs) {
    return res.status(422).json({
      error: {
        code: "TRUST_TIER_SKU_LIMIT_EXCEEDED",
        message: `Active SKU count (${activeSKUsCount}) has reached maximum limit (${merchant.trustTier.maxActiveSKUs}) for trust tier ${merchant.trustTier.tierLevel}.`
      }
    });
  }

  // 3. Deferred Approval for Tier 0 (requiresManualSKUApproval === true)
  if (merchant.trustTier.requiresManualSKUApproval) {
    const reqId = `sku_req_${crypto.randomBytes(8).toString("hex")}`;
    const requestRecord: PendingSkuRequest = {
      id: reqId,
      merchantId: merchant.id,
      maxSupply: Number(maxSupply),
      royaltyBps: Number(royaltyBps),
      initialBasisValue: String(initialBasisValue),
      metadataURI: String(metadataURI),
      status: "PENDING",
      submittedAt: Math.floor(Date.now() / 1000)
    };

    db.pendingSkuRequests[reqId] = requestRecord;
    writeDB(db);

    return res.status(202).json({
      status: "PENDING_APPROVAL",
      message: "SKU creation request queued for Tier 0 manual admin approval.",
      requestId: reqId,
      request: requestRecord
    });
  }

  // 4. Immediate Onchain SKU Creation for Tier 1 & Tier 2
  if (!merchantSigner || !skuRegistryWithSigner) {
    return res.status(500).json({ error: "Server relayer / merchant signer not configured for onchain submission" });
  }

  try {
    const basisValueRaw = parseEtherOrUnits(initialBasisValue, 6);
    const tx = await skuRegistryWithSigner.createSKU(
      BigInt(maxSupply),
      BigInt(royaltyBps),
      basisValueRaw,
      metadataURI
    );

    const receipt = await tx.wait();
    
    // Parse SKUCreated event
    let newSkuId = "1";
    if (receipt?.logs) {
      for (const log of receipt.logs) {
        try {
          const parsed = skuRegistry.interface.parseLog(log);
          if (parsed && parsed.name === "SKUCreated") {
            newSkuId = parsed.args.skuId.toString();
            break;
          }
        } catch (e) {}
      }
    }

    // Index SKU ownership under merchant
    if (!db.merchantSkus[merchant.id]) db.merchantSkus[merchant.id] = [];
    if (!db.merchantSkus[merchant.id].includes(newSkuId)) {
      db.merchantSkus[merchant.id].push(newSkuId);
    }
    
    // Save SKU metadata in db
    if (!db.skuMetadata) db.skuMetadata = {};
    db.skuMetadata[newSkuId] = {
      name: name || `SKU #${newSkuId}`,
      category: category || "uncategorized",
      variant: variant || "Default"
    };

    writeDB(db);

    return res.status(201).json({
      status: "CREATED",
      skuId: newSkuId,
      txHash: tx.hash,
      merchantId: merchant.id
    });
  } catch (err: any) {
    console.error("[Merchant SKU Creation Error]:", err);
    return res.status(500).json({ error: "Failed to create SKU onchain", details: err.message });
  }
});

/**
 * POST /merchant/listings
 * Requires merchant:write scope.
 * Body: { "skuId": "1", "quantity": 10, "pricePerUnit": "25.00" }
 */
router.post("/merchant/listings", requireScope("merchant:write"), async (req: Request, res: Response) => {
  const { skuId, quantity, pricePerUnit } = req.body;

  if (!skuId || !quantity || !pricePerUnit) {
    return res.status(400).json({ error: "Missing required fields (skuId, quantity, pricePerUnit)" });
  }

  const db = readDB();
  const merchant = req.merchant || (req.apiKey?.ownerId ? db.merchants[req.apiKey.ownerId] : null);

  if (!merchant) {
    return res.status(404).json({ error: "Merchant account not found for authenticated key owner" });
  }

  // Ownership Check: verify merchant owns the SKU
  const ownedSkus = db.merchantSkus[merchant.id] || [];
  let isOwner = ownedSkus.includes(String(skuId));

  if (!isOwner) {
    // Check onchain merchant address against bound merchant wallets
    try {
      const sku = await skuRegistry.getSKU(BigInt(skuId));
      const boundAddresses = merchant.wallets.map((w) => w.address.toLowerCase());
      if (sku && boundAddresses.includes(sku.merchant.toLowerCase())) {
        isOwner = true;
      }
    } catch (e) {}
  }

  if (!isOwner) {
    return res.status(403).json({
      error: {
        code: "UNAUTHORIZED_SKU_OWNER",
        message: `Merchant ${merchant.id} does not own SKU ${skuId}.`
      }
    });
  }

  if (!merchantSigner || !marketplaceWithRelayer) {
    return res.status(500).json({ error: "Server relayer / merchant signer not configured for onchain submission" });
  }

  try {
    const priceRaw = parseEtherOrUnits(pricePerUnit, 6);
    const primaryWallet = merchant.wallets[0]?.address || merchantSigner.address;

    // Check balance and auto-mint if necessary
    const claimTokenWithMerchant = new ethers.Contract(
      addresses.ClaimToken,
      ClaimTokenABI,
      merchantSigner
    ) as any;

    const balance = await claimToken.balanceOf(merchantSigner.address, BigInt(skuId));
    if (balance < BigInt(quantity)) {
      const mintAmount = BigInt(quantity) - balance;
      console.log(`[Auto-Mint] Merchant has ${balance.toString()} units. Minting additional ${mintAmount.toString()} units...`);
      const mintTx = await claimTokenWithMerchant.mint(
        BigInt(skuId),
        merchantSigner.address,
        mintAmount
      );
      await mintTx.wait();
      console.log(`[Auto-Mint] Successfully minted ${mintAmount.toString()} units`);
    }

    const tx = await marketplaceWithMerchant.createListing(
      BigInt(skuId),
      BigInt(quantity),
      priceRaw
    );

    const receipt = await tx.wait();

    let listingId = "1";
    if (receipt?.logs) {
      for (const log of receipt.logs) {
        try {
          const parsed = marketplaceWithRelayer.interface.parseLog(log);
          if (parsed && parsed.name === "Listed") {
            listingId = parsed.args.listingId.toString();
            break;
          }
        } catch (e) {}
      }
    }

    return res.status(201).json({
      status: "CREATED",
      listingId,
      skuId: String(skuId),
      txHash: tx.hash
    });
  } catch (err: any) {
    console.error("[Merchant Listing Creation Error]:", err);
    return res.status(500).json({ error: "Failed to create listing onchain", details: err.message });
  }
});

/**
 * GET /merchant/orders
 * Requires merchant:read scope.
 */
router.get("/merchant/orders", requireScope("merchant:read"), async (req: Request, res: Response) => {
  const db = readDB();
  const merchant = req.merchant || (req.apiKey?.ownerId ? db.merchants[req.apiKey.ownerId] : null);

  if (!merchant) {
    return res.status(404).json({ error: "Merchant account not found for authenticated key owner" });
  }

  const ownedSkuSet = new Set(db.merchantSkus[merchant.id] || []);

  // Filter reservations / orders matching merchant's SKUs
  const allReservations = Object.values(db.reservations);
  const merchantOrders = allReservations.filter((r) => ownedSkuSet.has(String(r.listingId)));

  // Filter redemptions matching merchant's SKUs
  const allRedemptions = Object.values(db.redemptions);
  const merchantRedemptions = allRedemptions.filter((r) => ownedSkuSet.has(String(r.skuId)));

  res.json({
    merchantId: merchant.id,
    orders: merchantOrders,
    redemptions: merchantRedemptions
  });
});

/**
 * GET /merchant/skus
 * Requires merchant:read scope.
 * Returns the list of SKU IDs owned by the authenticated merchant.
 */
router.get("/merchant/skus", requireScope("merchant:read"), async (req: Request, res: Response) => {
  const db = readDB();
  const merchant = req.merchant || (req.apiKey?.ownerId ? db.merchants[req.apiKey.ownerId] : null);

  if (!merchant) {
    return res.status(404).json({ error: "Merchant account not found for authenticated key owner" });
  }

  const ownedSkuIds = db.merchantSkus[merchant.id] || [];
  res.json({ skuIds: ownedSkuIds });
});


/**
 * GET /merchant/keys
 * Requires merchant:read scope.
 * Returns active and revoked key metadata records for the requesting merchant (masked keys only).
 */
router.get("/merchant/keys", requireScope("merchant:read"), (req: Request, res: Response) => {
  const db = readDB();
  const merchantId = req.apiKey?.ownerId;

  if (!merchantId) {
    return res.status(400).json({ error: "Missing merchant owner identifier" });
  }

  const merchantKeys = Object.values(db.apiKeys)
    .filter((k) => k.ownerId === merchantId && k.ownerType === "MERCHANT")
    .map((k) => ({
      id: k.id,
      maskedKey: k.maskedKey,
      name: k.name,
      scopes: k.scopes,
      status: k.status,
      rateLimitTier: k.rateLimitTier,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt
    }));

  res.json({ keys: merchantKeys });
});

/**
 * Helper to check session signature or merchant:keys:write scope for key issuance/revocation
 */
async function authorizeKeyManagement(req: Request, db: ReturnType<typeof readDB>): Promise<{ authorized: boolean; error?: string }> {
  // Path 1: API Key has explicit merchant:keys:write scope
  if (req.apiKey && req.apiKey.scopes.includes("merchant:keys:write")) {
    return { authorized: true };
  }

  // Path 2: EIP-712 session signature from bound merchant wallet
  const { walletSession } = req.body;
  if (walletSession && walletSession.nonce && walletSession.signature && walletSession.walletAddress) {
    const challenge = db.bindingChallenges[walletSession.nonce];
    if (!challenge || challenge.consumed || challenge.deadline < Math.floor(Date.now() / 1000)) {
      return { authorized: false, error: "Invalid, expired, or consumed EIP-712 wallet session nonce" };
    }

    try {
      const recovered = (require("ethers") as typeof import("ethers")).verifyTypedData(
        EIP712_PLATFORM_DOMAIN,
        BIND_WALLET_TYPES,
        {
          merchantId: challenge.merchantId,
          walletAddress: (require("ethers") as typeof import("ethers")).getAddress(challenge.walletAddress),
          nonce: BigInt(challenge.nonce),
          deadline: BigInt(challenge.deadline)
        },
        walletSession.signature
      );

      if (recovered.toLowerCase() === walletSession.walletAddress.toLowerCase()) {
        challenge.consumed = true;
        writeDB(db);
        return { authorized: true };
      }
    } catch (e) {}
  }

  return {
    authorized: false,
    error: "Privileged scope 'merchant:keys:write' or valid bound EIP-712 wallet session signature required."
  };
}

/**
 * POST /merchant/keys
 * Requires merchant:keys:write scope OR EIP-712 wallet session signature.
 * Newly issued keys default to operational scopes: ["merchant:read", "merchant:write", "public:read"] (NO merchant:keys:write).
 */
router.post("/merchant/keys", requireScope("merchant:read"), async (req: Request, res: Response) => {
  const db = readDB();
  const auth = await authorizeKeyManagement(req, db);

  if (!auth.authorized) {
    return res.status(403).json({ error: { code: "FORBIDDEN", message: auth.error } });
  }

  const { name, requestedScopes, rateLimitTier } = req.body;
  const merchantId = req.apiKey?.ownerId;

  if (!merchantId) {
    return res.status(400).json({ error: "Missing merchant owner identifier" });
  }

  // Enforce default-separation rule: Default scopes do NOT include merchant:keys:write
  let finalScopes: ApiKeyScope[] = ["merchant:read", "merchant:write", "public:read"];
  if (Array.isArray(requestedScopes)) {
    // Only allow merchant:keys:write if creator already has merchant:keys:write or wallet session
    finalScopes = requestedScopes.filter(
      (s) => s !== "merchant:keys:write" || (req.apiKey?.scopes.includes("merchant:keys:write") || auth.authorized)
    );
  }

  const { secret, record } = generateApiKey({
    ownerType: "MERCHANT",
    ownerId: merchantId,
    name: name || "Merchant Operational Key",
    scopes: finalScopes,
    rateLimitTier: rateLimitTier || "DEFAULT"
  });

  return res.status(201).json({
    status: "CREATED",
    apiKey: secret, // Returned ONCE in response payload
    record: {
      id: record.id,
      maskedKey: record.maskedKey,
      name: record.name,
      scopes: record.scopes,
      status: record.status,
      rateLimitTier: record.rateLimitTier,
      createdAt: record.createdAt
    }
  });
});

/**
 * DELETE /merchant/keys/:id
 * Requires merchant:keys:write scope OR EIP-712 wallet session signature.
 * Marks key status as REVOKED.
 */
router.delete("/merchant/keys/:id", requireScope("merchant:read"), async (req: Request, res: Response) => {
  const { id } = req.params;
  const db = readDB();

  const auth = await authorizeKeyManagement(req, db);
  if (!auth.authorized) {
    return res.status(403).json({ error: { code: "FORBIDDEN", message: auth.error } });
  }

  // Locate key record by id
  const entry = Object.entries(db.apiKeys).find(([_, k]) => k.id === id);
  if (!entry) {
    return res.status(404).json({ error: "API key record not found" });
  }

  const [hash, keyRec] = entry;
  if (keyRec.ownerId !== req.apiKey?.ownerId) {
    return res.status(403).json({ error: "Cannot revoke API key belonging to another merchant" });
  }

  db.apiKeys[hash].status = "REVOKED";
  writeDB(db);

  return res.json({
    status: "REVOKED",
    keyId: id,
    maskedKey: keyRec.maskedKey
  });
});

function parseEtherOrUnits(val: string, decimals: number): bigint {
  const floatVal = parseFloat(val);
  const raw = Math.round(floatVal * Math.pow(10, decimals));
  return BigInt(raw);
}

export default router;

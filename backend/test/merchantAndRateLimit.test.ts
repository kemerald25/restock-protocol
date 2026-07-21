import { expect } from "chai";
import request from "supertest";
import app from "../src/app";
import { generateApiKey } from "../src/lib/auth";
import { readDB, writeDB } from "../src/lib/db";
import { resetRateLimits } from "../src/middleware/rateLimit";
import { MerchantAccount, ApiKeyRecord } from "../src/types";

describe("Phase 5 Part 2: Merchant Routes, Trust-Tier Enforcement & Rate Limiting", () => {
  let tier0MerchantKey: string;
  let tier0MerchantId: string;
  let tier1MerchantKey: string;
  let tier1MerchantId: string;
  let keysWriteMerchantKey: string;
  let adminKey: string;

  before(() => {
    resetRateLimits();
    const db = readDB();

    // 1. Create Tier 0 Sandbox Merchant (Max Royalty 1000 BPS, Max 1 Active SKU, Requires Approval)
    tier0MerchantId = "mer_tier0_test_01";
    const tier0Merchant: MerchantAccount = {
      id: tier0MerchantId,
      legalName: "Tier 0 Sandbox Merchant",
      contactEmail: "tier0@example.com",
      verificationStatus: "VERIFIED",
      wallets: [{
        address: "0x345924F66825794e424f9B402756d7015a8dC12E",
        role: "LISTING_SIGNER",
        addedAt: Math.floor(Date.now() / 1000),
        signatureProof: "0x"
      }],
      trustTier: {
        tierLevel: "TIER_0_SANDBOX",
        maxRoyaltyBps: 1000,
        maxActiveSKUs: 1,
        requiresManualSKUApproval: true
      },
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000)
    };
    db.merchants[tier0MerchantId] = tier0Merchant;

    // 2. Create Tier 1 Standard Merchant (Max Royalty 2500 BPS, Max 10 Active SKUs, Direct Approval)
    tier1MerchantId = "mer_tier1_test_01";
    const tier1Merchant: MerchantAccount = {
      id: tier1MerchantId,
      legalName: "Tier 1 Standard Merchant",
      contactEmail: "tier1@example.com",
      verificationStatus: "VERIFIED",
      wallets: [{
        address: "0x345924F66825794e424f9B402756d7015a8dC12E",
        role: "LISTING_SIGNER",
        addedAt: Math.floor(Date.now() / 1000),
        signatureProof: "0x"
      }],
      trustTier: {
        tierLevel: "TIER_1_STANDARD",
        maxRoyaltyBps: 2500,
        maxActiveSKUs: 10,
        requiresManualSKUApproval: false
      },
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000)
    };
    db.merchants[tier1MerchantId] = tier1Merchant;

    writeDB(db);

    // Issue Tier 0 Merchant Key (merchant:write, merchant:read)
    const t0KeyRes = generateApiKey({
      ownerType: "MERCHANT",
      ownerId: tier0MerchantId,
      name: "Tier 0 Operational Key",
      scopes: ["merchant:read", "merchant:write", "public:read"],
      rateLimitTier: "DEFAULT"
    });
    tier0MerchantKey = t0KeyRes.secret;

    // Issue Tier 1 Merchant Key
    const t1KeyRes = generateApiKey({
      ownerType: "MERCHANT",
      ownerId: tier1MerchantId,
      name: "Tier 1 Operational Key",
      scopes: ["merchant:read", "merchant:write", "public:read"],
      rateLimitTier: "ELEVATED"
    });
    tier1MerchantKey = t1KeyRes.secret;

    // Issue Privileged Merchant Key with merchant:keys:write
    const kwKeyRes = generateApiKey({
      ownerType: "MERCHANT",
      ownerId: tier1MerchantId,
      name: "Tier 1 Key Management Key",
      scopes: ["merchant:read", "merchant:write", "merchant:keys:write", "public:read"],
      rateLimitTier: "ELEVATED"
    });
    keysWriteMerchantKey = kwKeyRes.secret;

    // Issue Admin Key
    const adminKeyRes = generateApiKey({
      ownerType: "ADMIN",
      ownerId: "admin_genesis",
      name: "Test Admin Key",
      scopes: ["admin:read", "admin:write", "public:read"],
      rateLimitTier: "UNLIMITED"
    });
    adminKey = adminKeyRes.secret;
  });

  describe("1. Trust-Tier Enforcement (POST /merchant/skus)", () => {
    it("should REJECT SKU creation with 422 when royaltyBps exceeds trust tier maxRoyaltyBps", async () => {
      const res = await request(app)
        .post("/merchant/skus")
        .set("Authorization", `Bearer ${tier0MerchantKey}`)
        .send({
          maxSupply: 100,
          royaltyBps: 1500, // Exceeds Tier 0 limit of 1000
          initialBasisValue: "100.00",
          metadataURI: "https://example.com/sku-royalty-exceeded"
        });

      expect(res.status).to.equal(422);
      expect(res.body.error.code).to.equal("TRUST_TIER_ROYALTY_EXCEEDED");
      expect(res.body.error.message).to.include("exceeds maximum limit (1000 BPS)");
    });

    it("should REJECT SKU creation with 422 when activeSKUs count reaches maxActiveSKUs cap", async function () {
      this.timeout(10000);
      const db = readDB();
      // Simulate Tier 0 already having 1 active SKU in db.merchantSkus
      db.merchantSkus[tier0MerchantId] = ["1"];
      writeDB(db);

      const res = await request(app)
        .post("/merchant/skus")
        .set("Authorization", `Bearer ${tier0MerchantKey}`)
        .send({
          maxSupply: 100,
          royaltyBps: 500,
          initialBasisValue: "100.00",
          metadataURI: "https://example.com/sku-cap-exceeded"
        });

      expect(res.status).to.equal(422);
      expect(res.body.error.code).to.equal("TRUST_TIER_SKU_LIMIT_EXCEEDED");
      expect(res.body.error.message).to.include("Active SKU count");
    });
  });

  describe("2. Tier 0 Deferred Manual Approval Queue", () => {
    let pendingRequestId: string;

    it("should queue Tier 0 SKU creation request with 202 PENDING_APPROVAL", async () => {
      const db = readDB();
      db.merchantSkus[tier0MerchantId] = []; // Reset active SKUs
      writeDB(db);

      const res = await request(app)
        .post("/merchant/skus")
        .set("Authorization", `Bearer ${tier0MerchantKey}`)
        .send({
          maxSupply: 50,
          royaltyBps: 500,
          initialBasisValue: "150.00",
          metadataURI: "https://example.com/tier0-pending-sku"
        });

      expect(res.status).to.equal(202);
      expect(res.body.status).to.equal("PENDING_APPROVAL");
      expect(res.body.requestId).to.be.a("string");
      pendingRequestId = res.body.requestId;

      // Verify stored in DB as PENDING
      const updatedDb = readDB();
      expect(updatedDb.pendingSkuRequests[pendingRequestId].status).to.equal("PENDING");
    });

    it("should list pending SKU requests for Admin via GET /admin/sku-requests", async () => {
      const res = await request(app)
        .get("/admin/sku-requests?status=PENDING")
        .set("Authorization", `Bearer ${adminKey}`);

      expect(res.status).to.equal(200);
      expect(res.body.requests).to.be.an("array");
      const found = res.body.requests.find((r: any) => r.id === pendingRequestId);
      expect(found).to.not.be.undefined;
    });

    it("should reject approval attempt from non-admin with 403 FORBIDDEN", async () => {
      const res = await request(app)
        .post(`/admin/sku-requests/${pendingRequestId}/approve`)
        .set("Authorization", `Bearer ${tier0MerchantKey}`);

      expect(res.status).to.equal(403);
    });
  });

  describe("3. Merchant API Key Management & Scope Isolation (/merchant/keys)", () => {
    it("should list merchant keys via GET /merchant/keys (masked keys only)", async () => {
      const res = await request(app)
        .get("/merchant/keys")
        .set("Authorization", `Bearer ${tier1MerchantKey}`);

      expect(res.status).to.equal(200);
      expect(res.body.keys).to.be.an("array");
      expect(res.body.keys.length).to.be.at.least(1);
      expect(res.body.keys[0]).to.have.property("maskedKey");
      expect(res.body.keys[0]).to.not.have.property("hashedSecret");
      expect(res.body.keys[0]).to.not.have.property("secret");
    });

    it("should REJECT key issuance from key lacking merchant:keys:write scope with 403 FORBIDDEN", async () => {
      const res = await request(app)
        .post("/merchant/keys")
        .set("Authorization", `Bearer ${tier1MerchantKey}`)
        .send({
          name: "Unauthorized Key Attempt"
        });

      expect(res.status).to.equal(403);
      expect(res.body.error.code).to.equal("FORBIDDEN");
    });

    it("should ALLOW key issuance from key possessing merchant:keys:write scope and enforce default scope separation", async () => {
      const res = await request(app)
        .post("/merchant/keys")
        .set("Authorization", `Bearer ${keysWriteMerchantKey}`)
        .send({
          name: "Secondary Operational Key",
          requestedScopes: ["merchant:read", "merchant:write", "merchant:keys:write"]
        });

      expect(res.status).to.equal(201);
      expect(res.body.apiKey).to.be.a("string");
      expect(res.body.apiKey).to.match(/^rk_live_/);
      expect(res.body.record.scopes).to.include("merchant:read");
      expect(res.body.record.scopes).to.include("merchant:write");
    });

    it("should revoke an API key via DELETE /merchant/keys/:id", async () => {
      // Create key to revoke
      const db = readDB();
      const createRes = await request(app)
        .post("/merchant/keys")
        .set("Authorization", `Bearer ${keysWriteMerchantKey}`)
        .send({ name: "Temporary Key for Revocation" });

      const createdId = createRes.body.record.id;

      const delRes = await request(app)
        .delete(`/merchant/keys/${createdId}`)
        .set("Authorization", `Bearer ${keysWriteMerchantKey}`);

      expect(delRes.status).to.equal(200);
      expect(delRes.body.status).to.equal("REVOKED");

      const checkRes = await request(app)
        .get("/merchant/keys")
        .set("Authorization", `Bearer ${keysWriteMerchantKey}`);

      const revokedRecord = checkRes.body.keys.find((k: any) => k.id === createdId);
      expect(revokedRecord.status).to.equal("REVOKED");
    });
  });

  describe("4. Rate Limiting & Relayer Defense", () => {
    beforeEach(() => {
      resetRateLimits();
    });

    it("should trigger 429 Too Many Requests with Retry-After header when exceeding general limit", async function () {
      this.timeout(10000);
      // Send 120 parallel requests to rapidly exhaust general limit (100 req/min)
      const reqs = Array.from({ length: 120 }, () =>
        request(app)
          .get("/merchant/keys")
          .set("Authorization", `Bearer ${tier0MerchantKey}`)
      );
      await Promise.all(reqs);

      const res = await request(app)
        .get("/merchant/keys")
        .set("Authorization", `Bearer ${tier0MerchantKey}`);

      expect(res.status).to.equal(429);
      expect(res.header).to.have.property("retry-after");
      expect(res.body.error.code).to.equal("RATE_LIMIT_EXCEEDED");
    });

    it("should trigger strict 10 req/min cap on POST /listings/:id/reserve even for high-tier keys", async function () {
      this.timeout(10000);
      // Tier 1 merchant key has ELEVATED tier (300 req/min), but /reserve route has strict 10 cap
      for (let i = 0; i < 10; i++) {
        await request(app)
          .post("/listings/1/reserve")
          .set("Authorization", `Bearer ${tier1MerchantKey}`)
          .send({ quantity: 1 });
      }

      const res = await request(app)
        .post("/listings/1/reserve")
        .set("Authorization", `Bearer ${tier1MerchantKey}`)
        .send({ quantity: 1 });

      expect(res.status).to.equal(429);
      expect(res.body.error.code).to.equal("RATE_LIMIT_EXCEEDED");
      expect(res.body.error.message).to.include("Rate limit exceeded");
    });
  });

  describe("5. Global Audit Logging", () => {
    it("should record authenticated requests in audit log and allow querying via GET /admin/audit-logs", async () => {
      // Execute an authenticated request
      await request(app)
        .get("/merchant/orders")
        .set("Authorization", `Bearer ${tier1MerchantKey}`);

      // Query audit logs as Admin
      const res = await request(app)
        .get("/admin/audit-logs?route=/merchant/orders")
        .set("Authorization", `Bearer ${adminKey}`);

      expect(res.status).to.equal(200);
      expect(res.body.logs).to.be.an("array");
      expect(res.body.logs.length).to.be.at.least(1);
      expect(res.body.logs[0].route).to.include("/merchant/orders");
      expect(res.body.logs[0].ownerId).to.equal(tier1MerchantId);
    });
  });
});

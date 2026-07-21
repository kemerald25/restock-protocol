import { expect } from "chai";
import request from "supertest";
import { ethers } from "ethers";
import app from "../src/app";
import { generateApiKey, hashApiKey, lookupApiKey } from "../src/lib/auth";
import { readDB, writeDB } from "../src/lib/db";
import { seedGenesis } from "../src/scripts/seedGenesis";
import { BIND_WALLET_TYPES, EIP712_PLATFORM_DOMAIN } from "../src/routes/merchantWallets";

describe("Phase 5 Part 1: Platform Identity & Auth Suite", () => {
  let genesisConfig: ReturnType<typeof seedGenesis>;

  before(() => {
    genesisConfig = seedGenesis();
  });

  describe("API Key Hashing & Resolution", () => {
    it("should issue a key, persist only its SHA-256 hash, and resolve correctly", () => {
      const { secret, record } = generateApiKey({
        ownerType: "MERCHANT",
        ownerId: "mer_test_key_owner",
        name: "Test API Key",
        scopes: ["merchant:read", "merchant:write"],
        prefix: "rk_test"
      });

      expect(secret).to.match(/^rk_test_[a-f0-9]{64}$/);
      expect(record.hashedSecret).to.equal(hashApiKey(secret));
      expect(record.maskedKey).to.include("rk_test_");

      // Verify DB stores record by hash, NOT plaintext secret
      const db = readDB();
      expect(db.apiKeys[record.hashedSecret]).to.exist;
      expect(JSON.stringify(db.apiKeys)).to.not.include(secret);

      // Verify resolution by secret
      const resolved = lookupApiKey(secret);
      expect(resolved).to.exist;
      expect(resolved?.id).to.equal(record.id);

      // Verify wrong secret fails lookup
      expect(lookupApiKey("rk_test_invalidsecret123")).to.be.null;
    });

    it("should reject revoked and expired keys", () => {
      const { secret, record } = generateApiKey({
        ownerType: "MERCHANT",
        ownerId: "mer_test_key_owner",
        name: "Revoked/Expired Test Key",
        scopes: ["merchant:read"],
        expiresAt: Math.floor(Date.now() / 1000) - 100 // Expired 100s ago
      });

      // Expired key should fail lookup
      expect(lookupApiKey(secret)).to.be.null;

      // Create active key then revoke it
      const activeKey = generateApiKey({
        ownerType: "MERCHANT",
        ownerId: "mer_test_key_owner",
        name: "Active Key to Revoke",
        scopes: ["merchant:read"]
      });

      expect(lookupApiKey(activeKey.secret)).to.exist;

      // Revoke in DB
      const db = readDB();
      db.apiKeys[activeKey.record.hashedSecret].status = "REVOKED";
      writeDB(db);

      expect(lookupApiKey(activeKey.secret)).to.be.null;
    });
  });

  describe("Authentication & Scope Middleware Enforcements", () => {
    it("GET /admin/redemptions - should return 401 UNAUTHORIZED when no key is provided", async () => {
      const res = await request(app).get("/admin/redemptions");
      expect(res.status).to.equal(401);
      expect(res.body.error).to.deep.equal({
        code: "UNAUTHORIZED",
        message: "Missing or invalid API key in Authorization header."
      });
    });

    it("GET /admin/redemptions - should return 401 UNAUTHORIZED for invalid bearer token", async () => {
      const res = await request(app)
        .get("/admin/redemptions")
        .set("Authorization", "Bearer rk_live_invalidtoken12345");
      expect(res.status).to.equal(401);
      expect(res.body.error.code).to.equal("UNAUTHORIZED");
    });

    it("GET /admin/redemptions - should return 403 FORBIDDEN when key lacks admin:read scope", async () => {
      const res = await request(app)
        .get("/admin/redemptions")
        .set("Authorization", `Bearer ${genesisConfig.buyerAgentKey}`);
      expect(res.status).to.equal(403);
      expect(res.body.error).to.deep.equal({
        code: "FORBIDDEN",
        message: "API key lacks required scope 'admin:read' for this endpoint."
      });
    });

    it("GET /admin/redemptions - should succeed when valid admin key is provided", async () => {
      const res = await request(app)
        .get("/admin/redemptions")
        .set("Authorization", `Bearer ${genesisConfig.adminKey}`);
      expect(res.status).to.equal(200);
      expect(res.body.redemptions).to.be.an("array");
    });

    it("POST /listings/1/reserve - should enforce buyer:transact scope", async () => {
      // 1. Missing key -> 401
      const resUnauth = await request(app).post("/listings/1/reserve").send({ buyer: "0x123", quantity: 1 });
      expect(resUnauth.status).to.equal(401);

      // 2. Merchant key without buyer:transact -> 403
      const merchantOnlyKey = generateApiKey({
        ownerType: "MERCHANT",
        ownerId: "mer_test_01",
        name: "Merchant Read Only Key",
        scopes: ["merchant:read", "merchant:write"]
      });
      const resForbidden = await request(app)
        .post("/listings/1/reserve")
        .set("Authorization", `Bearer ${merchantOnlyKey.secret}`)
        .send({ buyer: "0x123", quantity: 1 });
      expect(resForbidden.status).to.equal(403);

      // 3. Buyer Agent key -> passes auth (fails downstream due to dummy listing/address, not 401/403)
      const resAuthorized = await request(app)
        .post("/listings/99999/reserve")
        .set("Authorization", `Bearer ${genesisConfig.buyerAgentKey}`)
        .send({ buyer: "invalid_address", quantity: 1 });
      expect(resAuthorized.status).to.equal(400); // 400 Bad Request, NOT 401/403
    });
  });

  describe("Replay-Protected EIP-712 Wallet Binding Flow", () => {
    let wallet: ethers.HDNodeWallet;
    let merchantId: string;

    before(() => {
      wallet = ethers.Wallet.createRandom();
      merchantId = genesisConfig.merchantKey ? "mer_genesis_merchant_01" : "mer_test_binding";
    });

    it("should issue a binding challenge with nonce and 5-min deadline", async () => {
      const res = await request(app)
        .post("/merchant/wallets/challenge")
        .set("Authorization", `Bearer ${genesisConfig.merchantKey}`)
        .send({
          merchantId,
          walletAddress: wallet.address
        });

      expect(res.status).to.equal(200);
      expect(res.body.merchantId).to.equal(merchantId);
      expect(res.body.walletAddress).to.equal(wallet.address);
      expect(res.body.nonce).to.be.a("string");
      expect(res.body.deadline).to.be.a("number");
      expect(res.body.domain.name).to.equal("RestockProtocolPlatform");
      expect(res.body.domain.verifyingContract).to.equal("0x0000000000000000000000000000000000000000");
    });

    it("should verify signature and bind wallet to merchant account", async () => {
      // 1. Get challenge
      const chalRes = await request(app)
        .post("/merchant/wallets/challenge")
        .set("Authorization", `Bearer ${genesisConfig.merchantKey}`)
        .send({ merchantId, walletAddress: wallet.address });

      const { nonce, deadline } = chalRes.body;

      // 2. Sign EIP-712 typed data
      const signature = await wallet.signTypedData(
        EIP712_PLATFORM_DOMAIN,
        BIND_WALLET_TYPES,
        {
          merchantId,
          walletAddress: wallet.address,
          nonce: BigInt(nonce),
          deadline: BigInt(deadline)
        }
      );

      // 3. Submit verification
      const verifyRes = await request(app)
        .post("/merchant/wallets/verify")
        .set("Authorization", `Bearer ${genesisConfig.merchantKey}`)
        .send({
          merchantId,
          walletAddress: wallet.address,
          nonce,
          signature
        });

      expect(verifyRes.status).to.equal(200);
      expect(verifyRes.body.status).to.equal("SUCCESS");
      expect(verifyRes.body.boundWallet).to.equal(wallet.address);

      // Verify in DB
      const db = readDB();
      const m = db.merchants[merchantId];
      const bound = m.wallets.find((w) => w.address.toLowerCase() === wallet.address.toLowerCase());
      expect(bound).to.exist;
      expect(bound?.signatureProof).to.equal(signature);
    });

    it("should REJECT replayed (already-consumed) challenge nonces", async () => {
      // Create new wallet & challenge
      const freshWallet = ethers.Wallet.createRandom();
      const chalRes = await request(app)
        .post("/merchant/wallets/challenge")
        .set("Authorization", `Bearer ${genesisConfig.merchantKey}`)
        .send({ merchantId, walletAddress: freshWallet.address });

      const { nonce, deadline } = chalRes.body;

      const signature = await freshWallet.signTypedData(
        EIP712_PLATFORM_DOMAIN,
        BIND_WALLET_TYPES,
        {
          merchantId,
          walletAddress: freshWallet.address,
          nonce: BigInt(nonce),
          deadline: BigInt(deadline)
        }
      );

      // First call -> success
      const res1 = await request(app)
        .post("/merchant/wallets/verify")
        .set("Authorization", `Bearer ${genesisConfig.merchantKey}`)
        .send({ merchantId, walletAddress: freshWallet.address, nonce, signature });
      expect(res1.status).to.equal(200);

      // Second call (replay) -> 400 Bad Request
      const res2 = await request(app)
        .post("/merchant/wallets/verify")
        .set("Authorization", `Bearer ${genesisConfig.merchantKey}`)
        .send({ merchantId, walletAddress: freshWallet.address, nonce, signature });

      expect(res2.status).to.equal(400);
      expect(res2.body.error).to.include("Replay attempt rejected");
    });

    it("should REJECT expired signature deadlines", async () => {
      const expWallet = ethers.Wallet.createRandom();
      const chalRes = await request(app)
        .post("/merchant/wallets/challenge")
        .set("Authorization", `Bearer ${genesisConfig.merchantKey}`)
        .send({ merchantId, walletAddress: expWallet.address });

      const { nonce, deadline } = chalRes.body;

      // Manually modify deadline in DB to expired timestamp
      const db = readDB();
      db.bindingChallenges[nonce].deadline = Math.floor(Date.now() / 1000) - 10;
      writeDB(db);

      const signature = await expWallet.signTypedData(
        EIP712_PLATFORM_DOMAIN,
        BIND_WALLET_TYPES,
        {
          merchantId,
          walletAddress: expWallet.address,
          nonce: BigInt(nonce),
          deadline: BigInt(deadline) // signature matches structural payload, but backend checks deadline vs current time
        }
      );

      const expRes = await request(app)
        .post("/merchant/wallets/verify")
        .set("Authorization", `Bearer ${genesisConfig.merchantKey}`)
        .send({ merchantId, walletAddress: expWallet.address, nonce, signature });

      expect(expRes.status).to.equal(400);
      expect(expRes.body.error).to.include("Challenge expired");
    });
  });

  describe("Genesis Migration Idempotency", () => {
    it("should run genesis migration idempotently without creating duplicate accounts", () => {
      const run1 = seedGenesis();
      expect(run1.adminKey).to.be.a("string");

      const run2 = seedGenesis();
      expect(run2.adminKey).to.be.a("string");

      const db = readDB();
      const merchantEntries = Object.values(db.merchants).filter((m) => m.id === "mer_genesis_merchant_01");
      expect(merchantEntries.length).to.equal(1);
    });
  });
});

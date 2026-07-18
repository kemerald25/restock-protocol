import { expect } from "chai";
import request from "supertest";
import app from "../src/app";
import { provider, claimToken, skuRegistry, merchantSigner, addresses, SKURegistryABI } from "../src/lib/contracts";
import { canonicalizeAndHashAddress } from "../src/lib/utils";
import { ethers } from "ethers";

describe("Restock Protocol Backend API Integration Tests (Live Base Sepolia)", function () {
  // Real network calls might take longer than the default 2s timeout
  this.timeout(120000); 

  const testAddress = "123 Web3 Boulevard, San Francisco, CA 94103, US";
  const expectedRef = canonicalizeAndHashAddress(testAddress);

  it("GET /health - should return healthy", async () => {
    const res = await request(app).get("/health");
    expect(res.status).to.equal(200);
    expect(res.body.status).to.equal("healthy");
  });

  describe("Discovery & Listings", () => {
    it("GET /skus - should return live SKUs with correct format", async () => {
      const res = await request(app).get("/skus");
      expect(res.status).to.equal(200);
      expect(res.body.results).to.be.an("array");
      expect(res.body.results.length).to.be.greaterThan(0);

      const sku1 = res.body.results.find((s: any) => s.skuId === "1");
      expect(sku1).to.exist;
      expect(sku1.name).to.include("Model RS-01");
      expect(sku1.category).to.equal("sneakers");
      expect(sku1.merchant.toLowerCase()).to.equal(addresses.deployer?.toLowerCase() || "0x345924f66825794e424f9b402756d7015a8dc12e");
      expect(sku1.basisValue).to.be.a("string");
      expect(sku1.maxSupply).to.equal(25);
    });

    it("GET /skus?category=sneakers - should return sneakers", async () => {
      const res = await request(app).get("/skus?category=sneakers");
      expect(res.status).to.equal(200);
      expect(res.body.results.every((s: any) => s.category === "sneakers")).to.be.true;
    });

    it("GET /skus?category=nonexistent - should return empty list", async () => {
      const res = await request(app).get("/skus?category=nonexistent");
      expect(res.status).to.equal(200);
      expect(res.body.results).to.be.empty;
    });

    it("GET /skus?maxPrice=500 - should filter prices correctly", async () => {
      const res = await request(app).get("/skus?maxPrice=500");
      expect(res.status).to.equal(200);
      // SKU 1 might or might not have open listings. If it does, lowestListingPrice <= 500
      for (const sku of res.body.results) {
        if (sku.lowestListingPrice !== null) {
          expect(parseFloat(sku.lowestListingPrice)).to.be.lessThanOrEqual(500);
        }
      }
    });

    it("GET /skus/:skuId/listings - should return listings or empty array", async () => {
      const res = await request(app).get("/skus/1/listings");
      expect(res.status).to.equal(200);
      expect(res.body.skuId).to.equal("1");
      expect(res.body.listings).to.be.an("array");

      // Verify ascending order if there are multiple listings
      const listings = res.body.listings;
      if (listings.length > 1) {
        for (let i = 0; i < listings.length - 1; i++) {
          expect(parseFloat(listings[i].pricePerUnit)).to.be.lessThanOrEqual(parseFloat(listings[i+1].pricePerUnit));
        }
      }
    });

    it("GET /skus/999/listings - should return 404 if SKU does not exist", async () => {
      const res = await request(app).get("/skus/999/listings");
      expect(res.status).to.equal(404);
      expect(res.body.error).to.include("not found");
    });
  });

  describe("Redemption Flow", () => {
    let txHash: string;
    let redemptionId: string;

    before(async function () {
      if (!merchantSigner) {
        this.skip(); // Skip if no signer configured
      }

      console.log("      [Test Setup] Minting and Redeeming onchain for validation...");
      const skuId = 1n;
      const quantity = 1n;

      // 1. Mint 1 claim token to merchant
      const mintTx = await claimToken.connect(merchantSigner).mint(skuId, merchantSigner.address, quantity);
      await mintTx.wait();

      // 2. Redeem onchain using the expected hash
      const redeemTx = await claimToken.connect(merchantSigner).redeem(skuId, quantity, expectedRef);
      const receipt = await redeemTx.wait();

      txHash = redeemTx.hash;
      console.log(`      [Test Setup] Live tx created: ${txHash}`);
    });

    it("POST /skus/1/redeem - should succeed with valid transaction and matching address", async () => {
      if (!txHash) return;

      const res = await request(app)
        .post("/skus/1/redeem")
        .send({
          holder: merchantSigner!.address,
          quantity: 1,
          txHash: txHash,
          shippingAddress: testAddress
        });

      expect(res.status).to.equal(200);
      expect(res.body.redemptionId).to.be.a("string");
      expect(res.body.fulfillmentStatus).to.equal("Pending");
      expect(res.body.txHash).to.equal(txHash);

      redemptionId = res.body.redemptionId;
    });

    it("POST /skus/1/redeem - should fail when the address doesn't hash-match the onchain ref (Verification Mismatch)", async () => {
      if (!txHash) return;

      const mismatchAddress = "456 Another St, New York, NY 10001, US";
      const res = await request(app)
        .post("/skus/1/redeem")
        .send({
          holder: merchantSigner!.address,
          quantity: 1,
          txHash: txHash,
          shippingAddress: mismatchAddress // generates a different hash!
        });

      expect(res.status).to.equal(400);
      expect(res.body.error).to.include("shippingRef mismatch");
    });

    it("POST /skus/1/redeem - should succeed on casing/whitespace differences that produce identical canonical hashes (Verification Proof)", async () => {
      // The spec states canonicalization trims and lowercases.
      // So a casing difference "123 WEB3 BOULEVARD..." should actually succeed because it canonicalizes to the same hash!
      // But we will test that it does indeed succeed, and a truly different address fails.
      if (!txHash) return;

      const casedAddress = "  123 WEB3 BOULEVARD, San Francisco, CA 94103, US  ";
      const res = await request(app)
        .post("/skus/1/redeem")
        .send({
          holder: merchantSigner!.address,
          quantity: 1,
          txHash: txHash,
          shippingAddress: casedAddress
        });

      expect(res.status).to.equal(200); // Should succeed due to canonicalization!
    });

    describe("Admin Endpoints", () => {
      it("GET /admin/redemptions?status=Pending - should return the pending redemption", async () => {
        if (!redemptionId) return;

        const res = await request(app).get("/admin/redemptions?status=Pending");
        expect(res.status).to.equal(200);
        expect(res.body.redemptions).to.be.an("array");

        const found = res.body.redemptions.find((r: any) => r.redemptionId === redemptionId);
        expect(found).to.exist;
        expect(canonicalizeAndHashAddress(found.shippingAddressResolved)).to.equal(expectedRef);
        expect(found.shippingRef).to.equal(expectedRef);
      });

      it("POST /admin/redemptions/:id/mark-shipped - should update fulfillment status", async () => {
        if (!redemptionId) return;

        const res = await request(app).post(`/admin/redemptions/${redemptionId}/mark-shipped`);
        expect(res.status).to.equal(200);
        expect(res.body.fulfillmentStatus).to.equal("Shipped");

        // Verify status in GET query
        const getRes = await request(app).get("/admin/redemptions?status=Shipped");
        const found = getRes.body.redemptions.find((r: any) => r.redemptionId === redemptionId);
        expect(found).to.exist;
      });
    });
  });

  describe("Admin Onchain Basis Value Update", () => {
    it("POST /admin/skus/1/basis-value - should update basis value onchain", async () => {
      if (!merchantSigner) return;

      // 1. Get current basis value from onchain registry
      const initialSku = await skuRegistry.getSKU(1);
      const currentValUSDC = parseFloat(ethers.formatUnits(initialSku.basisValue, 6));

      // 2. Toggle/change value (e.g. alternate between 150.00 and 155.00)
      const newValUSDC = currentValUSDC === 150 ? "155.00" : "150.00";

      // 3. Update via backend API
      const res = await request(app)
        .post("/admin/skus/1/basis-value")
        .send({ value: newValUSDC });

      expect(res.status).to.equal(200);
      expect(res.body.status).to.equal("Success");
      expect(res.body.newBasisValue).to.equal(newValUSDC);
      expect(res.body.txHash).to.be.a("string");

      // 4. Verify onchain registry reflects the new value
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait for RPC block replication
      const updatedSku = await skuRegistry.getSKU(1);
      const updatedValFormatted = parseFloat(ethers.formatUnits(updatedSku.basisValue, 6)).toFixed(2);
      expect(updatedValFormatted).to.equal(newValUSDC);
    });
  });
});

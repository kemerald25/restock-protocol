import { expect } from "chai";
import request from "supertest";
import app from "../src/app";
import { provider, claimToken, skuRegistry, merchantSigner, addresses, SKURegistryABI, marketplace, marketplaceWithRelayer, relayerSigner, usdc, fundRelayerIfNecessary } from "../src/lib/contracts";
import { canonicalizeAndHashAddress } from "../src/lib/utils";
import { ethers } from "ethers";
// @ts-ignore
import { x402Client, x402HTTPClient } from "@x402/core/client";
// @ts-ignore
import { registerExactEvmScheme } from "@x402/evm/exact/client";
// @ts-ignore
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { readDB, writeDB } from "../src/lib/db";

describe("Restock Protocol Backend API Integration Tests (Live Base Sepolia)", function () {
  // Real network calls might take longer than the default 2s timeout
  this.timeout(120000); 

  const testAddress = "123 Web3 Boulevard, San Francisco, CA 94103, US";
  const expectedRef = canonicalizeAndHashAddress(testAddress);

  before(async () => {
    // Clear any stuck / expired reservations from the database to speed up tests
    const db = readDB();
    db.reservations = {};
    writeDB(db);
  });

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
    let testSkuId: number;

    before(async function () {
      if (!merchantSigner) {
        this.skip(); // Skip if no signer configured
      }

      console.log("      [Test Setup] Registering a new SKU dynamically for Redemption Flow isolation...");
      const skuTx = await skuRegistry.connect(merchantSigner).createSKU(
        1000n, // maxSupply
        500,   // royaltyBps
        ethers.parseUnits("150.00", 6), // initialBasisValue
        "https://example.com/sku-redemption-metadata"
      );
      const skuReceipt = await skuTx.wait();
      const parsedSkuLogs = skuReceipt.logs.map((log: any) => {
        try { return skuRegistry.interface.parseLog(log); } catch (e) { return null; }
      });
      const skuCreatedEvent = parsedSkuLogs.find((l: any) => l && l.name === "SKUCreated");
      testSkuId = Number(skuCreatedEvent.args[0]);
      console.log(`      [Test Setup] Dynamically registered SKU ID for redemption: ${testSkuId}`);

      // Verify SKU is visible on the RPC node before proceeding
      let verified = false;
      for (let i = 0; i < 15; i++) {
        try {
          await skuRegistry.getSKU(testSkuId);
          verified = true;
          break;
        } catch (e) {
          console.log(`      [Test Setup] SKU ${testSkuId} not yet visible on RPC, retrying in 2s...`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
      if (!verified) throw new Error(`SKU ${testSkuId} failed to sync on RPC`);

      console.log("      [Test Setup] Minting and Redeeming onchain for validation...");
      const quantity = 1n;

      // 1. Mint 1 claim token to merchant
      const mintTx = await claimToken.connect(merchantSigner).mint(BigInt(testSkuId), merchantSigner.address, quantity);
      await mintTx.wait();

      // Verify balance is visible on RPC
      let balVerified = false;
      for (let i = 0; i < 15; i++) {
        const bal = await claimToken.balanceOf(merchantSigner.address, BigInt(testSkuId));
        if (Number(bal) >= 1) {
          balVerified = true;
          break;
        }
        console.log(`      [Test Setup] Minted balance not yet visible on RPC, retrying in 2s...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (!balVerified) throw new Error("Minted balance failed to sync on RPC");

      // 2. Redeem onchain using the expected hash
      const redeemTx = await claimToken.connect(merchantSigner).redeem(BigInt(testSkuId), quantity, expectedRef);
      await redeemTx.wait();

      txHash = redeemTx.hash;
      console.log(`      [Test Setup] Live tx created: ${txHash}`);

      // Verify redemption is processed on-chain
      let redeemVerified = false;
      for (let i = 0; i < 15; i++) {
        try {
          const receipt = await provider.getTransactionReceipt(txHash);
          if (receipt && receipt.status === 1) {
            redeemVerified = true;
            break;
          }
        } catch (e) {}
        console.log(`      [Test Setup] Redemption tx not yet confirmed on RPC, retrying in 2s...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (!redeemVerified) throw new Error("Redemption tx failed to sync on RPC");await new Promise((resolve) => setTimeout(resolve, 5000));
    });

    it("POST /skus/:skuId/redeem - should succeed with valid transaction and matching address", async () => {
      if (!txHash) return;

      const res = await request(app)
        .post(`/skus/${testSkuId}/redeem`)
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

    it("POST /skus/:skuId/redeem - should fail when the address doesn't hash-match the onchain ref (Verification Mismatch)", async () => {
      if (!txHash) return;

      const mismatchAddress = "456 Another St, New York, NY 10001, US";
      const res = await request(app)
        .post(`/skus/${testSkuId}/redeem`)
        .send({
          holder: merchantSigner!.address,
          quantity: 1,
          txHash: txHash,
          shippingAddress: mismatchAddress // generates a different hash!
        });

      expect(res.status).to.equal(400);
      expect(res.body.error).to.include("shippingRef mismatch");
    });

    it("POST /skus/:skuId/redeem - should succeed on casing/whitespace differences that produce identical canonical hashes (Verification Proof)", async () => {
      // The spec states canonicalization trims and lowercases.
      // So a casing difference "123 WEB3 BOULEVARD..." should actually succeed because it canonicalizes to the same hash!
      // But we will test that it does indeed succeed, and a truly different address fails.
      if (!txHash) return;

      const casedAddress = "  123 WEB3 BOULEVARD, San Francisco, CA 94103, US  ";
      const res = await request(app)
        .post(`/skus/${testSkuId}/redeem`)
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
    let testSkuId: number;

    before(async function () {
      if (!merchantSigner) {
        this.skip();
      }

      console.log("      [Test Setup] Registering a new SKU dynamically for Admin Basis Value isolation...");
      const skuTx = await skuRegistry.connect(merchantSigner).createSKU(
        1000n, // maxSupply
        500,   // royaltyBps
        ethers.parseUnits("150.00", 6), // initialBasisValue
        "https://example.com/sku-basis-value-metadata"
      );
      const skuReceipt = await skuTx.wait();
      const parsedSkuLogs = skuReceipt.logs.map((log: any) => {
        try { return skuRegistry.interface.parseLog(log); } catch (e) { return null; }
      });
      const skuCreatedEvent = parsedSkuLogs.find((l: any) => l && l.name === "SKUCreated");
      testSkuId = Number(skuCreatedEvent.args[0]);
      console.log(`      [Test Setup] Dynamically registered SKU ID for admin update: ${testSkuId}`);

      // Verify SKU is visible on the RPC node before proceeding
      let verified = false;
      for (let i = 0; i < 15; i++) {
        try {
          await skuRegistry.getSKU(testSkuId);
          verified = true;
          break;
        } catch (e) {
          console.log(`      [Test Setup] SKU ${testSkuId} not yet visible on RPC, retrying in 2s...`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
      if (!verified) throw new Error(`SKU ${testSkuId} failed to sync on RPC`);
    });

    it("POST /admin/skus/:skuId/basis-value - should update basis value onchain", async () => {
      if (!merchantSigner || !testSkuId) return;

      // 1. Get current basis value from onchain registry
      const initialSku = await skuRegistry.getSKU(testSkuId);
      const currentValUSDC = parseFloat(ethers.formatUnits(initialSku.basisValue, 6));

      // 2. Toggle/change value (e.g. alternate between 150.00 and 155.00)
      const newValUSDC = currentValUSDC === 150 ? "155.00" : "150.00";

      // 3. Update via backend API
      const res = await request(app)
        .post(`/admin/skus/${testSkuId}/basis-value`)
        .send({ value: newValUSDC });

      expect(res.status).to.equal(200);
      expect(res.body.status).to.equal("Success");
      expect(res.body.newBasisValue).to.equal(newValUSDC);
      expect(res.body.txHash).to.be.a("string");

      // 4. Verify onchain registry reflects the new value
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait for RPC block replication
      const updatedSku = await skuRegistry.getSKU(testSkuId);
      const updatedValFormatted = parseFloat(ethers.formatUnits(updatedSku.basisValue, 6)).toFixed(2);
      expect(updatedValFormatted).to.equal(newValUSDC);
    });
  });

  describe("Reservation & Payment Flow (x402 EIP-3009)", () => {
    let listingId: number;
    let reservationId: string;
    let paymentRequired: any;

    before(async function () {
      if (!merchantSigner || !relayerSigner) {
        this.skip();
      }

      console.log("      [Test Setup] Funding relayer if necessary...");
      await fundRelayerIfNecessary();

      console.log("      [Test Setup] Registering a new SKU dynamically for test isolation...");
      const skuTx = await skuRegistry.connect(merchantSigner).createSKU(
        1000n, // maxSupply
        500,   // royaltyBps
        ethers.parseUnits("150.00", 6), // initialBasisValue
        "https://example.com/sku-test-metadata"
      );
      const skuReceipt = await skuTx.wait();
      const parsedSkuLogs = skuReceipt.logs.map((log: any) => {
        try { return skuRegistry.interface.parseLog(log); } catch (e) { return null; }
      });
      const skuCreatedEvent = parsedSkuLogs.find((l: any) => l && l.name === "SKUCreated");
      const skuId = Number(skuCreatedEvent.args[0]);
      console.log(`      [Test Setup] Dynamically registered SKU ID: ${skuId}`);

      // Verify SKU is visible on the RPC node before proceeding
      let verified = false;
      for (let i = 0; i < 15; i++) {
        try {
          await skuRegistry.getSKU(skuId);
          verified = true;
          break;
        } catch (e) {
          console.log(`      [Test Setup] SKU ${skuId} not yet visible on RPC, retrying in 2s...`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
      if (!verified) throw new Error(`SKU ${skuId} failed to sync on RPC`);

      const merchantAddr = await merchantSigner.getAddress();
      console.log(`      [Test Setup] Merchant: ${merchantAddr}`);
      console.log(`      [Test Setup] Marketplace: ${await marketplace.getAddress()}`);
      console.log(`      [Test Setup] ClaimToken: ${await claimToken.getAddress()}`);
      
      console.log(`      [Test Setup] Minting 10 tokens of SKU ${skuId} to merchant...`);
      const mintTx = await claimToken.connect(merchantSigner).mint(BigInt(skuId), merchantAddr, 10n);
      await mintTx.wait();

      // Verify balance is visible on RPC
      let balVerified = false;
      for (let i = 0; i < 15; i++) {
        const bal = await claimToken.balanceOf(merchantAddr, BigInt(skuId));
        if (Number(bal) >= 10) {
          balVerified = true;
          break;
        }
        console.log(`      [Test Setup] Minted balance not yet visible on RPC, retrying in 2s...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (!balVerified) throw new Error("Minted balance failed to sync on RPC");

      console.log(`      [Test Setup] Creating marketplace listing for SKU ${skuId} (10 units @ 0.01 USDC)...`);
      const tx = await marketplace.connect(merchantSigner).createListing(skuId, 10, ethers.parseUnits("0.01", 6));
      const receipt = await tx.wait();
      const parsedLogs = receipt.logs.map((log: any) => {
        try { return marketplace.interface.parseLog(log); } catch (e) { return null; }
      });
      const listedEvent = parsedLogs.find((l: any) => l && l.name === "Listed");
      listingId = Number(listedEvent.args[0]);
      console.log(`      [Test Setup] Using Listing ID: ${listingId}`);

      // Verify listing is visible on RPC
      let listingVerified = false;
      for (let i = 0; i < 15; i++) {
        try {
          const listing = await marketplace.getListing(listingId);
          if (Number(listing.quantity) > 0) {
            listingVerified = true;
            break;
          }
        } catch (e) {}
        console.log(`      [Test Setup] Listing not yet visible on RPC, retrying in 2s...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (!listingVerified) throw new Error("Listing failed to sync on RPC");
    });

    it("POST /listings/:listingId/reserve - should create reservation on-chain & in DB", async () => {
      const res = await request(app)
        .post(`/listings/${listingId}/reserve`)
        .send({
          buyer: merchantSigner!.address,
          quantity: 1
        });

      expect(res.status).to.equal(200);
      expect(res.body.reservationId).to.be.a("string");
      expect(res.body.status).to.equal("PENDING_SIGNATURE");
      expect(res.body.totalDue).to.equal("0.01");
      expect(res.body.expiresAt).to.be.a("number");

      reservationId = res.body.reservationId;

      // Verify db.json entry
      const db = readDB();
      const record = db.reservations[reservationId];
      expect(record).to.exist;
      expect(record.status).to.equal("PENDING_SIGNATURE");
      expect(record.buyer).to.equal(ethers.getAddress(merchantSigner!.address));
    });

    it("POST /reservations/:reservationId/pay - should challenge with 402 Payment Required", async () => {
      const res = await request(app)
        .post(`/reservations/${reservationId}/pay`)
        .send();

      expect(res.status).to.equal(402);
      expect(res.headers["payment-required"]).to.exist;
      
      paymentRequired = decodePaymentRequiredHeader(res.headers["payment-required"]);
      expect(paymentRequired.x402Version).to.equal(2);
      expect(paymentRequired.accepts[0].scheme).to.equal("exact");
      expect(paymentRequired.accepts[0].amount).to.equal(ethers.parseUnits("0.01", 6).toString());
    });

    it("POST /reservations/:reservationId/pay - should process payment and fulfill reservation", async () => {
      // Create x402Client
      const client = new x402Client();
      
      // ClientEvmSigner wrapper for merchant wallet
      const clientSigner = {
        address: merchantSigner!.address.toLowerCase() as `0x${string}`,
        signTypedData: async (typedData: any) => {
          const cleanTypes = { ...typedData.types };
          delete cleanTypes.EIP712Domain;
          const sig = await merchantSigner!.signTypedData(
            typedData.domain,
            cleanTypes,
            typedData.message
          );
          return sig as `0x${string}`;
        },
        readContract: async (args: any) => {
          const c = new ethers.Contract(args.address, args.abi, merchantSigner);
          const val = await c[args.functionName](...args.args);
          return val;
        }
      };

      registerExactEvmScheme(client, { signer: clientSigner });
      const httpClient = new x402HTTPClient(client);

      // Create EIP-3009 payment payload
      const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
      const paymentSigHeader = encodePaymentSignatureHeader(paymentPayload);

      // Send payment request
      const res = await request(app)
        .post(`/reservations/${reservationId}/pay`)
        .set("payment-signature", paymentSigHeader)
        .send();

      expect(res.status).to.equal(200);
      expect(res.headers["payment-response"]).to.exist;
      expect(res.body.status).to.equal("DELIVERED");
      expect(res.body.paymentTxHash).to.be.a("string");
      expect(res.body.fulfillmentTxHash).to.be.a("string");
      expect(res.body.deliveryTxHash).to.be.a("string");

      // Verify db.json entry is updated to DELIVERED
      const db = readDB();
      const record = db.reservations[reservationId];
      expect(record.status).to.equal("DELIVERED");
      expect(record.paymentTxHash).to.equal(res.body.paymentTxHash);
    });

    it("Atomicity Failure & Auto-Refund - should settle payment and execute automatic refund if fulfillment fails", async () => {
      // 1. Reserve another item
      const reserveRes = await request(app)
        .post(`/listings/${listingId}/reserve`)
        .send({
          buyer: merchantSigner!.address,
          quantity: 1
        });

      expect(reserveRes.status).to.equal(200);
      const testResId = reserveRes.body.reservationId;

      // 2. Challenge
      const payChallengeRes = await request(app)
        .post(`/reservations/${testResId}/pay`)
        .send();

      expect(payChallengeRes.status).to.equal(402);
      const testPaymentRequired = decodePaymentRequiredHeader(payChallengeRes.headers["payment-required"]);

      // 3. Setup client payment payload
      const client = new x402Client();
      const clientSigner = {
        address: merchantSigner!.address.toLowerCase() as `0x${string}`,
        signTypedData: async (typedData: any) => {
          const cleanTypes = { ...typedData.types };
          delete cleanTypes.EIP712Domain;
          return (await merchantSigner!.signTypedData(
            typedData.domain,
            cleanTypes,
            typedData.message
          )) as `0x${string}`;
        },
        readContract: async (args: any) => {
          return await new ethers.Contract(args.address, args.abi, merchantSigner)[args.functionName](...args.args);
        }
      };

      registerExactEvmScheme(client, { signer: clientSigner });
      const httpClient = new x402HTTPClient(client);
      const paymentPayload = await httpClient.createPaymentPayload(testPaymentRequired);
      const paymentSigHeader = encodePaymentSignatureHeader(paymentPayload);

      // 4. Mock a fulfillment failure by temporarily overriding marketplaceWithRelayer.fulfillReservation
      const originalFulfill = marketplaceWithRelayer.fulfillReservation;
      marketplaceWithRelayer.fulfillReservation = async () => {
        throw new Error("Mocked fulfillment failure for atomicity testing");
      };

      // 5. Send payment request (should trigger try/catch refund)
      const payRes = await request(app)
        .post(`/reservations/${testResId}/pay`)
        .set("payment-signature", paymentSigHeader)
        .send();

      // Restore original function
      marketplaceWithRelayer.fulfillReservation = originalFulfill;

      expect(payRes.status).to.equal(500);
      expect(payRes.body.status).to.equal("FAILED_REFUNDING");
      expect(payRes.body.paymentTxHash).to.be.a("string");
      expect(payRes.body.refundTxHash).to.be.a("string");

      // Verify db.json record updated
      const db = readDB();
      const record = db.reservations[testResId];
      expect(record.status).to.equal("FAILED_REFUNDING");
      expect(record.paymentTxHash).to.be.a("string");
      expect(record.refundTxHash).to.be.a("string");

      // Wait a moment and check if transaction got confirmed, updating status to REFUNDED in DB
      if (record.refundTxHash) {
        console.log(`      [Test] Waiting for refund transaction confirmation: ${record.refundTxHash}`);
        const receipt = await provider.waitForTransaction(record.refundTxHash);
        expect(receipt!.status).to.equal(1);
        
        // Run manual reconcile iteration to clean up state
        const { reconcileTransactions } = require("../src/lib/reconciliation");
        await reconcileTransactions();

        const updatedDb = readDB();
        const updatedRecord = updatedDb.reservations[testResId];
        expect(updatedRecord.status).to.equal("REFUNDED");
      }
    });

    it("should escalate to REFUND_FAILED_ESCALATED when refund transaction itself fails to submit repeatedly", async () => {
      const { usdcWithRelayer, usdc, relayerSigner } = require("../src/lib/contracts");
      
      // Fund relayer with USDC to bypass the balance check delay in triggerRefund
      const relayerAddress = await relayerSigner.getAddress();
      const currentBal = await usdc.balanceOf(relayerAddress);
      if (currentBal < ethers.parseUnits("0.1", 6)) {
        console.log(`      [Test Setup] Funding relayer with 1 USDC for refund escalation test...`);
        const txFund = await usdc.connect(merchantSigner).transfer(relayerAddress, ethers.parseUnits("1.0", 6));
        await txFund.wait();
      }

      // 1. Create a reservation that we mock-fail during fulfillment
      const testResId = "mock-esc-res-id-" + Date.now();
      const db = readDB();
      const testRecord = {
        reservationId: testResId,
        listingId,
        buyer: merchantSigner!.address,
        quantity: 1,
        status: "PAID" as const,
        pricePerUnit: "0.01",
        totalDue: "0.01",
        expiresAt: Math.floor(Date.now() / 1000) + 120,
        retryCount: 0,
        updatedAt: Math.floor(Date.now() / 1000),
        paymentTxHash: "0x" + "a".repeat(64)
      };
      db.reservations[testResId] = testRecord;
      writeDB(db);

      // 2. Mock usdcWithRelayer.transfer to throw an error
      const originalTransfer = usdcWithRelayer.transfer;
      usdcWithRelayer.transfer = async () => {
        throw new Error("Mocked RPC node rejection / transfer failure");
      };

      // 3. Trigger refund
      const { triggerRefund, reconcileTransactions } = require("../src/lib/reconciliation");
      const db2 = readDB();
      const record = db2.reservations[testResId];
      await triggerRefund(record, db2, "Mocked fulfillment failure for escalation testing");

      // Verify it is in FAILED_REFUNDING status and refundTxHash is empty
      const db3 = readDB();
      expect(db3.reservations[testResId].status).to.equal("FAILED_REFUNDING");
      expect(db3.reservations[testResId].refundTxHash).to.be.undefined;

      // 4. Run reconciliation 10 times to hit the RETRY_CEILING * 2 threshold (10 retries)
      for (let i = 0; i < 10; i++) {
        await reconcileTransactions();
      }

      // 5. Restore original transfer function
      usdcWithRelayer.transfer = originalTransfer;

      // 6. Verify that it has escalated to REFUND_FAILED_ESCALATED
      const finalDb = readDB();
      const finalRecord = finalDb.reservations[testResId];
      expect(finalRecord.status).to.equal("REFUND_FAILED_ESCALATED");
      expect(finalRecord.lastError).to.include("Refund failed: Mocked RPC node");
    });
  });
});

import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * MOCK SKU SEED DATA / CONFIGURATION
 * 
 * IMPORTANT NOTE: This configuration must be kept in sync manually with the
 * backend's mock SKU configuration (located in backend/src/config.ts).
 * We are intentionally not building a shared config package for this single-SKU MVP.
 */
export const MOCK_SKU_CONFIG = {
  skuId: 1,
  name: "Restock Protocol Demo Sneaker — Model RS-01, Black/White, Size 10",
  variant: "Size 10",
  maxSupply: 25,
  royaltyBps: 300, // 3%
  initialBasisValue: ethers.parseUnits("150.00", 6), // Assuming 6 decimals for USDC
  initialListingPrice: ethers.parseUnits("150.00", 6),
  reservationTTL: 120, // 120 seconds
  metadataURI: "ipfs://.../dunk-low-black-10.json"
};

describe("Restock Protocol - SKURegistry Unit Tests", () => {
  let registry: any;
  let owner: any;
  let merchant: any;
  let nonMerchant: any;
  let claimToken: any;

  beforeEach(async () => {
    [owner, merchant, nonMerchant, claimToken] = await ethers.getSigners();
    
    const SKURegistry = await ethers.getContractFactory("SKURegistry");
    registry = await SKURegistry.deploy(owner.address);
    await registry.waitForDeployment();
  });

  describe("SKU Creation & Auto-Incrementing", () => {
    it("should successfully create a SKU with correct fields", async () => {
      // Create SKU using the merchant signer
      const tx = await registry.connect(merchant).createSKU(
        MOCK_SKU_CONFIG.maxSupply,
        MOCK_SKU_CONFIG.royaltyBps,
        MOCK_SKU_CONFIG.initialBasisValue,
        MOCK_SKU_CONFIG.metadataURI
      );
      await tx.wait();

      const sku = await registry.getSKU(1);
      expect(sku.merchant).to.equal(merchant.address);
      expect(sku.maxSupply).to.equal(MOCK_SKU_CONFIG.maxSupply);
      expect(sku.mintedSupply).to.equal(0);
      expect(sku.redeemedSupply).to.equal(0);
      expect(sku.royaltyBps).to.equal(MOCK_SKU_CONFIG.royaltyBps);
      expect(sku.basisValue).to.equal(MOCK_SKU_CONFIG.initialBasisValue);
      expect(sku.metadataURI).to.equal(MOCK_SKU_CONFIG.metadataURI);
      expect(sku.status).to.equal(0); // Active
    });

    it("should auto-increment skuId starting from 1", async () => {
      // First SKU
      let tx = await registry.connect(merchant).createSKU(10, 100, 1000, "meta1");
      await tx.wait();
      // Second SKU
      tx = await registry.connect(merchant).createSKU(20, 200, 2000, "meta2");
      await tx.wait();

      const sku1 = await registry.getSKU(1);
      const sku2 = await registry.getSKU(2);

      expect(sku1.maxSupply).to.equal(10);
      expect(sku2.maxSupply).to.equal(20);

      // Verify that requesting non-existent SKU reverts
      await expect(registry.getSKU(3)).to.be.revertedWith("SKU registry: SKU does not exist");
      await expect(registry.getSKU(0)).to.be.revertedWith("SKU registry: SKU does not exist");
    });
  });

  describe("Trust Boundary Setup (ClaimToken Address)", () => {
    it("should set claim token address once and block secondary updates", async () => {
      await registry.setClaimTokenAddress(claimToken.address);
      expect(await registry.claimTokenAddress()).to.equal(claimToken.address);

      // Re-setting by owner must revert
      await expect(
        registry.setClaimTokenAddress(nonMerchant.address)
      ).to.be.revertedWith("SKU registry: ClaimToken address already set");
    });

    it("should revert if setClaimTokenAddress is called by non-owner", async () => {
      await expect(
        registry.connect(merchant).setClaimTokenAddress(claimToken.address)
      ).to.be.reverted; // Ownable unauthorized
    });
  });

  describe("Access Control (Merchant-Only Updates)", () => {
    beforeEach(async () => {
      await registry.connect(merchant).createSKU(
        MOCK_SKU_CONFIG.maxSupply,
        MOCK_SKU_CONFIG.royaltyBps,
        MOCK_SKU_CONFIG.initialBasisValue,
        MOCK_SKU_CONFIG.metadataURI
      );
    });

    it("should allow merchant to update basis value", async () => {
      const newVal = ethers.parseUnits("155.00", 6);
      await registry.connect(merchant).updateBasisValue(1, newVal);
      
      const sku = await registry.getSKU(1);
      expect(sku.basisValue).to.equal(newVal);
    });

    it("should revert when non-merchant tries to update basis value", async () => {
      const newVal = ethers.parseUnits("155.00", 6);
      await expect(
        registry.connect(nonMerchant).updateBasisValue(1, newVal)
      ).to.be.revertedWith("SKU registry: caller is not the merchant");
    });

    it("should allow merchant to update status", async () => {
      await registry.connect(merchant).setStatus(1, 1); // Paused
      const sku = await registry.getSKU(1);
      expect(sku.status).to.equal(1);
    });

    it("should revert when non-merchant tries to update status", async () => {
      await expect(
        registry.connect(nonMerchant).setStatus(1, 1)
      ).to.be.revertedWith("SKU registry: caller is not the merchant");
    });
  });

  describe("Max Supply Immutability Check", () => {
    it("should not expose any interface to modify maxSupply after SKU creation", async () => {
      await registry.connect(merchant).createSKU(
        MOCK_SKU_CONFIG.maxSupply,
        MOCK_SKU_CONFIG.royaltyBps,
        MOCK_SKU_CONFIG.initialBasisValue,
        MOCK_SKU_CONFIG.metadataURI
      );

      // Verify that after updating basis value and status, maxSupply remains unchanged
      await registry.connect(merchant).updateBasisValue(1, ethers.parseUnits("200.00", 6));
      await registry.connect(merchant).setStatus(1, 1);

      const sku = await registry.getSKU(1);
      expect(sku.maxSupply).to.equal(MOCK_SKU_CONFIG.maxSupply);
    });
  });
});

describe("Restock Protocol - Critical Invariants", () => {
  let registry: any;
  let owner: any;
  let claimToken: any;
  let merchant: any;

  beforeEach(async () => {
    [owner, claimToken, merchant] = await ethers.getSigners();
    const SKURegistry = await ethers.getContractFactory("SKURegistry");
    registry = await SKURegistry.deploy(owner.address);
    await registry.waitForDeployment();
    await registry.setClaimTokenAddress(claimToken.address);
  });
  
  describe("Invariant 1: Supply Cap Enforcement", () => {
    it("should revert when mint would exceed maxSupply", async () => {
      // 1. Create SKU
      await registry.connect(merchant).createSKU(
        MOCK_SKU_CONFIG.maxSupply,
        MOCK_SKU_CONFIG.royaltyBps,
        MOCK_SKU_CONFIG.initialBasisValue,
        MOCK_SKU_CONFIG.metadataURI
      );

      const skuId = 1;

      // 2. Perform mint up to the supply cap
      await registry.connect(claimToken).recordMint(skuId, MOCK_SKU_CONFIG.maxSupply);
      
      // Verify minted supply has reached max supply
      let sku = await registry.getSKU(skuId);
      expect(sku.mintedSupply).to.equal(MOCK_SKU_CONFIG.maxSupply);

      // 3. Attempting to mint even one additional unit must revert
      await expect(
        registry.connect(claimToken).recordMint(skuId, 1)
      ).to.be.revertedWith("SKU registry: mint amount would exceed maxSupply");

      // Verify checking cap via view function returns false
      expect(await registry._checkMintCap(skuId, 1)).to.be.false;
    });
  });

  describe("Invariant 2: One-way Burn on Redemption", () => {
    it.skip("should prevent burned/redeemed tokens from being transferred, listed, or reserved", async () => {
      // TODO: Test that once tokens are burned via redeem(), they are permanently out of circulation
      // and attempting to transfer, list, or reserve them fails.
    });
  });

  describe("Invariant 3: No Double-locking Reservations", () => {
    it.skip("should prevent double-locking reservations from exceeding the unreserved quantity of a listing", async () => {
      // TODO: Test that overlapping reservation requests fail if their combined quantity exceeds the
      // listing's total unreserved quantity.
    });
  });

  describe("Invariant 4: Atomic Royalty + Token Transfer", () => {
    it.skip("should atomically transfer tokens and route royalties or revert entirely", async () => {
      // TODO: Test that purchasing a token pulls stablecoin payment, splits and routes the royalty
      // to the merchant address, and transfers the claim token in a single atomic transaction.
      // If either payment, royalty routing, or token transfer fails, the entire TX must revert.
    });
  });

  describe("Invariant 5: Basis Value as Non-binding Reference", () => {
    it.skip("should allow purchases and transfers to proceed regardless of basisValue settings", async () => {
      // TODO: Test that basisValue updates do not gate, block, or constrain trading on the marketplace.
      // E.g., trades can happen at, above, or below the basisValue, and even if basisValue is updated or status is paused/active.
    });
  });

});

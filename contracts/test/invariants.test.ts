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

describe("Restock Protocol - ClaimToken Unit Tests", () => {
  let registry: any;
  let claimToken: any;
  let owner: any;
  let merchant: any;
  let user: any;
  let otherUser: any;
  const skuId = 1;

  beforeEach(async () => {
    [owner, merchant, user, otherUser] = await ethers.getSigners();
    
    const SKURegistry = await ethers.getContractFactory("SKURegistry");
    registry = await SKURegistry.deploy(owner.address);
    await registry.waitForDeployment();

    const ClaimToken = await ethers.getContractFactory("ClaimToken");
    claimToken = await ClaimToken.deploy(await registry.getAddress());
    await claimToken.waitForDeployment();

    await registry.setClaimTokenAddress(await claimToken.getAddress());

    // Create SKU
    await registry.connect(merchant).createSKU(
      MOCK_SKU_CONFIG.maxSupply,
      MOCK_SKU_CONFIG.royaltyBps,
      MOCK_SKU_CONFIG.initialBasisValue,
      MOCK_SKU_CONFIG.metadataURI
    );
  });

  it("should allow dynamic URI resolution through SKURegistry", async () => {
    expect(await claimToken.uri(skuId)).to.equal(MOCK_SKU_CONFIG.metadataURI);
  });

  it("should allow SKU merchant to mint tokens, updating the registry counters", async () => {
    const mintAmount = 5;
    await claimToken.connect(merchant).mint(skuId, user.address, mintAmount);

    expect(await claimToken.balanceOf(user.address, skuId)).to.equal(mintAmount);

    const sku = await registry.getSKU(skuId);
    expect(sku.mintedSupply).to.equal(mintAmount);
  });

  it("should revert if non-merchant attempts to mint", async () => {
    await expect(
      claimToken.connect(user).mint(skuId, user.address, 5)
    ).to.be.revertedWith("ClaimToken: caller is not the merchant");
  });

  it("should revert if minting would exceed maxSupply (propagated from registry)", async () => {
    // Mint up to maxSupply is allowed
    await claimToken.connect(merchant).mint(skuId, user.address, MOCK_SKU_CONFIG.maxSupply);
    
    // Minting even 1 more must revert (propagates SKURegistry revert)
    await expect(
      claimToken.connect(merchant).mint(skuId, user.address, 1)
    ).to.be.revertedWith("SKU registry: mint amount would exceed maxSupply");
  });

  it("should allow a token holder to redeem tokens (one-way burn)", async () => {
    await claimToken.connect(merchant).mint(skuId, user.address, 5);

    const redeemAmount = 2;
    const shippingRef = "sha256-shipping-reference-hash";
    
    const tx = await claimToken.connect(user).redeem(skuId, redeemAmount, shippingRef);
    const receipt = await tx.wait();

    // Verify balance decreases
    expect(await claimToken.balanceOf(user.address, skuId)).to.equal(3);

    // Verify registry counter updates
    const sku = await registry.getSKU(skuId);
    expect(sku.redeemedSupply).to.equal(redeemAmount);

    // Verify UnitsRedeemed event emission
    const event = receipt.logs.map((log: any) => {
      try {
        return claimToken.interface.parseLog(log);
      } catch {
        return null;
      }
    }).find((parsed: any) => parsed && parsed.name === "UnitsRedeemed");
    
    expect(event).to.not.be.null;
    expect(event.args.skuId).to.equal(skuId);
    expect(event.args.holder).to.equal(user.address);
    expect(event.args.amount).to.equal(redeemAmount);
    expect(event.args.redemptionId).to.equal(1); // First redemption ID is 1
  });

  it("should revert when redeeming more tokens than held", async () => {
    await claimToken.connect(merchant).mint(skuId, user.address, 2);

    await expect(
      claimToken.connect(user).redeem(skuId, 3, "ref")
    ).to.be.revertedWith("ClaimToken: insufficient balance for redemption");
  });

  it("should allow standard ERC-1155 transfers for un-redeemed balances", async () => {
    await claimToken.connect(merchant).mint(skuId, user.address, 5);

    // Transfer 2 tokens to otherUser
    await claimToken.connect(user).safeTransferFrom(user.address, otherUser.address, skuId, 2, "0x");

    expect(await claimToken.balanceOf(user.address, skuId)).to.equal(3);
    expect(await claimToken.balanceOf(otherUser.address, skuId)).to.equal(2);
  });
});

describe("Restock Protocol - Critical Invariants", () => {
  let registry: any;
  let claimToken: any;
  let owner: any;
  let merchant: any;
  let user: any;
  let otherUser: any;
  const skuId = 1;

  beforeEach(async () => {
    [owner, merchant, user, otherUser] = await ethers.getSigners();
    const SKURegistry = await ethers.getContractFactory("SKURegistry");
    registry = await SKURegistry.deploy(owner.address);
    await registry.waitForDeployment();

    const ClaimToken = await ethers.getContractFactory("ClaimToken");
    claimToken = await ClaimToken.deploy(await registry.getAddress());
    await claimToken.waitForDeployment();

    await registry.setClaimTokenAddress(await claimToken.getAddress());
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

      // 2. Perform mint up to the supply cap
      await claimToken.connect(merchant).mint(skuId, user.address, MOCK_SKU_CONFIG.maxSupply);
      
      // Verify minted supply has reached max supply
      let sku = await registry.getSKU(skuId);
      expect(sku.mintedSupply).to.equal(MOCK_SKU_CONFIG.maxSupply);

      // 3. Attempting to mint even one additional unit must revert
      await expect(
        claimToken.connect(merchant).mint(skuId, user.address, 1)
      ).to.be.revertedWith("SKU registry: mint amount would exceed maxSupply");

      // Verify checking cap via view function returns false
      expect(await registry._checkMintCap(skuId, 1)).to.be.false;
    });
  });

  describe("Invariant 2: One-way Burn on Redemption", () => {
    it("should prevent burned/redeemed tokens from being transferred, listed, or reserved", async () => {
      // Create SKU and mint 5 tokens to user
      await registry.connect(merchant).createSKU(
        MOCK_SKU_CONFIG.maxSupply,
        MOCK_SKU_CONFIG.royaltyBps,
        MOCK_SKU_CONFIG.initialBasisValue,
        MOCK_SKU_CONFIG.metadataURI
      );
      await claimToken.connect(merchant).mint(skuId, user.address, 5);

      // 1. Redeem 3 of the 5 tokens
      await claimToken.connect(user).redeem(skuId, 3, "opaque-shipping-ref");

      // User's balance must decrease from 5 to 2
      expect(await claimToken.balanceOf(user.address, skuId)).to.equal(2);

      // (a) Verify burned tokens cannot be transferred:
      // Attempting to transfer 3 tokens (which includes the redeemed/burned tokens) must revert.
      await expect(
        claimToken.connect(user).safeTransferFrom(user.address, otherUser.address, skuId, 3, "0x")
      ).to.be.reverted;

      // Transferring the remaining 2 unredeemed tokens works fine
      await claimToken.connect(user).safeTransferFrom(user.address, otherUser.address, skuId, 2, "0x");
      expect(await claimToken.balanceOf(user.address, skuId)).to.equal(0);
      expect(await claimToken.balanceOf(otherUser.address, skuId)).to.equal(2);

      // (b) Verify double redemption fails (redeeming more than held reverts):
      // Attempting to redeem 3 tokens from otherUser (who only holds 2) must revert.
      await expect(
        claimToken.connect(otherUser).redeem(skuId, 3, "other-ref")
      ).to.be.revertedWith("ClaimToken: insufficient balance for redemption");

      // (c) Verify there is no way to recreate or restore a burned balance:
      // Merchant can only mint up to the remaining max supply (which is 25 - 5 = 20 tokens)
      await claimToken.connect(merchant).mint(skuId, otherUser.address, 20);
      
      // Attempting to mint even 1 additional token (e.g. trying to recreate the 3 burned ones) must revert
      await expect(
        claimToken.connect(merchant).mint(skuId, otherUser.address, 1)
      ).to.be.revertedWith("SKU registry: mint amount would exceed maxSupply");
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

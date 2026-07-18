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

describe("Restock Protocol - Marketplace Unit Tests", () => {
  let registry: any;
  let claimToken: any;
  let marketplace: any;
  let stableToken: any;
  let owner: any;
  let merchant: any;
  let seller: any;
  let buyer1: any;
  let buyer2: any;
  const skuId = 1;

  beforeEach(async () => {
    [owner, merchant, seller, buyer1, buyer2] = await ethers.getSigners();

    const SKURegistry = await ethers.getContractFactory("SKURegistry");
    registry = await SKURegistry.deploy(owner.address);
    await registry.waitForDeployment();

    const ClaimToken = await ethers.getContractFactory("ClaimToken");
    claimToken = await ClaimToken.deploy(await registry.getAddress());
    await claimToken.waitForDeployment();

    await registry.setClaimTokenAddress(await claimToken.getAddress());

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    stableToken = await MockERC20.deploy("Mock USDC", "mUSDC", 6);
    await stableToken.waitForDeployment();

    const Marketplace = await ethers.getContractFactory("Marketplace");
    marketplace = await Marketplace.deploy(
      await claimToken.getAddress(),
      await registry.getAddress(),
      await stableToken.getAddress()
    );
    await marketplace.waitForDeployment();

    // Create SKU
    await registry.connect(merchant).createSKU(
      MOCK_SKU_CONFIG.maxSupply,
      MOCK_SKU_CONFIG.royaltyBps,
      MOCK_SKU_CONFIG.initialBasisValue,
      MOCK_SKU_CONFIG.metadataURI
    );
  });

  describe("Listing Creation", () => {
    it("should successfully create a listing if seller holds enough tokens", async () => {
      // Mint 5 tokens to seller
      await claimToken.connect(merchant).mint(skuId, seller.address, 5);

      // Create listing
      await marketplace.connect(seller).createListing(skuId, 5, ethers.parseUnits("150.00", 6));

      const [retSkuId, retSeller, retQuantity, retPricePerUnit, retStatus] = await marketplace.getListing(1);
      expect(retSkuId).to.equal(skuId);
      expect(retSeller).to.equal(seller.address);
      expect(retQuantity).to.equal(5);
      expect(retPricePerUnit).to.equal(ethers.parseUnits("150.00", 6));
      expect(retStatus).to.equal(0); // Open
    });

    it("should revert listing creation if seller does not hold enough tokens", async () => {
      // Mint only 4 tokens to seller
      await claimToken.connect(merchant).mint(skuId, seller.address, 4);

      // Attempting to list 5 tokens must revert
      await expect(
        marketplace.connect(seller).createListing(skuId, 5, ethers.parseUnits("150.00", 6))
      ).to.be.revertedWith("Marketplace: seller has insufficient token balance");
    });
  });

  describe("Listing Cancellation", () => {
    beforeEach(async () => {
      await claimToken.connect(merchant).mint(skuId, seller.address, 5);
      await marketplace.connect(seller).createListing(skuId, 5, ethers.parseUnits("150.00", 6));
    });

    it("should allow seller to cancel an open listing", async () => {
      await marketplace.connect(seller).cancelListing(1);

      const [,,,,status] = await marketplace.getListing(1);
      expect(status).to.equal(2); // Cancelled
    });

    it("should revert cancellation by non-seller", async () => {
      await expect(
        marketplace.connect(buyer1).cancelListing(1)
      ).to.be.revertedWith("Marketplace: caller is not the seller");
    });

    it("should revert cancellation if active reservation exists", async () => {
      // Make active reservation of 2 units
      await marketplace.connect(buyer1).reserve(1, 2);

      // Attempting to cancel must revert
      await expect(
        marketplace.connect(seller).cancelListing(1)
      ).to.be.revertedWith("Marketplace: listing has active reservations");
    });
  });

  describe("Reservations & Time Sweeping", () => {
    beforeEach(async () => {
      await claimToken.connect(merchant).mint(skuId, seller.address, 10);
      await marketplace.connect(seller).createListing(skuId, 10, ethers.parseUnits("150.00", 6));
    });

    it("should allow creating a reservation and decrement available unreserved quantity", async () => {
      await marketplace.connect(buyer1).reserve(1, 4);

      const res = await marketplace.getReservation(1);
      expect(res.listingId).to.equal(1);
      expect(res.buyer).to.equal(buyer1.address);
      expect(res.quantity).to.equal(4);
      expect(res.status).to.equal(0); // Active
      
      // Attempting to reserve 7 units must fail (only 6 left)
      await expect(
        marketplace.connect(buyer2).reserve(1, 7)
      ).to.be.revertedWith("Marketplace: insufficient unreserved quantity");

      // Reserving exactly 6 works
      await marketplace.connect(buyer2).reserve(1, 6);
    });

    it("should revert releaseExpiredReservation if reservation is not yet expired", async () => {
      await marketplace.connect(buyer1).reserve(1, 4);

      // Attempting to release immediately must revert
      await expect(
        marketplace.releaseExpiredReservation(1)
      ).to.be.revertedWith("Marketplace: reservation has not expired yet");
    });

    it("should allow releaseExpiredReservation after TTL and free up unreserved quantity", async () => {
      await marketplace.connect(buyer1).reserve(1, 4);

      // Increase time by 121 seconds (TTL is 120s)
      await ethers.provider.send("evm_increaseTime", [121]);
      await ethers.provider.send("evm_mine", []);

      // Release reservation (anyone can call)
      await marketplace.connect(buyer2).releaseExpiredReservation(1);

      const res = await marketplace.getReservation(1);
      expect(res.status).to.equal(2); // Expired

      // The 4 units are now unreserved again, so we can reserve 10 units now
      await marketplace.connect(buyer2).reserve(1, 10);
    });
  });

  describe("Fulfillment Unit Tests & Edge Cases", () => {
    beforeEach(async () => {
      await claimToken.connect(merchant).mint(skuId, seller.address, 10);
      await claimToken.connect(seller).setApprovalForAll(await marketplace.getAddress(), true);
      await marketplace.connect(seller).createListing(skuId, 10, ethers.parseUnits("150.00", 6));
    });

    it("should correctly handle royalty rounding behavior (favoring the seller)", async () => {
      // Deploy a separate listing with price = 1 wei
      await marketplace.connect(seller).createListing(skuId, 1, 1); // Listing ID 2
      await marketplace.connect(buyer1).reserve(2, 1); // Reservation ID 1

      // Fund buyer1 with 1 wei and approve
      await stableToken.mint(buyer1.address, 1);
      await stableToken.connect(buyer1).approve(await marketplace.getAddress(), 1);

      const initSeller = await stableToken.balanceOf(seller.address);
      const initMerchant = await stableToken.balanceOf(merchant.address);

      // Fulfill
      await marketplace.connect(buyer1).fulfillReservation(1);

      // Since royalty is 3% (300 bps), 1 * 300 / 10000 = 0
      // Seller should get 1 wei, merchant should get 0.
      expect(await stableToken.balanceOf(seller.address)).to.equal(initSeller + 1n);
      expect(await stableToken.balanceOf(merchant.address)).to.equal(initMerchant);
    });

    it("should decrement listing quantity correctly after partial fulfillment", async () => {
      await marketplace.connect(buyer1).reserve(1, 3); // Reservation ID 1
      await stableToken.mint(buyer1.address, ethers.parseUnits("450.00", 6));
      await stableToken.connect(buyer1).approve(await marketplace.getAddress(), ethers.parseUnits("450.00", 6));

      await marketplace.connect(buyer1).fulfillReservation(1);

      const [,,quantity,,status] = await marketplace.getListing(1);
      expect(quantity).to.equal(7);
      expect(status).to.equal(0); // Still Open
    });

    it("should transition listing to Filled only once fully consumed", async () => {
      // First partial reservation + fulfillment
      await marketplace.connect(buyer1).reserve(1, 4); // Reservation ID 1
      await stableToken.mint(buyer1.address, ethers.parseUnits("600.00", 6));
      await stableToken.connect(buyer1).approve(await marketplace.getAddress(), ethers.parseUnits("600.00", 6));
      await marketplace.connect(buyer1).fulfillReservation(1);

      let [,,quantity,,status] = await marketplace.getListing(1);
      expect(quantity).to.equal(6);
      expect(status).to.equal(0); // Open

      // Second reservation + fulfillment for the rest
      await marketplace.connect(buyer2).reserve(1, 6); // Reservation ID 2
      await stableToken.mint(buyer2.address, ethers.parseUnits("900.00", 6));
      await stableToken.connect(buyer2).approve(await marketplace.getAddress(), ethers.parseUnits("900.00", 6));
      await marketplace.connect(buyer2).fulfillReservation(2);

      [,,quantity,,status] = await marketplace.getListing(1);
      expect(quantity).to.equal(0);
      expect(status).to.equal(1); // Filled
    });

    it("should revert if fulfillReservation is called on an expired reservation", async () => {
      await marketplace.connect(buyer1).reserve(1, 2); // Reservation ID 1
      await stableToken.mint(buyer1.address, ethers.parseUnits("300.00", 6));
      await stableToken.connect(buyer1).approve(await marketplace.getAddress(), ethers.parseUnits("300.00", 6));

      // Evm increase time past 120s TTL
      await ethers.provider.send("evm_increaseTime", [121]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        marketplace.connect(buyer1).fulfillReservation(1)
      ).to.be.revertedWith("Marketplace: reservation expired, use releaseExpiredReservation");
    });

    it("should revert if fulfillReservation is called by someone other than the buyer", async () => {
      await marketplace.connect(buyer1).reserve(1, 2); // Reservation ID 1
      await stableToken.mint(buyer1.address, ethers.parseUnits("300.00", 6));
      await stableToken.connect(buyer1).approve(await marketplace.getAddress(), ethers.parseUnits("300.00", 6));

      // Attempt to call by seller should fail
      await expect(
        marketplace.connect(seller).fulfillReservation(1)
      ).to.be.revertedWith("Marketplace: caller must be the buyer");
    });

    it("should block reentrant calls using nonReentrant guard", async () => {
      const MockReentrantBuyer = await ethers.getContractFactory("MockReentrantBuyer");
      const reentrantBuyer: any = await MockReentrantBuyer.deploy(
        await marketplace.getAddress(),
        await stableToken.getAddress()
      );
      await reentrantBuyer.waitForDeployment();

      // Reserve 2 tokens for the reentrant buyer
      await reentrantBuyer.reserveListing(1, 2); // Reservation ID 1

      // Setup reservation details on the mock buyer contract
      await reentrantBuyer.setReservation(1);
      await reentrantBuyer.setShouldReenter(true);

      // Fund the contract and approve Marketplace
      await stableToken.mint(await reentrantBuyer.getAddress(), ethers.parseUnits("300.00", 6));
      await reentrantBuyer.approveMarketplace(ethers.parseUnits("300.00", 6));

      // Call initiateFulfill
      await reentrantBuyer.initiateFulfill();

      // Verify that reentrancy was blocked inside onERC1155Received
      expect(await reentrantBuyer.reentrancyFailed()).to.be.true;
    });
  });
});

describe("Restock Protocol - Critical Invariants", () => {
  let registry: any;
  let claimToken: any;
  let marketplace: any;
  let stableToken: any;
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

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    stableToken = await MockERC20.deploy("Mock USDC", "mUSDC", 6);
    await stableToken.waitForDeployment();

    const Marketplace = await ethers.getContractFactory("Marketplace");
    marketplace = await Marketplace.deploy(
      await claimToken.getAddress(),
      await registry.getAddress(),
      await stableToken.getAddress()
    );
    await marketplace.waitForDeployment();
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
    it("should prevent double-locking reservations from exceeding the unreserved quantity of a listing", async () => {
      // 1. Create SKU, mint tokens, and create a listing of 5 units
      await registry.connect(merchant).createSKU(
        MOCK_SKU_CONFIG.maxSupply,
        MOCK_SKU_CONFIG.royaltyBps,
        MOCK_SKU_CONFIG.initialBasisValue,
        MOCK_SKU_CONFIG.metadataURI
      );
      await claimToken.connect(merchant).mint(skuId, user.address, 5);
      await marketplace.connect(user).createListing(skuId, 5, ethers.parseUnits("150.00", 6));

      // 2. First buyer reserves 2 units. This leaves 3 units unreserved.
      await marketplace.connect(otherUser).reserve(1, 2);

      // 3. Second buyer attempts to reserve 4 units.
      // This MUST revert because 4 requested > 3 available (prevents double-locking).
      await expect(
        marketplace.connect(otherUser).reserve(1, 4)
      ).to.be.revertedWith("Marketplace: insufficient unreserved quantity");

      // 4. Second buyer requests 3 units instead. This must succeed.
      await marketplace.connect(otherUser).reserve(1, 3);

      // 5. Any subsequent reservation attempt must revert since available unreserved is now 0.
      await expect(
        marketplace.connect(otherUser).reserve(1, 1)
      ).to.be.revertedWith("Marketplace: insufficient unreserved quantity");
    });
  });

  describe("Invariant 4: Atomic Royalty + Token Transfer", () => {
    beforeEach(async () => {
      // Create SKU
      await registry.connect(merchant).createSKU(
        MOCK_SKU_CONFIG.maxSupply,
        MOCK_SKU_CONFIG.royaltyBps,
        MOCK_SKU_CONFIG.initialBasisValue,
        MOCK_SKU_CONFIG.metadataURI
      );
    });

    it("should atomically transfer tokens and route royalties in a single transaction", async () => {
      // Setup seller with claim tokens
      await claimToken.connect(merchant).mint(skuId, user.address, 5);
      await claimToken.connect(user).setApprovalForAll(await marketplace.getAddress(), true);

      // Create listing
      const price = ethers.parseUnits("100.00", 6);
      await marketplace.connect(user).createListing(skuId, 5, price);

      // Buyer reserves
      await marketplace.connect(otherUser).reserve(1, 2);

      // Fund buyer and approve Marketplace
      const totalDue = price * 2n; // 200.00 USDC
      await stableToken.mint(otherUser.address, totalDue);
      await stableToken.connect(otherUser).approve(await marketplace.getAddress(), totalDue);

      const initBuyerStable = await stableToken.balanceOf(otherUser.address);
      const initSellerStable = await stableToken.balanceOf(user.address);
      const initMerchantStable = await stableToken.balanceOf(merchant.address);

      // Fulfill reservation
      await marketplace.connect(otherUser).fulfillReservation(1);

      // Check reservation status
      const res = await marketplace.getReservation(1);
      expect(res.status).to.equal(1); // Completed

      // Check balances
      // Buyer gets claim tokens
      expect(await claimToken.balanceOf(otherUser.address, skuId)).to.equal(2);
      expect(await claimToken.balanceOf(user.address, skuId)).to.equal(3);

      // Stablecoin checks
      // Buyer balance goes down by totalDue
      expect(await stableToken.balanceOf(otherUser.address)).to.equal(initBuyerStable - totalDue);
      
      // Royalty calculation: 200.00 * 300 / 10000 = 6.00 USDC
      const expectedRoyalty = (totalDue * BigInt(MOCK_SKU_CONFIG.royaltyBps)) / 10000n;
      const expectedSellerAmount = totalDue - expectedRoyalty;

      expect(await stableToken.balanceOf(merchant.address)).to.equal(initMerchantStable + expectedRoyalty);
      expect(await stableToken.balanceOf(user.address)).to.equal(initSellerStable + expectedSellerAmount);
    });

    it("should revert entirely and modify no balances/state if buyer has insufficient stablecoin approval", async () => {
      // Setup seller with claim tokens
      await claimToken.connect(merchant).mint(skuId, user.address, 5);
      await claimToken.connect(user).setApprovalForAll(await marketplace.getAddress(), true);

      // Create listing
      const price = ethers.parseUnits("100.00", 6);
      await marketplace.connect(user).createListing(skuId, 5, price);

      // Buyer reserves
      await marketplace.connect(otherUser).reserve(1, 2);

      // Fund buyer but approve insufficient amount
      const totalDue = price * 2n;
      await stableToken.mint(otherUser.address, totalDue);
      await stableToken.connect(otherUser).approve(await marketplace.getAddress(), totalDue - 1n);

      const initBuyerStable = await stableToken.balanceOf(otherUser.address);
      const initSellerStable = await stableToken.balanceOf(user.address);
      const initMerchantStable = await stableToken.balanceOf(merchant.address);

      // Fulfill should revert
      await expect(
        marketplace.connect(otherUser).fulfillReservation(1)
      ).to.be.reverted; // standard ERC20 revert

      // Check state is unchanged
      const res = await marketplace.getReservation(1);
      expect(res.status).to.equal(0); // Still Active

      // Check balances are unchanged
      expect(await claimToken.balanceOf(otherUser.address, skuId)).to.equal(0);
      expect(await claimToken.balanceOf(user.address, skuId)).to.equal(5);
      expect(await stableToken.balanceOf(otherUser.address)).to.equal(initBuyerStable);
      expect(await stableToken.balanceOf(merchant.address)).to.equal(initMerchantStable);
      expect(await stableToken.balanceOf(user.address)).to.equal(initSellerStable);
    });

    it("should revert entirely and modify no balances/state if seller lacks claim tokens/approval", async () => {
      // Setup seller with claim tokens
      await claimToken.connect(merchant).mint(skuId, user.address, 5);
      // Do NOT set approval for Marketplace

      // Create listing (creates successfully because balance check passes initially)
      const price = ethers.parseUnits("100.00", 6);
      await marketplace.connect(user).createListing(skuId, 5, price);

      // Buyer reserves
      await marketplace.connect(otherUser).reserve(1, 2);

      // Fund buyer and approve Marketplace
      const totalDue = price * 2n;
      await stableToken.mint(otherUser.address, totalDue);
      await stableToken.connect(otherUser).approve(await marketplace.getAddress(), totalDue);

      const initBuyerStable = await stableToken.balanceOf(otherUser.address);
      const initSellerStable = await stableToken.balanceOf(user.address);
      const initMerchantStable = await stableToken.balanceOf(merchant.address);

      // Fulfill should revert because of missing seller ERC-1155 approval
      await expect(
        marketplace.connect(otherUser).fulfillReservation(1)
      ).to.be.reverted;

      // Check state is unchanged
      const res = await marketplace.getReservation(1);
      expect(res.status).to.equal(0); // Still Active

      // Check balances are unchanged
      expect(await claimToken.balanceOf(otherUser.address, skuId)).to.equal(0);
      expect(await claimToken.balanceOf(user.address, skuId)).to.equal(5);
      expect(await stableToken.balanceOf(otherUser.address)).to.equal(initBuyerStable);
      expect(await stableToken.balanceOf(merchant.address)).to.equal(initMerchantStable);
      expect(await stableToken.balanceOf(user.address)).to.equal(initSellerStable);
    });
  });

  describe("Invariant 5: Basis Value as Non-binding Reference", () => {
    beforeEach(async () => {
      // Create SKU with basisValue = 150
      await registry.connect(merchant).createSKU(
        MOCK_SKU_CONFIG.maxSupply,
        MOCK_SKU_CONFIG.royaltyBps,
        ethers.parseUnits("150.00", 6), // basisValue = 150
        MOCK_SKU_CONFIG.metadataURI
      );
    });

    it("should allow creating a listing, reserving, and fulfilling significantly above basisValue", async () => {
      // Setup seller claim tokens
      await claimToken.connect(merchant).mint(skuId, user.address, 5);
      await claimToken.connect(user).setApprovalForAll(await marketplace.getAddress(), true);

      // List at 500 USDC (significantly above 150 USDC basis value)
      const price = ethers.parseUnits("500.00", 6);
      await marketplace.connect(user).createListing(skuId, 2, price);

      // Buyer reserves
      await marketplace.connect(otherUser).reserve(1, 2);

      // Fund buyer and approve
      const totalDue = price * 2n; // 1000.00 USDC
      await stableToken.mint(otherUser.address, totalDue);
      await stableToken.connect(otherUser).approve(await marketplace.getAddress(), totalDue);

      // Fulfill
      await marketplace.connect(otherUser).fulfillReservation(1);

      // Verify completion
      const res = await marketplace.getReservation(1);
      expect(res.status).to.equal(1); // Completed
      expect(await claimToken.balanceOf(otherUser.address, skuId)).to.equal(2);
    });

    it("should allow creating a listing, reserving, and fulfilling significantly below basisValue", async () => {
      // Setup seller claim tokens
      await claimToken.connect(merchant).mint(skuId, user.address, 5);
      await claimToken.connect(user).setApprovalForAll(await marketplace.getAddress(), true);

      // List at 20 USDC (significantly below 150 USDC basis value)
      const price = ethers.parseUnits("20.00", 6);
      await marketplace.connect(user).createListing(skuId, 2, price);

      // Buyer reserves
      await marketplace.connect(otherUser).reserve(1, 2);

      // Fund buyer and approve
      const totalDue = price * 2n; // 40.00 USDC
      await stableToken.mint(otherUser.address, totalDue);
      await stableToken.connect(otherUser).approve(await marketplace.getAddress(), totalDue);

      // Fulfill
      await marketplace.connect(otherUser).fulfillReservation(1);

      // Verify completion
      const res = await marketplace.getReservation(1);
      expect(res.status).to.equal(1); // Completed
      expect(await claimToken.balanceOf(otherUser.address, skuId)).to.equal(2);
    });

    it("should allow fulfillment even if basisValue is updated after the reservation is made", async () => {
      // Setup seller claim tokens
      await claimToken.connect(merchant).mint(skuId, user.address, 5);
      await claimToken.connect(user).setApprovalForAll(await marketplace.getAddress(), true);

      const price = ethers.parseUnits("100.00", 6);
      await marketplace.connect(user).createListing(skuId, 2, price);

      // Buyer reserves
      await marketplace.connect(otherUser).reserve(1, 2);

      // Merchant updates basisValue to 250 USDC
      await registry.connect(merchant).updateBasisValue(skuId, ethers.parseUnits("250.00", 6));

      // Fund buyer and approve
      const totalDue = price * 2n;
      await stableToken.mint(otherUser.address, totalDue);
      await stableToken.connect(otherUser).approve(await marketplace.getAddress(), totalDue);

      // Fulfill should proceed exactly the same
      await marketplace.connect(otherUser).fulfillReservation(1);

      // Verify completion
      const res = await marketplace.getReservation(1);
      expect(res.status).to.equal(1); // Completed
      expect(await claimToken.balanceOf(otherUser.address, skuId)).to.equal(2);
    });

    it("should behave identically for listings priced 0.01 above/below basis vs 10x basis (no-threshold check)", async () => {
      // Setup seller claim tokens
      await claimToken.connect(merchant).mint(skuId, user.address, 10);
      await claimToken.connect(user).setApprovalForAll(await marketplace.getAddress(), true);

      // We will create three listings:
      // Listing 1: 150.01 (0.01 above basis)
      // Listing 2: 149.99 (0.01 below basis)
      // Listing 3: 1500.00 (10x basis)

      const p1 = ethers.parseUnits("150.01", 6);
      const p2 = ethers.parseUnits("149.99", 6);
      const p3 = ethers.parseUnits("1500.00", 6);

      await marketplace.connect(user).createListing(skuId, 2, p1); // Listing 1
      await marketplace.connect(user).createListing(skuId, 2, p2); // Listing 2
      await marketplace.connect(user).createListing(skuId, 2, p3); // Listing 3

      // Reserve all three
      await marketplace.connect(otherUser).reserve(1, 1); // Res 1
      await marketplace.connect(otherUser).reserve(2, 1); // Res 2
      await marketplace.connect(otherUser).reserve(3, 1); // Res 3

      // Fund & approve for all
      const totalDue = p1 + p2 + p3;
      await stableToken.mint(otherUser.address, totalDue);
      await stableToken.connect(otherUser).approve(await marketplace.getAddress(), totalDue);

      // Fulfill all three and verify they succeed
      await marketplace.connect(otherUser).fulfillReservation(1);
      await marketplace.connect(otherUser).fulfillReservation(2);
      await marketplace.connect(otherUser).fulfillReservation(3);

      expect((await marketplace.getReservation(1)).status).to.equal(1);
      expect((await marketplace.getReservation(2)).status).to.equal(1);
      expect((await marketplace.getReservation(3)).status).to.equal(1);
    });
  });

});

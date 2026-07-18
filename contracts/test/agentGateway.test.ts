import { expect } from "chai";
import { ethers } from "hardhat";

describe("Restock Protocol - AgentGateway Unit Tests", () => {
  let registry: any;
  let claimToken: any;
  let stableToken: any;
  let marketplace: any;
  let gateway: any;

  let owner: any;
  let merchant: any;
  let seller: any;
  let buyer: any;
  const skuId = 1;

  beforeEach(async () => {
    [owner, merchant, seller, buyer] = await ethers.getSigners();

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

    const AgentGateway = await ethers.getContractFactory("AgentGateway");
    gateway = await AgentGateway.deploy(
      await marketplace.getAddress(),
      await claimToken.getAddress(),
      await stableToken.getAddress()
    );
    await gateway.waitForDeployment();

    // Create SKU with 3% royalty (300 bps)
    await registry.connect(merchant).createSKU(
      25,
      300,
      ethers.parseUnits("150.00", 6),
      "ipfs://.../dunk-low-black-10.json"
    );
  });

  it("should successfully execute agentPurchase end-to-end (Happy Path)", async () => {
    // 1. Mint claim tokens to seller and approve Marketplace
    await claimToken.connect(merchant).mint(skuId, seller.address, 10);
    await claimToken.connect(seller).setApprovalForAll(await marketplace.getAddress(), true);

    // 2. Seller creates listing
    const price = ethers.parseUnits("150.00", 6);
    await marketplace.connect(seller).createListing(skuId, 5, price);

    // 3. Fund buyer and approve AgentGateway
    const quantity = 2n;
    const totalDue = price * quantity; // 300.00 USDC
    await stableToken.mint(buyer.address, totalDue);
    await stableToken.connect(buyer).approve(await gateway.getAddress(), totalDue);

    const initBuyerStable = await stableToken.balanceOf(buyer.address);
    const initSellerStable = await stableToken.balanceOf(seller.address);
    const initMerchantStable = await stableToken.balanceOf(merchant.address);

    // 4. Call agentPurchase
    const tx = await gateway.connect(buyer).agentPurchase(1, quantity, await stableToken.getAddress());
    await tx.wait();

    // 5. Verify token balances
    // Buyer should hold 2 claim tokens
    expect(await claimToken.balanceOf(buyer.address, skuId)).to.equal(2);
    // Seller should hold 8 remaining claim tokens
    expect(await claimToken.balanceOf(seller.address, skuId)).to.equal(8);

    // 6. Verify stablecoin balances
    // Buyer balance decreased by 300.00 USDC
    expect(await stableToken.balanceOf(buyer.address)).to.equal(initBuyerStable - totalDue);
    
    // Royalty is 3% (300 bps): 300.00 USDC * 3% = 9.00 USDC
    const expectedRoyalty = (totalDue * 300n) / 10000n;
    const expectedSellerAmount = totalDue - expectedRoyalty;

    expect(await stableToken.balanceOf(merchant.address)).to.equal(initMerchantStable + expectedRoyalty);
    expect(await stableToken.balanceOf(seller.address)).to.equal(initSellerStable + expectedSellerAmount);

    // 7. Verify gateway balance is 0 (no stranded tokens or USDC)
    expect(await claimToken.balanceOf(await gateway.getAddress(), skuId)).to.equal(0);
    expect(await stableToken.balanceOf(await gateway.getAddress())).to.equal(0);
  });

  it("should revert if payToken is not the allowlisted stablecoin", async () => {
    await claimToken.connect(merchant).mint(skuId, seller.address, 10);
    await claimToken.connect(seller).setApprovalForAll(await marketplace.getAddress(), true);
    await marketplace.connect(seller).createListing(skuId, 5, ethers.parseUnits("150.00", 6));

    // Deploy another mock ERC20
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const otherToken = await MockERC20.deploy("Other Token", "OT", 18);
    await otherToken.waitForDeployment();

    await expect(
      gateway.connect(buyer).agentPurchase(1, 2, await otherToken.getAddress())
    ).to.be.revertedWith("AgentGateway: unsupported payment token");
  });

  it("should revert and modify no balances if buyer hasn't approved AgentGateway", async () => {
    await claimToken.connect(merchant).mint(skuId, seller.address, 10);
    await claimToken.connect(seller).setApprovalForAll(await marketplace.getAddress(), true);

    const price = ethers.parseUnits("150.00", 6);
    await marketplace.connect(seller).createListing(skuId, 5, price);

    // Fund buyer but do NOT approve AgentGateway
    const totalDue = price * 2n;
    await stableToken.mint(buyer.address, totalDue);

    const initBuyerStable = await stableToken.balanceOf(buyer.address);
    const initSellerStable = await stableToken.balanceOf(seller.address);
    const initMerchantStable = await stableToken.balanceOf(merchant.address);

    await expect(
      gateway.connect(buyer).agentPurchase(1, 2, await stableToken.getAddress())
    ).to.be.reverted; // standard ERC20 revert for allowance

    // Verify nothing changed
    expect(await claimToken.balanceOf(buyer.address, skuId)).to.equal(0);
    expect(await claimToken.balanceOf(seller.address, skuId)).to.equal(10);
    expect(await stableToken.balanceOf(buyer.address)).to.equal(initBuyerStable);
    expect(await stableToken.balanceOf(seller.address)).to.equal(initSellerStable);
    expect(await stableToken.balanceOf(merchant.address)).to.equal(initMerchantStable);
  });

  it("should block reentrant calls using nonReentrant guard on agentPurchase", async () => {
    await claimToken.connect(merchant).mint(skuId, seller.address, 10);
    await claimToken.connect(seller).setApprovalForAll(await marketplace.getAddress(), true);
    await marketplace.connect(seller).createListing(skuId, 5, ethers.parseUnits("150.00", 6));

    // Deploy MockReentrantAgentPayer
    const MockReentrantAgentPayer = await ethers.getContractFactory("MockReentrantAgentPayer");
    const reentrantPayer: any = await MockReentrantAgentPayer.deploy(
      await gateway.getAddress(),
      await stableToken.getAddress()
    );
    await reentrantPayer.waitForDeployment();

    // Setup purchase parameters (Listing ID 1, 2 units)
    await reentrantPayer.setPurchaseParams(1, 2);
    await reentrantPayer.setShouldReenter(true);

    // Fund and approve
    const totalDue = ethers.parseUnits("300.00", 6);
    await stableToken.mint(await reentrantPayer.getAddress(), totalDue * 2n); // Fund enough for two purchases
    await reentrantPayer.approveGateway(totalDue * 2n);

    // Execute
    await reentrantPayer.initiatePurchase();

    // Verify reentrancy failed inside the onERC1155Received callback
    expect(await reentrantPayer.reentrancyFailed()).to.be.true;
  });
});

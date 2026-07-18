import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const filePath = path.join(__dirname, "../deployments/base-sepolia.json");
  if (!fs.existsSync(filePath)) {
    throw new Error(`Deployment file not found at ${filePath}. Please run deploy first.`);
  }

  const deploymentInfo = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const {
    USDC: USDC_ADDRESS,
    SKURegistry: registryAddress,
    ClaimToken: claimTokenAddress,
    Marketplace: marketplaceAddress,
    AgentGateway: gatewayAddress
  } = deploymentInfo;

  const [deployer] = await ethers.getSigners();
  console.log("Starting smoke test using deployer/merchant/seller wallet:", deployer.address);

  // Generate a random temporary buyer wallet to simulate the agent
  const buyer = ethers.Wallet.createRandom(ethers.provider);
  console.log("Generated random buyer EOA for smoke test:", buyer.address);

  const usdc = await ethers.getContractAt("IERC20", USDC_ADDRESS);
  const claimToken = await ethers.getContractAt("ClaimToken", claimTokenAddress);
  const marketplace = await ethers.getContractAt("Marketplace", marketplaceAddress);
  const gateway = await ethers.getContractAt("AgentGateway", gatewayAddress);

  // 1. Check deployer funds
  const deployerEthBal = await ethers.provider.getBalance(deployer.address);
  const deployerUsdcBal = await usdc.balanceOf(deployer.address);
  console.log("Deployer ETH balance:", ethers.formatEther(deployerEthBal));
  console.log("Deployer USDC balance:", ethers.formatUnits(deployerUsdcBal, 6));

  if (deployerEthBal < ethers.parseEther("0.005")) {
    throw new Error("Deployer wallet has insufficient ETH for gas.");
  }
  if (deployerUsdcBal < ethers.parseUnits("4.00", 6)) {
    throw new Error("Deployer wallet has insufficient USDC (requires at least 4.00 USDC).");
  }

  // 2. Fund the temporary buyer wallet with ETH and USDC
  console.log("\nFunding temporary buyer with 0.001 ETH and 4.00 USDC...");
  const ethTx = await deployer.sendTransaction({
    to: buyer.address,
    value: ethers.parseEther("0.001")
  });
  console.log("ETH transfer hash:", ethTx.hash);
  await ethTx.wait();

  const usdcTx = await usdc.connect(deployer).transfer(buyer.address, ethers.parseUnits("4.00", 6));
  console.log("USDC transfer hash:", usdcTx.hash);
  await usdcTx.wait();

  // 3. Mint 2 claim tokens of SKU 1 to the seller (deployer)
  console.log("\nMinting 2 claim tokens to seller (deployer)...");
  const mintTx = await claimToken.connect(deployer).mint(1, deployer.address, 2);
  console.log("Mint tx hash:", mintTx.hash);
  await mintTx.wait();

  // 4. Seller approves Marketplace
  console.log("\nApproving Marketplace for seller's claim tokens...");
  const appTx = await claimToken.connect(deployer).setApprovalForAll(marketplaceAddress, true);
  console.log("Approve tx hash:", appTx.hash);
  await appTx.wait();

  // 5. Create Listing (2 units at 2.00 USDC each)
  console.log("\nCreating listing...");
  const listTx = await marketplace.connect(deployer).createListing(1, 2, ethers.parseUnits("2.00", 6));
  console.log("Create listing tx hash:", listTx.hash);
  const listReceipt = await listTx.wait();
  console.log("Listing created in block:", listReceipt?.blockNumber);

  // We assume this is Listing ID 1 (or we can extract it from events, but in a clean deployment it's 1)
  const listingId = 1; 

  // 6. Buyer approves AgentGateway for 4.00 USDC
  console.log("\nApproving AgentGateway for buyer's USDC...");
  const gatewayApproveTx = await usdc.connect(buyer).approve(gatewayAddress, ethers.parseUnits("4.00", 6));
  console.log("Gateway approve tx hash:", gatewayApproveTx.hash);
  await gatewayApproveTx.wait();

  // 7. Perform purchase via AgentGateway
  console.log("\nExecuting agentPurchase on AgentGateway...");
  const purchaseTx = await gateway.connect(buyer).agentPurchase(listingId, 2, USDC_ADDRESS);
  console.log("Purchase transaction hash:", purchaseTx.hash);
  const purchaseReceipt = await purchaseTx.wait();
  console.log("Purchase confirmed in block:", purchaseReceipt?.blockNumber);

  // 8. Verify final state and balances
  console.log("\nVerifying final balances...");
  const buyerClaimBal = await claimToken.balanceOf(buyer.address, 1);
  const gatewayClaimBal = await claimToken.balanceOf(gatewayAddress, 1);
  const buyerUsdcBal = await usdc.balanceOf(buyer.address);

  console.log("Buyer Claim Token balance (SKU #1):", buyerClaimBal.toString());
  console.log("Gateway Claim Token balance (SKU #1):", gatewayClaimBal.toString());
  console.log("Buyer USDC balance:", ethers.formatUnits(buyerUsdcBal, 6));

  if (buyerClaimBal === 2n && gatewayClaimBal === 0n) {
    console.log("\nSMOKE TEST SUCCESSFUL!");
  } else {
    console.error("\nSMOKE TEST FAILED: Balance checks failed.");
  }

  // 9. Return remaining funds from temporary buyer to deployer
  console.log("\nReturning remaining funds to deployer...");
  const leftoverUsdc = await usdc.balanceOf(buyer.address);
  if (leftoverUsdc > 0n) {
    const refundUsdcTx = await usdc.connect(buyer).transfer(deployer.address, leftoverUsdc);
    await refundUsdcTx.wait();
  }

  const leftoverEth = await ethers.provider.getBalance(buyer.address);
  const gasLimit = 21000n;
  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? ethers.parseUnits("1.5", "gwei");
  const gasCost = gasLimit * gasPrice;
  if (leftoverEth > gasCost) {
    const refundEthTx = await buyer.sendTransaction({
      to: deployer.address,
      value: leftoverEth - gasCost,
      gasLimit
    });
    await refundEthTx.wait();
  }
  console.log("Refund complete!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

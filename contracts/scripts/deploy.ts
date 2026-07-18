import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance (ETH):", ethers.formatEther(balance));

  // The verified testnet USDC address on Base Sepolia
  const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

  // 1. Deploy SKURegistry
  console.log("\n1. Deploying SKURegistry...");
  const SKURegistry = await ethers.getContractFactory("SKURegistry");
  const registry = await SKURegistry.deploy(deployer.address);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log("SKURegistry deployed to:", registryAddress);

  // 2. Deploy ClaimToken
  console.log("\n2. Deploying ClaimToken...");
  const ClaimToken = await ethers.getContractFactory("ClaimToken");
  const claimToken = await ClaimToken.deploy(registryAddress);
  await claimToken.waitForDeployment();
  const claimTokenAddress = await claimToken.getAddress();
  console.log("ClaimToken deployed to:", claimTokenAddress);

  // 3. Set ClaimToken address in SKURegistry
  console.log("\n3. Setting ClaimToken address in SKURegistry...");
  const tx = await registry.setClaimTokenAddress(claimTokenAddress);
  await tx.wait();
  console.log("ClaimToken address configured successfully!");

  // 4. Deploy Marketplace
  console.log("\n4. Deploying Marketplace...");
  const Marketplace = await ethers.getContractFactory("Marketplace");
  const marketplace = await Marketplace.deploy(
    claimTokenAddress,
    registryAddress,
    USDC_ADDRESS
  );
  await marketplace.waitForDeployment();
  const marketplaceAddress = await marketplace.getAddress();
  console.log("Marketplace deployed to:", marketplaceAddress);

  // 5. Deploy AgentGateway
  console.log("\n5. Deploying AgentGateway...");
  const AgentGateway = await ethers.getContractFactory("AgentGateway");
  const gateway = await AgentGateway.deploy(
    marketplaceAddress,
    claimTokenAddress,
    USDC_ADDRESS
  );
  await gateway.waitForDeployment();
  const gatewayAddress = await gateway.getAddress();
  console.log("AgentGateway deployed to:", gatewayAddress);

  const deploymentBlock = await ethers.provider.getBlockNumber();

  // Save deployments/base-sepolia.json
  const deploymentInfo = {
    network: "baseSepolia",
    deployer: deployer.address,
    timestamp: Math.floor(Date.now() / 1000),
    blockNumber: deploymentBlock,
    USDC: USDC_ADDRESS,
    SKURegistry: registryAddress,
    ClaimToken: claimTokenAddress,
    Marketplace: marketplaceAddress,
    AgentGateway: gatewayAddress
  };

  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const filePath = path.join(deploymentsDir, "base-sepolia.json");
  fs.writeFileSync(filePath, JSON.stringify(deploymentInfo, null, 2), "utf8");
  console.log(`\nDeployment info saved to: ${filePath}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

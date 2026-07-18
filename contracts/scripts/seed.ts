import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const filePath = path.join(__dirname, "../deployments/base-sepolia.json");
  if (!fs.existsSync(filePath)) {
    throw new Error(`Deployment file not found at ${filePath}. Please run deploy first.`);
  }

  const deploymentInfo = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const registryAddress = deploymentInfo.SKURegistry;
  console.log("Using SKURegistry at:", registryAddress);

  const [deployer] = await ethers.getSigners();
  console.log("Seeding with account:", deployer.address);

  const registry = await ethers.getContractAt("SKURegistry", registryAddress);

  // Seed locked Mock SKU values from design spec
  const maxSupply = 25n;
  const royaltyBps = 300; // 3%
  const initialBasisValue = ethers.parseUnits("150.00", 6); // 150.00 USDC
  const metadataURI = "ipfs://.../dunk-low-black-10.json";

  console.log("\nCreating SKU...");
  const tx = await registry.createSKU(maxSupply, royaltyBps, initialBasisValue, metadataURI);
  console.log("Transaction hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("Transaction confirmed in block:", receipt?.blockNumber);

  // The skuId should be 1. Let's fetch SKU details to verify.
  const skuInfo = await registry.getSKU(1);
  console.log("\nSeeded SKU #1 Details:");
  console.log("Merchant:", skuInfo.merchant);
  console.log("Max Supply:", skuInfo.maxSupply.toString());
  console.log("Royalty Bps:", skuInfo.royaltyBps.toString());
  console.log("Basis Value:", ethers.formatUnits(skuInfo.basisValue, 6), "USDC");
  console.log("Metadata URI:", skuInfo.metadataURI);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

import * as dotenv from "dotenv";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

// Initialize environment variables first to prevent config race conditions
dotenv.config();

// Load deployments config
const DEPLOYMENT_PATH = path.join(
  __dirname,
  "../../../contracts/deployments/base-sepolia.json"
);

if (!fs.existsSync(DEPLOYMENT_PATH)) {
  throw new Error(`Deployment file not found at: ${DEPLOYMENT_PATH}`);
}

const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"));

// Dynamic ABI loading function
const loadABI = (contractName: string) => {
  const artifactPath = path.join(
    __dirname,
    `../../../contracts/artifacts/contracts/${contractName}.sol/${contractName}.json`
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Contract artifact not found at: ${artifactPath}. Please compile the contracts first.`);
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8")).abi;
};

export const SKURegistryABI = loadABI("SKURegistry");
export const ClaimTokenABI = loadABI("ClaimToken");
export const MarketplaceABI = loadABI("Marketplace");
export const AgentGatewayABI = loadABI("AgentGateway");

export const addresses = {
  SKURegistry: deployment.SKURegistry as string,
  ClaimToken: deployment.ClaimToken as string,
  Marketplace: deployment.Marketplace as string,
  AgentGateway: deployment.AgentGateway as string,
  USDC: deployment.USDC as string,
  deployer: deployment.deployer as string,
};

// RPC configuration
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
export const provider = new ethers.JsonRpcProvider(RPC_URL);

// Contract Instances (typed as any to bypass monorepo workspace tsconfig rootDir limits)
export const skuRegistry = new ethers.Contract(
  addresses.SKURegistry,
  SKURegistryABI,
  provider
) as any;

export const claimToken = new ethers.Contract(
  addresses.ClaimToken,
  ClaimTokenABI,
  provider
) as any;

export const marketplace = new ethers.Contract(
  addresses.Marketplace,
  MarketplaceABI,
  provider
) as any;

export const agentGateway = new ethers.Contract(
  addresses.AgentGateway,
  AgentGatewayABI,
  provider
) as any;

// Merchant/Admin Signer
const MERCHANT_PRIVATE_KEY = process.env.MERCHANT_PRIVATE_KEY;
export const merchantSigner = MERCHANT_PRIVATE_KEY
  ? new ethers.Wallet(MERCHANT_PRIVATE_KEY, provider)
  : null;

export const skuRegistryWithSigner = merchantSigner
  ? (new ethers.Contract(
      addresses.SKURegistry,
      SKURegistryABI,
      merchantSigner
    ) as any)
  : skuRegistry;

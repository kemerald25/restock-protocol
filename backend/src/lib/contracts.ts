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

export const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"));

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

class RetryingJsonRpcProvider extends ethers.JsonRpcProvider {
  async send(method: string, params: Array<any> | Record<string, any>): Promise<any> {
    let attempts = 0;
    const maxAttempts = 8;
    let delay = 1000;
    while (attempts < maxAttempts) {
      try {
        return await super.send(method, params);
      } catch (error: any) {
        attempts++;

        // Never retry legitimate contract reverts (CALL_EXCEPTION)
        if (error?.code === "CALL_EXCEPTION" && !String(error?.message || "").includes("over rate limit")) {
          throw error;
        }

        const errStr = (
          String(error?.message || "") + " " +
          String(error?.code || "") + " " +
          String(error?.reason || "") + " " +
          String(error?.syscall || "") + " " +
          String(error?.cause || "") + " " +
          String(error?.error?.message || "") + " " +
          String(error?.error?.code || "")
        ).toUpperCase();

        const isTransient = 
          errStr.includes("ECONNRESET") ||
          errStr.includes("ETIMEDOUT") ||
          errStr.includes("EPROTO") ||
          errStr.includes("SSL") ||
          errStr.includes("TLS") ||
          errStr.includes("SOCKET HANG UP") ||
          errStr.includes("NETWORK") ||
          errStr.includes("RATE LIMIT") ||
          errStr.includes("OVER RATE LIMIT") ||
          errStr.includes("429") ||
          errStr.includes("-32016") ||
          errStr.includes("ENOTFOUND") ||
          errStr.includes("BAD RECORD MAC") ||
          error?.code === "TIMEOUT" ||
          error?.code === "SERVER_ERROR";
        
        if (isTransient && attempts < maxAttempts) {
          const jitter = Math.floor(Math.random() * 300);
          const totalDelay = delay + jitter;
          console.warn(`[RetryingJsonRpcProvider] Transient error on ${method} (attempt ${attempts}/${maxAttempts}): ${error.message || error.code || "unknown"}. Retrying in ${totalDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, totalDelay));
          delay *= 1.8;
        } else {
          throw error;
        }
      }
    }
  }
}

// RPC configuration
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
export const provider = new RetryingJsonRpcProvider(RPC_URL);

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

// Relayer Signer
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
export const relayerSigner = RELAYER_PRIVATE_KEY
  ? new ethers.Wallet(RELAYER_PRIVATE_KEY, provider)
  : null;

export const marketplaceWithRelayer = relayerSigner
  ? (new ethers.Contract(
      addresses.Marketplace,
      MarketplaceABI,
      relayerSigner
    ) as any)
  : marketplace;

export const claimTokenWithRelayer = relayerSigner
  ? (new ethers.Contract(
      addresses.ClaimToken,
      ClaimTokenABI,
      relayerSigner
    ) as any)
  : claimToken;

// USDC ERC20 + EIP-3009/EIP-2612 ABI
export const ERC20ABI = [
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function nonces(address owner) external view returns (uint256)",
  "function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external"
];

export const usdc = new ethers.Contract(
  addresses.USDC,
  ERC20ABI,
  provider
) as any;

export const usdcWithRelayer = relayerSigner
  ? (new ethers.Contract(
      addresses.USDC,
      ERC20ABI,
      relayerSigner
    ) as any)
  : usdc;

// Automated Gas Funding
export const fundRelayerIfNecessary = async () => {
  if (!merchantSigner || !relayerSigner) return;
  try {
    const relayerAddress = relayerSigner.address;
    let relayerBalance = await provider.getBalance(relayerAddress);
    console.log(`[Relayer Gas Fund] Checking relayer balance: ${ethers.formatEther(relayerBalance)} ETH`);
    
    // Threshold: 0.002 ETH. If below, fund.
    if (relayerBalance < ethers.parseEther("0.002")) {
      const merchantAddress = merchantSigner.address;
      const merchantBalance = await provider.getBalance(merchantAddress);
      console.log(`[Relayer Gas Fund] Merchant balance: ${ethers.formatEther(merchantBalance)} ETH`);
      
      const fundAmount = ethers.parseEther("0.004");
      if (merchantBalance > fundAmount + ethers.parseEther("0.001")) {
        console.log(`[Relayer Gas Fund] Funding relayer with 0.004 ETH...`);
        const tx = await merchantSigner.sendTransaction({
          to: relayerAddress,
          value: fundAmount
        });
        await tx.wait();
        relayerBalance = await provider.getBalance(relayerAddress);
        console.log(`[Relayer Gas Fund] Funding tx confirmed: ${tx.hash}. New relayer balance: ${ethers.formatEther(relayerBalance)} ETH`);
      } else {
        console.warn(`[Relayer Gas Fund] Merchant balance is too low to fund relayer`);
      }
    }

    // Ensure the relayer has approved the Marketplace contract to spend its USDC
    const currentAllowance = await usdc.allowance(relayerAddress, addresses.Marketplace);
    console.log(`[Relayer Gas Fund] Checking relayer USDC allowance: ${ethers.formatUnits(currentAllowance, 6)} USDC`);
    if (currentAllowance < ethers.parseUnits("1000000.00", 6)) {
      console.log(`[Relayer Gas Fund] Relayer USDC allowance too low. Approving Marketplace...`);
      const approveTx = await sendRelayerTx((opts) => usdcWithRelayer.approve(addresses.Marketplace, ethers.MaxUint256, opts));
      await approveTx.wait();
      console.log(`[Relayer Gas Fund] USDC approval tx confirmed: ${approveTx.hash}`);
    }
  } catch (err: any) {
    console.error(`[Relayer Gas Fund] Error checking/funding/approving relayer:`, err.message || err);
  }
};

/**
 * Helper to execute relayer transactions with automatic pending nonce recovery on nonce collisions.
 */
export async function sendRelayerTx(txFunc: (options?: { nonce?: number }) => Promise<any>): Promise<any> {
  try {
    return await txFunc();
  } catch (err: any) {
    if ((err?.code === "NONCE_EXPIRED" || String(err?.message || "").includes("nonce")) && relayerSigner?.provider) {
      console.warn(`[Relayer Tx Sync] Nonce collision detected, retrying with fresh pending nonce...`);
      const freshNonce = await relayerSigner.provider.getTransactionCount(relayerSigner.address, "pending");
      return await txFunc({ nonce: freshNonce });
    }
    throw err;
  }
}

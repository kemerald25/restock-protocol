import * as dotenv from "dotenv";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

// @ts-ignore
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createX402PaymentHeader, X402Signer } from "./x402-helper";

// Initialize environment variables
dotenv.config();

const DEPLOYMENT_PATH = path.join(__dirname, "../contracts/deployments/base-sepolia.json");

if (!fs.existsSync(DEPLOYMENT_PATH)) {
  console.error(`[Demo Setup] Error: Deployment file not found at ${DEPLOYMENT_PATH}. Run 'npm run deploy' in contracts first.`);
  process.exit(1);
}

const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"));
const backendUrl = process.env.BACKEND_API_URL || "http://localhost:3000";
const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const buyerApiKey = process.env.DEMO_BUYER_API_KEY || process.env.BUYER_API_KEY;

const loadABI = (contractName: string) => {
  const artifactPath = path.join(__dirname, `../contracts/artifacts/contracts/${contractName}.sol/${contractName}.json`);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Contract artifact not found at: ${artifactPath}. Please compile the contracts first.`);
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8")).abi;
};

class RetryingJsonRpcProvider extends ethers.JsonRpcProvider {
  async send(method: string, params: Array<any> | Record<string, any>): Promise<any> {
    let attempts = 0;
    const maxAttempts = 5;
    let delay = 1000;
    while (attempts < maxAttempts) {
      try {
        return await super.send(method, params);
      } catch (error: any) {
        attempts++;
        const isTransient = 
          error.message?.includes("ECONNRESET") ||
          error.message?.includes("ETIMEDOUT") ||
          error.message?.includes("socket hang up") ||
          error.message?.includes("network") ||
          error.message?.includes("rate limit") ||
          error.message?.includes("429") ||
          error.message?.includes("ENOTFOUND") ||
          error.code === "TIMEOUT" ||
          error.code === "SERVER_ERROR";
        
        if (isTransient && attempts < maxAttempts) {
          console.warn(`[RetryingJsonRpcProvider] Transient error on ${method} (attempt ${attempts}/${maxAttempts}): ${error.message}. Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2;
        } else {
          throw error;
        }
      }
    }
  }
}

async function main() {
  console.log("==================================================================");
  console.log("             RESTOCK PROTOCOL - AUTONOMOUS AGENT DEMO             ");
  console.log("==================================================================\n");

  // 1. Setup provider and wallet
  const provider = new RetryingJsonRpcProvider(rpcUrl);
  const privateKey = process.env.Private_Key || process.env.DEMO_AGENT_PRIVATE_KEY;

  let wallet: any;
  if (!privateKey) {
    console.log("[Demo Setup] No private key found in .env. Generating a fresh one...");
    wallet = ethers.Wallet.createRandom(provider);
    console.log(`[Demo Setup] Generated wallet address: ${wallet.address}`);
    console.log(`[Demo Setup] Private Key: ${wallet.privateKey}`);
    console.log("\n> IMPORTANT: Please fund this wallet with some testnet ETH and testnet USDC on Base Sepolia, then set it in your .env file.");
    console.log("> Faucets:");
    console.log("  - ETH Faucet: https://faucet.coinbase.com/ (Base Sepolia)");
    console.log("  - USDC Faucet: https://faucet.circle.com/ (Select Base Sepolia)");
    process.exit(0);
  } else {
    wallet = new ethers.Wallet(privateKey, provider);
    console.log(`[Demo Setup] Wallet loaded: ${wallet.address}`);
  }

  // 2. Perform balance checks
  console.log("\n[Demo Setup] Performing pre-flight balance checks...");
  const ethBalance = await provider.getBalance(wallet.address);
  console.log(`- ETH Balance: ${ethers.formatEther(ethBalance)} ETH`);

  if (ethBalance < ethers.parseEther("0.001")) {
    console.error("\n[Demo Setup] Error: Insufficient ETH balance (Need at least 0.001 ETH for gas).");
    console.error("Please fund your wallet from the Coinbase Faucet: https://faucet.coinbase.com/");
    process.exit(1);
  }

  const usdcABI = [
    "function balanceOf(address account) external view returns (uint256)",
    "function decimals() external view returns (uint8)"
  ];
  const usdcContract = new ethers.Contract(deployment.USDC, usdcABI, provider);
  const usdcBalance = await usdcContract.balanceOf(wallet.address);
  const usdcDecimals = await usdcContract.decimals();
  console.log(`- USDC Balance: ${ethers.formatUnits(usdcBalance, usdcDecimals)} USDC`);

  if (usdcBalance < 10000n) { // Less than 0.01 USDC
    console.error("\n[Demo Setup] Error: Insufficient USDC balance (Need at least 0.01 USDC to complete purchases).");
    console.error("Please obtain testnet USDC from Circle Faucet: https://faucet.circle.com/ (Base Sepolia).");
    process.exit(1);
  }

  console.log("Pre-flight checks passed successfully! Starting purchasing agent...\n");

  // 3. Step 1: Discover inventory
  console.log("[1/4] Discovering available inventory from Restock Protocol Backend...");
  const skusRes = await fetch(`${backendUrl}/skus`);
  if (!skusRes.ok) {
    throw new Error(`Failed to fetch SKUs: ${skusRes.statusText}`);
  }
  const { results }: { results: any[] } = await skusRes.json();
  console.log(`Found ${results.length} total tokenized SKUs.`);

  const availableSku = results.find(s => s.lowestListingPrice !== null) || results.find(s => s.availableUnits > 0);
  if (!availableSku) {
    console.error("\n[Error] No available SKUs with active listings found. Please create a listing in the backend first.");
    process.exit(1);
  }

  console.log(`Selected Available SKU:`);
  console.log(`  - SKU ID: ${availableSku.skuId}`);
  console.log(`  - Name:   ${availableSku.name}`);
  console.log(`  - Price:  ${availableSku.lowestListingPrice} USDC`);
  console.log(`  - stock:  ${availableSku.availableUnits} units available`);

  // 4. Fetch the listings for this SKU to find listingId
  let listings: any[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const listingsRes = await fetch(`${backendUrl}/skus/${availableSku.skuId}/listings`);
    if (listingsRes.ok) {
      const data = await listingsRes.json();
      listings = data.listings || [];
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const activeListing = listings.find(l => l.quantity > 0 && l.status === "Open");

  if (!activeListing) {
    console.error("\n[Error] Failed to resolve active listings for target SKU.");
    process.exit(1);
  }

  console.log(`Resolved active Listing ID #${activeListing.listingId} from merchant/seller: ${activeListing.seller}`);

  // 5. Step 2: Create a reservation
  console.log(`\n[2/4] Creating on-chain inventory reservation via Backend...`);
  const reserveHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (buyerApiKey) {
    reserveHeaders["Authorization"] = `Bearer ${buyerApiKey}`;
  }
  const reserveRes = await fetch(`${backendUrl}/listings/${activeListing.listingId}/reserve`, {
    method: "POST",
    headers: reserveHeaders,
    body: JSON.stringify({
      buyer: wallet.address,
      quantity: 1
    })
  });

  if (!reserveRes.ok) {
    const errText = await reserveRes.text();
    throw new Error(`Reservation failed: ${errText}`);
  }

  const reservation = await reserveRes.json();
  console.log(`Reservation successfully created!`);
  console.log(`  - Reservation ID: ${reservation.reservationId}`);
  console.log(`  - Total Due:      ${reservation.totalDue} USDC`);
  console.log(`  - Status:          ${reservation.status}`);
  console.log(`  - Expires At:      ${new Date(reservation.expiresAt * 1000).toLocaleString()}`);

  // 6. Step 3: Trigger payment challenge and sign EIP-3009 authorization
  console.log(`\n[3/4] Initiating payment request to trigger x402 challenge...`);
  const challengeHeaders: Record<string, string> = {};
  if (buyerApiKey) {
    challengeHeaders["Authorization"] = `Bearer ${buyerApiKey}`;
  }
  const payChallengeRes = await fetch(`${backendUrl}/reservations/${reservation.reservationId}/pay`, {
    method: "POST",
    headers: challengeHeaders
  });

  if (payChallengeRes.status !== 402) {
    throw new Error(`Expected 402 Payment Required challenge, received status ${payChallengeRes.status}`);
  }

  const challengeHeader = payChallengeRes.headers.get("payment-required");
  if (!challengeHeader) {
    throw new Error("Missing 'payment-required' challenge header in 402 response");
  }

  console.log(`Received 402 Payment Required HTTP challenge.`);
  const paymentRequired = decodePaymentRequiredHeader(challengeHeader);

  console.log(`Signing EIP-3009 Transfer Authorization via EIP-712 signature...`);
  
  const clientSigner: X402Signer = {
    address: wallet.address.toLowerCase() as `0x${string}`,
    signTypedData: async (typedData: any) => {
      // Ethers expects us to delete EIP712Domain from types when signing
      const cleanTypes = { ...typedData.types };
      delete cleanTypes.EIP712Domain;
      const sig = await wallet.signTypedData(
        typedData.domain,
        cleanTypes,
        typedData.message
      );
      return sig as `0x${string}`;
    },
    readContract: async (args: any) => {
      const c = new ethers.Contract(args.address, args.abi, wallet);
      const val = await c[args.functionName](...args.args);
      return val;
    }
  };

  const paymentSigHeader = await createX402PaymentHeader(paymentRequired, clientSigner);
  console.log("EIP-712 EIP-3009 Transfer Authorization signed successfully.");

  // 7. Step 4: Submit signature and settle
  console.log(`\n[4/4] Submitting EIP-3009 payment signature back to Backend for settlement...`);
  const paySubmitHeaders: Record<string, string> = { "payment-signature": paymentSigHeader };
  if (buyerApiKey) {
    paySubmitHeaders["Authorization"] = `Bearer ${buyerApiKey}`;
  }
  const paySubmitRes = await fetch(`${backendUrl}/reservations/${reservation.reservationId}/pay`, {
    method: "POST",
    headers: paySubmitHeaders
  });

  if (!paySubmitRes.ok) {
    const errText = await paySubmitRes.text();
    throw new Error(`Payment submission failed: ${errText}`);
  }

  const result = await paySubmitRes.json();
  console.log(`\n==================================================================`);
  console.log(`                  PURCHASE COMPLETED SUCCESSFULLY                 `);
  console.log(`==================================================================`);
  console.log(`  - Reservation Status:   ${result.status}`);
  console.log(`  - Payment Tx Hash:      ${result.paymentTxHash}`);
  console.log(`  - Fulfillment Tx Hash:  ${result.fulfillmentTxHash}`);
  console.log(`  - Delivery Tx Hash:     ${result.deliveryTxHash}`);

  // 8. Confirm on-chain ClaimToken balance increase
  console.log(`\nVerifying ClaimToken balance on-chain...`);
  try {
    const claimTokenABI = loadABI("ClaimToken");
    const claimTokenContract = new ethers.Contract(deployment.ClaimToken, claimTokenABI, provider);
    
    let finalBalance = 0n;
    let balanceSynced = false;
    for (let i = 0; i < 15; i++) {
      finalBalance = await claimTokenContract.balanceOf(wallet.address, availableSku.skuId);
      if (finalBalance > 0n) {
        balanceSynced = true;
        break;
      }
      console.log(`  Balance not yet synced on RPC, retrying in 2s...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (balanceSynced) {
      console.log(`Autonomous agent final ClaimToken balance for SKU #${availableSku.skuId}: ${finalBalance.toString()} unit(s)`);
    } else {
      console.warn(`[Warning] ClaimToken balance did not sync on RPC within 30s. Current balance: ${finalBalance.toString()} unit(s)`);
    }
  } catch (err: any) {
    console.warn(`[Warning] Could not verify final balance on-chain due to RPC latency/timeout: ${err.message || err}`);
  }
  console.log("==================================================================\n");
}

main().catch((error) => {
  console.error("\n[Execution Error]:", error.message || error);
  process.exit(1);
});

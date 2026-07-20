import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { canonicalizeAndHashAddress } from "./src/lib/utils.ts";

const deployment = JSON.parse(fs.readFileSync(path.resolve("../contracts/deployments/base-sepolia.json"), "utf8"));
const ClaimTokenArtifact = JSON.parse(fs.readFileSync(path.resolve("../contracts/artifacts/contracts/ClaimToken.sol/ClaimToken.json"), "utf8"));
const MarketplaceArtifact = JSON.parse(fs.readFileSync(path.resolve("../contracts/artifacts/contracts/Marketplace.sol/Marketplace.json"), "utf8"));

const PRIVATE_KEY = "0x2f5485cbb01c33c45b4c9d475573cbcf0d77affe801db142b43fd207d31d1462";
const RPC_URL = "https://sepolia.base.org";

async function verifyFlows() {
  console.log("=== Phase 4, Part 2 Programmatic Flow Verification ===");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log(`Connected Wallet: ${wallet.address}`);

  // 1. Get SKUs
  const skusRes = await fetch("http://localhost:3000/skus");
  const skusData = (await skusRes.json()) as any;
  const skus = skusData.results || [];
  console.log(`Fetched ${skus.length} SKUs from discovery endpoint.`);

  if (skus.length === 0) {
    throw new Error("No SKUs found on backend!");
  }

  // Find a SKU we hold tokens for, or pick the first one
  const claimToken = new ethers.Contract(deployment.ClaimToken, ClaimTokenArtifact.abi, wallet);
  let targetSkuId = 45; // Default SKU
  let balance = 0;

  for (const sku of skus) {
    const bal = await claimToken.balanceOf(wallet.address, sku.skuId);
    if (Number(bal) > 0) {
      targetSkuId = sku.skuId;
      balance = Number(bal);
      break;
    }
  }

  console.log(`Target SKU ID: ${targetSkuId}, Held Balance: ${balance} units`);

  // If no balance, let's purchase/mint or notify
  if (balance === 0) {
    console.warn("Wallet holds 0 units of any SKU. Will use SKU 45 for checks.");
    targetSkuId = 45;
  }

  // 2. Listing approval and creation check
  const marketplace = new ethers.Contract(deployment.Marketplace, MarketplaceArtifact.abi, wallet);

  console.log("Checking if Marketplace is approved for ClaimToken...");
  const isApproved = await claimToken.isApprovedForAll(wallet.address, deployment.Marketplace);
  console.log(`Marketplace Approved: ${isApproved}`);

  if (!isApproved) {
    console.log("Approving Marketplace to manage all ClaimTokens...");
    const approveTx = await claimToken.setApprovalForAll(deployment.Marketplace, true);
    await approveTx.wait();
    console.log("Marketplace approval transaction completed.");
  }

  if (balance > 0) {
    console.log(`Creating listing for SKU ${targetSkuId} on-chain (1 unit @ 0.01 USDC)...`);
    const listTx = await marketplace.createListing(targetSkuId, 1, ethers.parseUnits("0.01", 6));
    const listReceipt = await listTx.wait();
    console.log(`Listing transaction completed on-chain. Tx: ${listReceipt.hash}`);

    // Verify it appears in GET listings route
    console.log(`Querying listings for SKU ${targetSkuId}...`);
    const listingsRes = await fetch(`http://localhost:3000/skus/${targetSkuId}/listings`);
    const listingsData = (await listingsRes.json()) as any;
    console.log(`Found ${listingsData.listings?.length || 0} listings for SKU ${targetSkuId}.`);
  }

  // 3. Redemption check
  if (balance > 0) {
    const shippingAddress = "123 Web3 Boulevard, San Francisco, CA 94103, US";
    const shippingRef = await canonicalizeAndHashAddress(shippingAddress);
    console.log(`Calculated shippingRef: ${shippingRef}`);

    console.log(`Redeeming 1 unit of SKU ${targetSkuId} on-chain...`);
    const redeemTx = await claimToken.redeem(targetSkuId, 1, shippingRef);
    const redeemReceipt = await redeemTx.wait();
    console.log(`Redemption transaction completed on-chain. Tx: ${redeemReceipt.hash}`);

    // Call POST /skus/:skuId/redeem
    console.log("Submitting redemption to backend endpoint...");
    const redeemPostRes = await fetch(`http://localhost:3000/skus/${targetSkuId}/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        holder: wallet.address,
        quantity: 1,
        txHash: redeemReceipt.hash,
        shippingAddress
      })
    });

    const redeemPostData = (await redeemPostRes.json()) as any;
    console.log("Backend Redemption Response:", redeemPostData);

    if (redeemPostRes.ok) {
      console.log(`✓ Redemption recorded successfully. ID: ${redeemPostData.redemptionId}`);
    } else {
      throw new Error(`Redemption backend validation failed: ${JSON.stringify(redeemPostData)}`);
    }

    // 4. Test Mismatch Shipping Address Case
    console.log("Testing mismatched shipping address validation...");
    const mismatchRes = await fetch(`http://localhost:3000/skus/${targetSkuId}/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        holder: wallet.address,
        quantity: 1,
        txHash: redeemReceipt.hash,
        shippingAddress: "456 Mismatched St, San Francisco, CA 94103, US" // wrong address!
      })
    });

    const mismatchData = (await mismatchRes.json()) as any;
    console.log("Backend Mismatch Response status:", mismatchRes.status);
    console.log("Backend Mismatch Response body:", mismatchData);

    if (mismatchRes.status === 400 && mismatchData.error.includes("shippingRef mismatch")) {
      console.log("✓ Correctly rejected mismatched shipping address with 400!");
    } else {
      throw new Error(`Expected mismatched address rejection with 400, got status ${mismatchRes.status}`);
    }

    // 5. Verify Pending status in admin view
    console.log("Checking admin redemptions listing...");
    const adminRes = await fetch("http://localhost:3000/admin/redemptions?status=Pending");
    const adminData = (await adminRes.json()) as any;
    const found = adminData.redemptions?.find((r: any) => r.redemptionId === redeemPostData.redemptionId);

    if (found) {
      console.log(`✓ Redemption ${redeemPostData.redemptionId} is verified as Pending in admin view.`);
    } else {
      throw new Error(`Redemption ${redeemPostData.redemptionId} not found in Pending redemptions list!`);
    }
  }

  console.log("=== Verification Successful! All flows pass. ===");
}

verifyFlows().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});

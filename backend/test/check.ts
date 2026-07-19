import { provider, skuRegistry, claimToken, merchantSigner } from "../src/lib/contracts";
import { ethers } from "ethers";

async function main() {
  const merchantAddr = await merchantSigner.getAddress();
  console.log("Merchant address:", merchantAddr);
  
  const registryAddr = await skuRegistry.getAddress();
  const claimTokenAddr = await claimToken.getAddress();
  console.log("Registry address:", registryAddr);
  console.log("ClaimToken address:", claimTokenAddr);

  const claimTokenRegistry = await claimToken.skuRegistry();
  console.log("Registry address registered in ClaimToken:", claimTokenRegistry);

  // Let's query getSKU for SKU 1
  try {
    const sku1 = await skuRegistry.getSKU(1n);
    console.log("SKU 1 Info:", {
      merchant: sku1.merchant,
      maxSupply: sku1.maxSupply.toString(),
      mintedSupply: sku1.mintedSupply.toString(),
      basisValue: sku1.basisValue.toString()
    });
  } catch (err: any) {
    console.error("Error fetching SKU 1:", err.message);
  }

  // Let's check merchant's balance of SKU 1
  const bal = await claimToken.balanceOf(merchantAddr, 1n);
  console.log("Merchant balance of SKU 1:", bal.toString());
}

main().catch(console.error);

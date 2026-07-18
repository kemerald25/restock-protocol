import { skuRegistry, marketplace, provider } from "./contracts";
import { SKU_METADATA } from "../config";

export interface SKUDetails {
  skuId: string;
  name: string;
  variant: string;
  category: string;
  merchant: string;
  maxSupply: number;
  mintedSupply: number;
  redeemedSupply: number;
  availableUnits: number;
  basisValue: string;
  lowestListingPrice: string | null;
  royaltyBps: number;
  metadataURI: string;
}

export interface ListingDetails {
  listingId: number;
  skuId: string;
  seller: string;
  quantity: number;
  pricePerUnit: string;
  status: "Open" | "Filled" | "Cancelled";
  createdAt: number;
}

const blockTimestamps: Record<number, number> = {};

export const getBlockTimestamp = async (blockNumber: number): Promise<number> => {
  if (blockTimestamps[blockNumber]) return blockTimestamps[blockNumber];
  try {
    const block = await provider.getBlock(blockNumber);
    const ts = block ? block.timestamp : Math.floor(Date.now() / 1000);
    blockTimestamps[blockNumber] = ts;
    return ts;
  } catch (err) {
    return Math.floor(Date.now() / 1000);
  }
};

/**
 * Safe query filter that handles RPC block range limitations.
 * Tries a larger block range (last 100k blocks ~2 days) first,
 * and falls back to a smaller block range (last 1900 blocks) if the RPC complains.
 */
export const querySafeFilter = async (contract: any, filter: any): Promise<any[]> => {
  try {
    // Try last 100,000 blocks (~2.3 days on Base Sepolia)
    return await contract.queryFilter(filter, -100000);
  } catch (err: any) {
    try {
      // Fallback to last 1900 blocks to comply with strict 2000 range limits
      return await contract.queryFilter(filter, -1900);
    } catch (innerErr) {
      console.error("[querySafeFilter Error]:", innerErr);
      return [];
    }
  }
};

export const getListingActiveReservations = async (listingId: number): Promise<bigint> => {
  const currentTimestamp = Math.floor(Date.now() / 1000);
  
  // Find all Reserved events for this listingId
  const filter = marketplace.filters.Reserved(null, listingId);
  const events = await querySafeFilter(marketplace, filter);
  
  let reservedQty = 0n;
  
  const reservations = await Promise.all(
    events.map(async (e: any) => {
      const resId = e.args[0];
      try {
        return await marketplace.getReservation(resId);
      } catch (err) {
        return null;
      }
    })
  );
  
  for (const r of reservations) {
    if (r && r.status === 0n && r.expiresAt > BigInt(currentTimestamp)) {
      reservedQty += r.quantity;
    }
  }
  
  return reservedQty;
};

export const getOpenListingsForSKU = async (skuId: bigint): Promise<ListingDetails[]> => {
  // Find all Listed events for this skuId
  const filter = marketplace.filters.Listed(null, skuId);
  const events = await querySafeFilter(marketplace, filter);
  
  // Map listing IDs and track their creation blocks
  const listingBlocks: Record<number, number> = {};
  events.forEach((e: any) => {
    listingBlocks[Number(e.args[0])] = e.blockNumber;
  });
  
  const listingIds = [...new Set(events.map((e: any) => Number(e.args[0])))] as number[];
  
  // Fetch current listing states in parallel
  const listingsData = await Promise.all(
    listingIds.map(async (id: number) => {
      try {
        const listing = await marketplace.getListing(id);
        const reservedQty = await getListingActiveReservations(id);
        const unreservedQty = listing.quantity - reservedQty;
        const createdAt = await getBlockTimestamp(listingBlocks[id]);
        
        return {
          listingId: id,
          skuId: listing.skuId.toString(),
          seller: listing.seller,
          quantity: Number(unreservedQty > 0n ? unreservedQty : 0n),
          pricePerUnit: (Number(listing.pricePerUnit) / 1000000).toFixed(2),
          status: Number(listing.status), // 0=Open, 1=Filled, 2=Cancelled
          createdAt
        };
      } catch (err) {
        return null;
      }
    })
  );
  
  // Filter for status = Open (0) and quantity > 0
  const openListings = listingsData
    .filter((l): l is NonNullable<typeof l> => l !== null && l.status === 0 && l.quantity > 0)
    .map(l => ({
      listingId: l.listingId,
      skuId: l.skuId,
      seller: l.seller,
      quantity: l.quantity,
      pricePerUnit: l.pricePerUnit,
      status: "Open" as const,
      createdAt: l.createdAt
    }));

  return openListings;
};

export const getSKUs = async (): Promise<SKUDetails[]> => {
  let skuId = 1n;
  const skus: SKUDetails[] = [];
  
  while (true) {
    try {
      const sku = await skuRegistry.getSKU(skuId);
      const listings = await getOpenListingsForSKU(skuId);
      
      const availableUnits = listings.reduce((sum, l) => sum + l.quantity, 0);
      let lowestListingPrice: string | null = null;
      
      if (listings.length > 0) {
        const prices = listings.map(l => parseFloat(l.pricePerUnit));
        lowestListingPrice = Math.min(...prices).toFixed(2);
      }
      
      const metadata = SKU_METADATA[skuId.toString()] || {
        name: `SKU #${skuId}`,
        variant: "Default",
        category: "uncategorized",
      };
      
      skus.push({
        skuId: skuId.toString(),
        name: metadata.name,
        variant: metadata.variant,
        category: metadata.category,
        merchant: sku.merchant,
        maxSupply: Number(sku.maxSupply),
        mintedSupply: Number(sku.mintedSupply),
        redeemedSupply: Number(sku.redeemedSupply),
        availableUnits,
        basisValue: (Number(sku.basisValue) / 1000000).toFixed(2),
        lowestListingPrice,
        royaltyBps: Number(sku.royaltyBps),
        metadataURI: sku.metadataURI,
      });
      
      skuId++;
    } catch (err) {
      // Revert indicates end of SKUs
      break;
    }
  }
  
  return skus;
};

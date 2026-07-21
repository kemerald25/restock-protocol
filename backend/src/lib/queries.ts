import { skuRegistry, marketplace, provider, deployment } from "./contracts";
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
 * Queries from deployment block number to minimize request size and avoid timeouts.
 */
export const querySafeFilter = async (contract: any, filter: any): Promise<any[]> => {
  try {
    return await contract.queryFilter(filter, -1900);
  } catch (err: any) {
    console.error("[querySafeFilter Error]:", err.message || err);
    return [];
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
      } catch (err: any) {
        console.error(`[queries.ts] Error resolving listing details for ID ${id}:`, err.message || err);
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
  const skus: SKUDetails[] = [];
  let currentId = 1n;
  const batchSize = 10;
  let hitEnd = false;

  while (!hitEnd) {
    const ids = Array.from({ length: batchSize }, (_, i) => currentId + BigInt(i));
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const sku = await skuRegistry.getSKU(id);
          if (sku && sku.merchant !== "0x0000000000000000000000000000000000000000") {
            return { id, sku };
          }
          return null;
        } catch (err: any) {
          // If the SKU does not exist, we have reached the end of the registry
          if (err.message && err.message.includes("SKU does not exist")) {
            hitEnd = true;
          }
          return null;
        }
      })
    );

    for (const r of results) {
      if (!r) continue;
      const { id: skuId, sku } = r;

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
        availableUnits: 1, // Default fallback
        basisValue: (Number(sku.basisValue) / 1000000).toFixed(2),
        lowestListingPrice: null,
        royaltyBps: Number(sku.royaltyBps),
        metadataURI: sku.metadataURI,
      });
    }

    if (results.some((r) => r === null && hitEnd)) {
      break;
    }

    currentId += BigInt(batchSize);
  }

  // Synchronously enrich availableUnits & lowestListingPrice
  await Promise.all(
    skus.map(async (sku) => {
      try {
        const listings = await getOpenListingsForSKU(BigInt(sku.skuId));
        sku.availableUnits = listings.reduce((sum, l) => sum + l.quantity, 0);
        if (listings.length > 0) {
          const prices = listings.map((l) => parseFloat(l.pricePerUnit));
          sku.lowestListingPrice = Math.min(...prices).toFixed(2);
        }
      } catch (e) {}
    })
  );

  return skus;
};

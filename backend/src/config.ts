/**
 * MOCK SKU SEED DATA / CONFIGURATION
 * 
 * IMPORTANT NOTE: This configuration must be kept in sync manually with the
 * smart contract tests mock SKU configuration (located in contracts/test/invariants.test.ts).
 * We are intentionally not building a shared config package for this single-SKU MVP.
 */
export const MOCK_SKU_CONFIG = {
  skuId: "1",
  name: "Restock Protocol Demo Sneaker — Model RS-01, Black/White, Size 10",
  variant: "Size 10",
  merchant: "0xMerchantAddressPlaceholder",
  maxSupply: 25,
  mintedSupply: 25,
  redeemedSupply: 3,
  availableUnits: 14,
  royaltyBps: 300, // 3%
  basisValue: "150.00",
  lowestListingPrice: "162.00",
  metadataURI: "ipfs://.../dunk-low-black-10.json",
  reservationTTL: 120, // 120 seconds
};

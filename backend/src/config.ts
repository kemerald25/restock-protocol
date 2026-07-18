/**
 * SKU METADATA & CONFIGURATION
 */
export const SKU_METADATA: Record<
  string,
  { name: string; variant: string; category: string }
> = {
  "1": {
    name: "Restock Protocol Demo Sneaker — Model RS-01, Black/White, Size 10",
    variant: "Size 10",
    category: "sneakers",
  },
};

export const MOCK_SKU_CONFIG = {
  skuId: "1",
  name: "Restock Protocol Demo Sneaker — Model RS-01, Black/White, Size 10",
  variant: "Size 10",
  merchant: "0x345924F66825794e424f9B402756d7015a8dC12E", // Live Base Sepolia merchant (deployer)
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

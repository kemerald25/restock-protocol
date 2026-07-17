export enum SKUStatus {
  Active = 0,
  Paused = 1,
  Deprecated = 2
}

export interface SKU {
  skuId: string; // Unique identifier, immutable once created
  merchant: string; // Wallet address of SKU owner receiving royalties
  name: string; // Offchain metadata, e.g. "Restock Protocol Demo Sneaker"
  variant: string; // Offchain metadata, e.g. "Size 10"
  maxSupply: number; // Hard, immutable cap
  mintedSupply: number; // Running count of units minted so far (<= maxSupply)
  redeemedSupply: number; // Running count of burned units
  royaltyBps: number; // Royalty in basis points (e.g. 300 = 3%)
  basisValue: string; // Reference real-world price in stablecoin unit representation
  metadataURI: string; // Points to offchain JSON metadata (images, description, spec)
  status: SKUStatus; // Controlling state
}

export enum ListingStatus {
  Open = 0,
  Filled = 1,
  Cancelled = 2
}

export interface Listing {
  listingId: number; // Auto-incremented onchain/database ID
  skuId: string; // SKU identifier
  seller: string; // Address of current token holder listing the item
  quantity: number; // Quantity available
  pricePerUnit: string; // Price in stablecoin unit representation
  status: ListingStatus; // State of listing
  createdAt: number; // Timestamp
}

export enum ReservationStatus {
  Active = 0,
  Completed = 1,
  Expired = 2,
  Cancelled = 3
}

export interface Reservation {
  reservationId: number; // Auto-incremented ID
  listingId: number; // Listing being reserved
  buyer: string; // Address of locking buyer
  quantity: number; // Reserved quantity
  expiresAt: number; // Expiration timestamp (hard TTL e.g. +120s)
  status: ReservationStatus; // State of lock
}

export enum FulfillmentStatus {
  Pending = 0,
  Shipped = 1,
  Delivered = 2,
  Disputed = 3
}

export interface RedemptionRequest {
  redemptionId: number; // Auto-incremented ID
  skuId: string; // SKU identifier
  holder: string; // Address of redeemer
  quantity: number; // Units burned
  shippingRef: string; // Offchain reference (hash/reference ID of shipping data)
  fulfillmentStatus: FulfillmentStatus; // Merchant fulfillment status
  createdAt: number; // Timestamp
}

/**
 * PRIVACY NOTE: Offchain database schema for shipping address.
 * Do not put real shipping addresses onchain. Real addresses are stored offchain,
 * mapped to the onchain `shippingRef` identifier.
 */
export interface OffchainShippingAddress {
  shippingRef: string; // Matches the RedemptionRequest.shippingRef
  fullName: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phoneNumber?: string;
  email?: string;
}

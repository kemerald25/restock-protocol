import * as fs from "fs";
import * as path from "path";
import { MerchantAccount, ApiKeyRecord, AuditLogEntry, BindingChallenge, PendingSkuRequest } from "../types";

const DB_DIR = path.join(__dirname, "../../data");
const DB_PATH = path.join(DB_DIR, "db.json");

export interface Redemption {
  redemptionId: string;
  skuId: string;
  holder: string;
  quantity: number;
  shippingRef: string;
  shippingAddressResolved: string; // Plain-text address
  fulfillmentStatus: "Pending" | "Shipped" | "Delivered" | "Disputed";
  txHash: string;
  createdAt: number;
}

export interface ReservationRecord {
  reservationId: string;
  listingId: number;
  buyer: string;
  quantity: number;
  status: "PENDING_SIGNATURE" | "SUBMITTED_PAYMENT" | "PAID" | "FULFILLED" | "DELIVERED" | "FAILED_REFUNDING" | "REFUNDED" | "FAILED_ESCALATED" | "REFUND_FAILED_ESCALATED";
  pricePerUnit: string;
  totalDue: string;
  expiresAt: number;
  paymentTxHash?: string;
  fulfillmentTxHash?: string;
  deliveryTxHash?: string;
  refundTxHash?: string;
  retryCount: number;
  lastError?: string;
  updatedAt: number;
}

export interface Database {
  redemptions: Record<string, Redemption>;
  shippingAddresses: Record<string, string>; // mapping from shippingRef -> shippingAddressResolved
  reservations: Record<string, ReservationRecord>;
  merchants: Record<string, MerchantAccount>;
  apiKeys: Record<string, ApiKeyRecord>;      // Keyed by hashedSecret
  auditLogs: AuditLogEntry[];
  bindingChallenges: Record<string, BindingChallenge>; // Keyed by nonce
  pendingSkuRequests: Record<string, PendingSkuRequest>; // Keyed by request id
  merchantSkus: Record<string, string[]>;    // Keyed by merchantId -> skuId array
  skuMetadata: Record<string, { name: string; variant: string; category: string }>;
}

const defaultDB: Database = {
  redemptions: {},
  shippingAddresses: {},
  reservations: {},
  merchants: {},
  apiKeys: {},
  auditLogs: [],
  bindingChallenges: {},
  pendingSkuRequests: {},
  merchantSkus: {},
  skuMetadata: {},
};

export const initDB = () => {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultDB, null, 2), "utf8");
  }
};

let memoryCache: Database | null = null;

export const readDB = (): Database => {
  if (memoryCache) {
    return memoryCache;
  }
  initDB();
  try {
    const data = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(data);
    if (!parsed.redemptions) parsed.redemptions = {};
    if (!parsed.shippingAddresses) parsed.shippingAddresses = {};
    if (!parsed.reservations) parsed.reservations = {};
    if (!parsed.merchants) parsed.merchants = {};
    if (!parsed.apiKeys) parsed.apiKeys = {};
    if (!parsed.auditLogs) parsed.auditLogs = [];
    if (!parsed.bindingChallenges) parsed.bindingChallenges = {};
    if (!parsed.pendingSkuRequests) parsed.pendingSkuRequests = {};
    if (!parsed.merchantSkus) parsed.merchantSkus = {};
    if (!parsed.skuMetadata) parsed.skuMetadata = {};
    memoryCache = parsed;
    return parsed;
  } catch (err) {
    memoryCache = defaultDB;
    return defaultDB;
  }
};

export const writeDB = (db: Database) => {
  memoryCache = db;
  initDB();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
};

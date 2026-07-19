import * as fs from "fs";
import * as path from "path";

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
}

const defaultDB: Database = {
  redemptions: {},
  shippingAddresses: {},
  reservations: {},
};

export const initDB = () => {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultDB, null, 2), "utf8");
  }
};

export const readDB = (): Database => {
  initDB();
  try {
    const data = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(data);
    if (!parsed.redemptions) parsed.redemptions = {};
    if (!parsed.shippingAddresses) parsed.shippingAddresses = {};
    if (!parsed.reservations) parsed.reservations = {};
    return parsed;
  } catch (err) {
    return defaultDB;
  }
};

export const writeDB = (db: Database) => {
  initDB();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
};

import * as crypto from "crypto";
import { readDB, writeDB } from "./db";
import { ApiKeyRecord, ApiKeyScope } from "../types";

/**
 * Computes the SHA-256 hash of an API key secret.
 * Plaintext secrets are never stored in the database.
 */
export function hashApiKey(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

/**
 * Creates a masked snippet of the secret for safe display (e.g. "rk_live_...a8F2").
 */
export function maskApiKey(secret: string): string {
  if (secret.length <= 12) return secret;
  return `${secret.substring(0, 8)}...${secret.slice(-4)}`;
}

export interface GenerateApiKeyOptions {
  ownerType: "MERCHANT" | "INTEGRATOR" | "ADMIN";
  ownerId: string;
  name: string;
  scopes: ApiKeyScope[];
  rateLimitTier?: "DEFAULT" | "ELEVATED" | "UNLIMITED";
  prefix?: "rk_live" | "rk_test";
  expiresAt?: number;
}

/**
 * Generates a new cryptographically secure API key.
 * Returns the raw plaintext secret EXACTLY ONCE alongside the saved record.
 */
export function generateApiKey(options: GenerateApiKeyOptions): { secret: string; record: ApiKeyRecord } {
  const prefix = options.prefix || "rk_live";
  const randomBytes = crypto.randomBytes(32).toString("hex");
  const secret = `${prefix}_${randomBytes}`;
  const hashedSecret = hashApiKey(secret);
  const maskedKey = maskApiKey(secret);
  const keyId = `key_${crypto.randomBytes(8).toString("hex")}`;
  const now = Math.floor(Date.now() / 1000);

  const record: ApiKeyRecord = {
    id: keyId,
    hashedSecret,
    maskedKey,
    ownerType: options.ownerType,
    ownerId: options.ownerId,
    name: options.name,
    scopes: options.scopes,
    status: "ACTIVE",
    rateLimitTier: options.rateLimitTier || "DEFAULT",
    createdAt: now,
    expiresAt: options.expiresAt,
  };

  const db = readDB();
  db.apiKeys[hashedSecret] = record;
  writeDB(db);

  return { secret, record };
}

/**
 * Looks up an API key by its raw secret string.
 * Returns the ApiKeyRecord if valid and active, or null otherwise.
 */
export function lookupApiKey(secret: string): ApiKeyRecord | null {
  if (!secret) return null;
  const hashedSecret = hashApiKey(secret);
  const db = readDB();
  const record = db.apiKeys[hashedSecret];

  if (!record) return null;
  if (record.status !== "ACTIVE") return null;
  if (record.expiresAt && record.expiresAt < Math.floor(Date.now() / 1000)) return null;

  return record;
}

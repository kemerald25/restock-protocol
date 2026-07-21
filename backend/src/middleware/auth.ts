import { Request, Response, NextFunction } from "express";
import { lookupApiKey } from "../lib/auth";
import { readDB, writeDB } from "../lib/db";
import { ApiKeyRecord, ApiKeyScope, MerchantAccount } from "../types";

// Extend Express Request interface to include authenticated key and merchant context
declare global {
  namespace Express {
    interface Request {
      apiKey?: ApiKeyRecord;
      merchant?: MerchantAccount;
    }
  }
}

/**
 * Express middleware that extracts Authorization: Bearer <key> header,
 * resolves it to an ApiKeyRecord, and attaches key/merchant context to the request.
 * If no header is provided, proceeds as unauthenticated (req.apiKey = undefined).
 * Rejects revoked, expired, or invalid keys with 401 UNAUTHORIZED.
 */
export function authenticateApiKey(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    // Unauthenticated request (permitted for public routes; requireScope will enforce where needed)
    return next();
  }

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "Missing or invalid API key in Authorization header."
      }
    });
  }

  const token = authHeader.substring(7).trim();
  const keyRecord = lookupApiKey(token);

  if (!keyRecord) {
    return res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "Missing or invalid API key in Authorization header."
      }
    });
  }

  // Update lastUsedAt timestamp in-memory and throttle disk writes
  const now = Math.floor(Date.now() / 1000);
  const previousLastUsed = keyRecord.lastUsedAt || 0;
  keyRecord.lastUsedAt = now;

  const db = readDB();
  if (now - previousLastUsed > 60) {
    if (db.apiKeys[keyRecord.hashedSecret]) {
      db.apiKeys[keyRecord.hashedSecret].lastUsedAt = now;
      writeDB(db);
    }
  }

  req.apiKey = keyRecord;

  if (keyRecord.ownerType === "MERCHANT" && keyRecord.ownerId) {
    req.merchant = db.merchants[keyRecord.ownerId];
  }

  next();
}

/**
 * Composable Express middleware to enforce that the request possesses a specific scope.
 * Rejects with 401 if unauthenticated, or 403 if key lacks the required scope.
 */
export function requireScope(requiredScope: ApiKeyScope) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.apiKey) {
      return res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Missing or invalid API key in Authorization header."
        }
      });
    }

    if (!req.apiKey.scopes.includes(requiredScope)) {
      return res.status(403).json({
        error: {
          code: "FORBIDDEN",
          message: `API key lacks required scope '${requiredScope}' for this endpoint.`
        }
      });
    }

    next();
  };
}

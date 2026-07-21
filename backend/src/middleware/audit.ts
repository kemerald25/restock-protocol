import { Request, Response, NextFunction } from "express";
import * as crypto from "crypto";
import { readDB, writeDB } from "../lib/db";
import { AuditLogEntry } from "../types";

/**
 * Global Express middleware that writes an AuditLogEntry to the database
 * for every authenticated API request upon completion.
 */
export function auditLogMiddleware(req: Request, res: Response, next: NextFunction) {
  const startTime = Date.now();

  res.on("finish", () => {
    // Only record audit log entries for authenticated requests
    if (!req.apiKey) {
      return;
    }

    const latencyMs = Date.now() - startTime;
    const now = Math.floor(Date.now() / 1000);
    const logId = `log_${crypto.randomBytes(8).toString("hex")}`;

    const logEntry: AuditLogEntry = {
      id: logId,
      timestamp: now,
      apiKeyId: req.apiKey.id,
      ownerId: req.apiKey.ownerId,
      route: req.originalUrl || req.url,
      method: req.method,
      statusCode: res.statusCode,
      ipAddress: req.ip || req.socket.remoteAddress || "unknown",
      userAgent: req.get("user-agent") || "unknown",
      latencyMs
    };

    try {
      const db = readDB();
      db.auditLogs.unshift(logEntry); // Keep newest logs first
      // Cap audit log stored in json db to last 10,000 entries
      if (db.auditLogs.length > 10000) {
        db.auditLogs = db.auditLogs.slice(0, 10000);
      }
      writeDB(db);
    } catch (err) {
      console.error("[Audit Log Error]: Failed to write audit log entry:", err);
    }
  });

  next();
}

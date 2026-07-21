import { Request, Response, NextFunction } from "express";

// Limitation: In-memory token bucket rate limiter resets on process restart and does not synchronize state across horizontally scaled multi-instance deployments. (Use Redis for multi-instance production environments).

interface RateLimitBucket {
  tokens: number;
  lastRefill: number;
}

const buckets: Map<string, RateLimitBucket> = new Map();
const WINDOW_MS = 60 * 1000; // 1 minute window

function getBucketKey(req: Request, isReserveRoute: boolean): string {
  const ip = req.ip || req.socket.remoteAddress || "unknown_ip";
  const keyIdentifier = req.apiKey?.id || `ip_${ip}`;
  return isReserveRoute ? `reserve:${keyIdentifier}` : `general:${keyIdentifier}`;
}

function getMaxTokens(req: Request, isReserveRoute: boolean): number {
  if (isReserveRoute) {
    // Relayer gas defense: Strict 10 req/min cap on reservation creations regardless of key tier
    return 10;
  }

  if (!req.apiKey) {
    // Unauthenticated public:read IP limit
    return 60;
  }

  switch (req.apiKey.rateLimitTier) {
    case "UNLIMITED":
      return Infinity;
    case "ELEVATED":
      return 300;
    case "DEFAULT":
    default:
      return 100;
  }
}

/**
 * Reset all rate limit buckets in memory (useful for test setup isolation).
 */
export function resetRateLimits() {
  buckets.clear();
}

/**
 * Token bucket rate limiting middleware enforcing tier-based capacity and strict relayer defenses.
 */
export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  // Check if target is the high-risk /listings/:listingId/reserve route
  const isReserveRoute = req.method === "POST" && /\/listings\/[^/]+\/reserve/.test(req.originalUrl);

  const maxTokens = getMaxTokens(req, isReserveRoute);
  if (maxTokens === Infinity) {
    return next();
  }

  const bucketKey = getBucketKey(req, isReserveRoute);
  const now = Date.now();

  let bucket = buckets.get(bucketKey);
  if (!bucket) {
    bucket = { tokens: maxTokens, lastRefill: now };
    buckets.set(bucketKey, bucket);
  } else {
    // Calculate elapsed time and refill tokens proportionally
    const elapsed = now - bucket.lastRefill;
    if (elapsed > 0) {
      const tokensToAdd = (elapsed / WINDOW_MS) * maxTokens;
      if (tokensToAdd >= 1) {
        bucket.tokens = Math.min(maxTokens, bucket.tokens + tokensToAdd);
        bucket.lastRefill = now;
      }
    }
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return next();
  }

  // Rate limit exceeded
  const retryAfterSeconds = Math.ceil((WINDOW_MS - (now - bucket.lastRefill)) / 1000);
  res.setHeader("Retry-After", String(retryAfterSeconds));

  return res.status(429).json({
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: `Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`,
      retryAfterSeconds
    }
  });
}

import crypto from "crypto";

/**
 * Shipping Address Canonicalization Spec:
 * 1. Must be a raw UTF-8 string (no structured object).
 * 2. Trim leading and trailing whitespace.
 * 3. Convert all characters to lowercase.
 * 4. Hash using SHA-256 to generate a hex-encoded string.
 * 5. Prefix with 'ref_' to create the final shippingRef value.
 */
export const canonicalizeAndHashAddress = (addressStr: string): string => {
  const canonical = addressStr.trim().toLowerCase();
  const hash = crypto.createHash("sha256").update(canonical).digest("hex");
  return `ref_${hash}`;
};

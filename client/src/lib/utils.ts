/**
 * Shipping Address Canonicalization Spec:
 * 1. Must be a raw UTF-8 string (no structured object).
 * 2. Trim leading and trailing whitespace.
 * 3. Convert all characters to lowercase.
 * 4. Hash using SHA-256 to generate a hex-encoded string.
 * 5. Prefix with 'ref_' to create the final shippingRef value.
 *
 * Browser Web Crypto implementation byte-identical to Node.js crypto.createHash("sha256").
 */
export const canonicalizeAndHashAddress = async (addressStr: string): Promise<string> => {
  const canonical = addressStr.trim().toLowerCase();
  const encoder = new TextEncoder();
  const data = encoder.encode(canonical);
  const webCrypto =
    typeof window !== "undefined" && window.crypto
      ? window.crypto
      : (globalThis as any).crypto;
  const hashBuffer = await webCrypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b: number) => b.toString(16).padStart(2, "0")).join("");
  return `ref_${hex}`;
};

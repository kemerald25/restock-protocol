export type VerificationStatus = "UNVERIFIED" | "PENDING_VERIFICATION" | "VERIFIED" | "SUSPENDED";
export type WalletRole = "PRIMARY_PAYOUT" | "LISTING_SIGNER" | "ADMIN_RECOVERY";
export type TrustTierLevel = "TIER_0_SANDBOX" | "TIER_1_STANDARD" | "TIER_2_ENTERPRISE";

export interface MerchantWallet {
  address: string;             // Checksummed canonical ETH address
  role: WalletRole;            // Role within merchant organization
  addedAt: number;             // Unix timestamp
  signatureProof: string;      // EIP-712 signature proving ownership during binding
}

export interface TrustTierConfig {
  tierLevel: TrustTierLevel;
  maxRoyaltyBps: number;      // Maximum allowed royalty percentage (e.g. 1000 = 10%)
  maxActiveSKUs: number;      // Maximum active listings/SKUs allowed
  requiresManualSKUApproval: boolean;
}

export interface MerchantAccount {
  id: string;                  // Prefix: mer_[alphanumeric16]
  legalName: string;           // Registered business or entity name
  contactEmail: string;        // Primary operational email
  verificationStatus: VerificationStatus;
  wallets: MerchantWallet[];    // Array of associated onchain wallets
  trustTier: TrustTierConfig;
  createdAt: number;
  updatedAt: number;
}

export type ApiKeyScope = 
  | "public:read"
  | "buyer:transact"
  | "merchant:read"
  | "merchant:write"
  | "merchant:keys:write"      // Privileged scope for key issuance/revocation
  | "admin:read"
  | "admin:write";

export interface ApiKeyRecord {
  id: string;                  // Public identifier (e.g. key_01HXYZ...)
  hashedSecret: string;        // SHA-256 hash of plaintext secret (never stored raw)
  maskedKey: string;           // Display snippet (e.g. "rk_live_...a8F2")
  ownerType: "MERCHANT" | "INTEGRATOR" | "ADMIN";
  ownerId: string;             // References MerchantAccount.id or System Admin ID
  name: string;                // Friendly label (e.g., "Production Frontend Key")
  scopes: ApiKeyScope[];       // Enforced permission list
  status: "ACTIVE" | "REVOKED";
  rateLimitTier: "DEFAULT" | "ELEVATED" | "UNLIMITED";
  createdAt: number;
  lastUsedAt?: number;
  expiresAt?: number;
}

export interface AuditLogEntry {
  id: string;                  // log_[alphanumeric16]
  timestamp: number;
  apiKeyId: string;
  ownerId: string;
  route: string;
  method: string;
  statusCode: number;
  ipAddress: string;
  userAgent: string;
  latencyMs: number;
}

export interface BindingChallenge {
  merchantId: string;
  walletAddress: string;
  nonce: string;              // uint256 string
  deadline: number;           // Unix timestamp (5 min from issuance)
  consumed: boolean;
  createdAt: number;
}

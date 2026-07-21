# Specification: Platform Identity, API Key Authentication & Rate Limiting (Phase 5, Part 0)

## Executive Summary

The Restock Protocol core mechanism (tokenization, marketplace listings, EIP-3009 x402 payment settlement, reconciliation, dynamic basis values, and redemption tracking) is fully operational on Base Sepolia. However, the platform currently lacks an identity and access control layer:
1. **Merchant identity is raw wallet address**: SKUs and listings onchain belong directly to an Ethereum wallet (`address merchant`), without business metadata, multi-wallet management, key rotation, or trust tier controls.
2. **Unprotected API endpoints**: Every API route—including administrative actions (`/admin/skus/:skuId/basis-value`, `/admin/redemptions/:id/mark-shipped`) and relayer-funded actions (`/listings/:listingId/reserve`)—is currently accessible without authentication or rate limits.

This design specification establishes a **production-caliber platform layer** wrapped around the existing, un-modified onchain contracts.

---

## 1. Architecture Choice & Onchain Integrity

### 1.1 Locked Decision: Fully Backend-Mediated Merchant Operations (Option 1)
> [!IMPORTANT]
> **Trust tier caps (max royalty bps, active SKU limits, manual approval workflows) are strictly enforced by the backend API prior to onchain submission.**

To prevent bypass of platform rules while maintaining zero smart contract changes:
1. **API-First Onboarding & Listing**: All merchant operations (`POST /merchant/skus`, `POST /merchant/listings`) are submitted through the Restock Protocol Backend API using authenticated Merchant API Keys (`merchant:write`).
2. **Pre-Flight Limit Validation**: The backend validates the merchant's trust tier caps (e.g., verifying `royaltyBps <= maxRoyaltyBps` and `activeSKUCount < maxActiveSKUs`) *before* generating or submitting the onchain transaction.
3. **Platform Indexing & Catalog Scope**: The platform API catalog endpoints (`GET /skus`, `GET /skus/:skuId/listings`) index and surface **only** platform-registered SKUs created via verified merchant accounts. If a raw wallet calls the `SKURegistry` smart contract directly onchain, that SKU remains unindexed by the platform until claimed via an authenticated merchant account verification proof.
4. **Explicit Frontend Client Refactoring Scope**:
   - The reference client (`client/src/...`) will be updated in Phase 5 implementation to route SKU creation and listing publishing through `POST /merchant/skus` and `POST /merchant/listings` instead of making direct `SKURegistry` or `Marketplace` contract calls.

### 1.2 Zero-Contract-Changes Mandate
- No deployed smart contracts on Base Sepolia (`SKURegistry`, `Marketplace`, `ClaimToken`, `AgentGateway`) will be modified, redeployed, or reopened in Phase 5.
- `SKURegistry.createSKU(..., merchant, ...)` accepts the `merchant` wallet address parameter directly. The backend relayer or merchant signer submits the transaction with the validated merchant address upon passing backend trust-tier checks.

---

## 2. Merchant Identity Data Model & Enforced Trust Tiers

### 2.1 Schema Definitions

```typescript
export type VerificationStatus = "UNVERIFIED" | "PENDING_VERIFICATION" | "VERIFIED" | "SUSPENDED";
export type WalletRole = "PRIMARY_PAYOUT" | "LISTING_SIGNER" | "ADMIN_RECOVERY";

export interface MerchantWallet {
  address: string;             // Lowercase / checksummed canonical ETH address
  role: WalletRole;            // Purpose of wallet within merchant organization
  addedAt: number;             // Unix timestamp
  signatureProof: string;      // EIP-712 signature proving ownership during binding
}

export interface MerchantAccount {
  id: string;                  // Prefix: mer_[alphanumeric16]
  legalName: string;           // Registered business or entity name
  contactEmail: string;        // Primary operational email
  verificationStatus: VerificationStatus;
  wallets: MerchantWallet[];    // Array of associated onchain wallets
  trustTier: {
    tierLevel: "TIER_0_SANDBOX" | "TIER_1_STANDARD" | "TIER_2_ENTERPRISE";
    maxRoyaltyBps: number;      // Maximum allowed royalty percentage (e.g. 1000 = 10%)
    maxActiveSKUs: number;      // Maximum active listings/SKUs allowed
    requiresManualSKUApproval: boolean;
  };
  createdAt: number;
  updatedAt: number;
}
```

### 2.2 Wallet Binding & Replay-Protected EIP-712 Challenge
To bind a new wallet address to an existing `MerchantAccount`, the platform enforces **cryptographic replay protection** with explicit domain separation:

#### EIP-712 Struct & Type Definition
```typescript
const EIP712Domain = {
  name: "RestockProtocolPlatform",
  version: "1",
  chainId: 84532, // Base Sepolia
  verifyingContract: "0x0000000000000000000000000000000000000000" // Dedicated platform identifier avoiding onchain contract address ambiguity
};

const BindWalletTypes = {
  BindWallet: [
    { name: "merchantId", type: "string" },
    { name: "walletAddress", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
};
```

1. The merchant requests a binding challenge from `POST /merchant/wallets/challenge`.
2. The server issues a challenge containing a single-use `nonce` (stored in DB) and a `deadline` (Unix timestamp, valid for 5 minutes).
3. The merchant signs the EIP-712 payload with the target wallet.
4. The server verifies `signature`, checks `deadline > Date.now()`, marks `nonce` as consumed, and appends the wallet to `wallets[]`.

### 2.3 Concrete Enforced Trust Tier Matrix

| Feature / Enforced Limit | Tier 0 (Unverified / Sandbox) | Tier 1 (Standard Verified) | Tier 2 (Enterprise) |
| :--- | :--- | :--- | :--- |
| **Max Active SKUs** | **3 SKUs** (Enforced at `POST /merchant/skus`) | **50 SKUs** (Enforced at `POST /merchant/skus`) | **Unlimited** |
| **Max Royalty Fee (bps)** | **Max 500** (5.0%) | **Max 1500** (15.0%) | **Max 2500** (25.0%) |
| **SKU Go-Live Policy** | Requires Manual Admin Review | Auto-Approve Instant | Auto-Approve Instant |
| **Reserve Rate Limit** | 5 requests / min | 60 requests / min | 300 requests / min |
| **Global API Rate Limit** | 100 requests / min | 1,000 requests / min | 5,000 requests / min |

---

## 3. API Key & Authentication System

### 3.1 API Key Data Model & Scope Policy

API Keys follow standard prefix patterns (`rk_live_...` or `rk_test_...`):

```typescript
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
```

> [!WARNING]
> **Key Scope Separation & Issuance Policy**:
> 1. **Default Separation**: Standard operational keys (`merchant:write`) are generated **without** `merchant:keys:write` by default.
> 2. **Privileged Key Management Auth**: `POST /merchant/keys` and `DELETE /merchant/keys/:id` require **either** an EIP-712 signed wallet session challenge from a registered `MerchantWallet` **or** an explicit key possessing `merchant:keys:write`.
> 3. **Genesis Exception**: Bundling `merchant:write` + `merchant:keys:write` on a single key is a **genesis bootstrap exception only** for administrative setup.

### 3.2 Authorization & Scope Mapping Matrix

| Route Path | Method | Minimum Required Scope | Auth Required? | Description & Context |
| :--- | :--- | :--- | :--- | :--- |
| `/health` | `GET` | None | No | System health check & uptime status |
| `/skus` | `GET` | `public:read` | Optional* | Catalog discovery (Surfaces platform-registered SKUs) |
| `/skus/:skuId` | `GET` | `public:read` | Optional* | Single SKU details |
| `/skus/:skuId/listings` | `GET` | `public:read` | Optional* | SKU active listings |
| `/listings/:listingId/reserve` | `POST` | `buyer:transact` | **Yes** | Onchain inventory reservation (Spends Relayer Gas) |
| `/reservations/:id/pay` | `POST` | `buyer:transact` | **Yes** | Settlement & EIP-3009 payment fulfillment |
| `/skus/:skuId/redeem` | `POST` | `buyer:transact` | **Yes** | Claim Token physical redemption submission |
| `/merchant/skus` | `POST` | `merchant:write` | **Yes** | Create new SKU (Validates trust-tier caps pre-flight) |
| `/merchant/listings` | `POST` | `merchant:write` | **Yes** | Post new inventory listing |
| `/merchant/orders` | `GET` | `merchant:read` | **Yes** | View merchant sale history & fulfillment status |
| `/merchant/keys` | `GET` | `merchant:read` | **Yes** | View list of active/revoked key metadata |
| `/merchant/keys` | `POST` | `merchant:keys:write` **or** Wallet Signature | **Yes** | Issue new API key (Privileged Auth) |
| `/merchant/keys/:id` | `DELETE` | `merchant:keys:write` **or** Wallet Signature | **Yes** | Revoke API key (Privileged Auth) |
| `/admin/redemptions` | `GET` | `admin:read` | **Yes** | Cross-merchant redemption queue |
| `/admin/redemptions/:id/mark-shipped` | `POST` | `admin:write` | **Yes** | Update redemption shipping status |
| `/admin/skus/:skuId/basis-value` | `POST` | `admin:write` | **Yes** | Onchain price oracle basis value update |

*\*Public routes allow unauthenticated access but apply per-IP rate limits. Authenticated requests use key-based rate limits.*

### 3.3 Rate Limiting Rationale & Split Confirmation
The rate-limiting split is an **intentional design choice**:
- **Anonymous IP Limit (60 req/min per IP)**: Protects public read-only catalog routes (`/skus`) against scraping bots while allowing regular web browser traffic.
- **Tier 0 Key Limit (100 req/min per key)**: Applied across all endpoints for an authenticated Tier 0 developer key. This allows integrating applications to execute parallel development queries across different IPs without hitting per-IP rate limits.
- **Gas Defense Reserve Limit (Strict 10 req/min per key)**: Applied specifically to `/listings/:listingId/reserve` regardless of overall key limit, preventing relayer gas draining.

---

## 4. Existing Onchain Genesis Data & Cryptographic Seed Migration

### 4.1 Genesis Merchant Account Binding
The live Base Sepolia environment currently contains seeded merchant wallet `0x345924F66825794e424f9B402756d7015a8dC12E` and associated SKUs/Listings.

During migration initialization, a **Genesis Migration Script** will:
1. Seed `mer_genesis_merchant_01` in `db.json` bound to `0x345924F66825794e424f9B402756d7015a8dC12E`.
2. Set `verificationStatus: "VERIFIED"` and `trustTier: "TIER_2_ENTERPRISE"`.
3. Issue initial genesis API keys using **cryptographically secure 256-bit random secrets** (`rk_live_[32_random_bytes_hex]`):
   - Admin Genesis Key (`admin:read`, `admin:write`, `merchant:write`, `merchant:keys:write`, `buyer:transact`, `public:read`).
   - Merchant Genesis Key (`merchant:read`, `merchant:write`, `merchant:keys:write`, `public:read`).
   - Buyer Agent Genesis Key (`buyer:transact`, `public:read`).

*(Note: The key name strings shown in documentation are illustrative descriptions; actual secret keys generated at runtime use CSPRNG random hex strings and are printed once to stdout during initialization).*

---

## 5. Phase 5 Implementation Roadmap

With the design spec fully locked, Phase 5 implementation will proceed across three targeted sessions:

- **Phase 5, Part 1 (Core Identity, Auth Middleware & Key DB)**:
  - Implement `MerchantAccount`, `ApiKeyRecord`, and `AuditLogEntry` DB schemas.
  - Implement SHA-256 API key hashing, Bearer auth middleware, scope validation, and EIP-712 wallet binding challenges with nonce/deadline replay protection.
  - Run Genesis Migration script to bind live Base Sepolia wallet `0x3459...c12e` to `mer_genesis_merchant_01`.

- **Phase 5, Part 2 (Backend Merchant Routes, Pre-Flight Enforcement & Rate Limiting)**:
  - Build `POST /merchant/skus` and `POST /merchant/listings` with trust-tier pre-flight checks (royalty caps, SKU limits).
  - Implement token bucket rate limiter (IP-based, Key-based, and strict 10/min gas defense on `/reserve`).
  - Wire audit logging middleware across all routes.

- **Phase 5, Part 3 (Frontend Refactoring & End-to-End Suite Verification)**:
  - Refactor reference client (`client/src/...`) SKU/listing forms to use `POST /merchant/skus` and `POST /merchant/listings`.
  - Update integration test suite to include authenticated API key headers for all protected routes and verify 401/403/429 responses.

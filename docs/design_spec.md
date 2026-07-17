# Restock Protocol — Phase 0: Design Finalization

## 1. Scope Recap (MVP boundaries, from Phase 0 constraints)

- Single mock merchant, single SKU, small capped batch.
- Fungible-within-SKU token model (not fully unique per-unit).
- Direct-listing marketplace only (no order book / AMM yet).
- Manual truth bridge (you play "the warehouse").
- One scripted autonomous agent demo using x402.
- Royalty enforcement on every resale is a hard requirement — it's the core differentiator.

---

## 2. Data Model

### 2.1 Entities

**SKU**
| Field | Type | Notes |
|---|---|---|
| `skuId` | `bytes32` or `uint256` | Unique identifier, immutable once created |
| `merchant` | `address` | Wallet that owns this SKU and receives royalties |
| `name` | `string` (offchain metadata) | e.g. "Nike Dunk Low — Black/White" |
| `variant` | `string` (offchain metadata) | e.g. "Size 10" |
| `maxSupply` | `uint256` | Hard, immutable cap — set once at creation, can never increase |
| `mintedSupply` | `uint256` | Running count of units minted so far (≤ maxSupply) |
| `redeemedSupply` | `uint256` | Running count of units burned via redemption |
| `royaltyBps` | `uint16` | Royalty in basis points (e.g. 300 = 3%), fixed at creation |
| `basisValue` | `uint256` | Reference real-world price, in stablecoin smallest unit (manually set/updated) |
| `metadataURI` | `string` | Points to offchain JSON (images, description, spec) |
| `status` | `enum {Active, Paused, Deprecated}` | Merchant/admin controlled; Paused blocks new listings, not redemption |

**Unit Balance (fungible-within-SKU — no individual unit struct needed for MVP)**
Represented simply as ERC-1155 balance of `skuId` per wallet. No separate struct required.

**Listing**
| Field | Type | Notes |
|---|---|---|
| `listingId` | `uint256` | Auto-incremented |
| `skuId` | `bytes32/uint256` | Which SKU this listing sells |
| `seller` | `address` | Current token holder listing it |
| `quantity` | `uint256` | Number of claim tokens in this listing |
| `pricePerUnit` | `uint256` | Stablecoin smallest-unit price, seller-set |
| `status` | `enum {Open, Filled, Cancelled}` | |
| `createdAt` | `uint256` (timestamp) | |

**Reservation**
| Field | Type | Notes |
|---|---|---|
| `reservationId` | `uint256` | Auto-incremented |
| `listingId` | `uint256` | What's being reserved |
| `buyer` | `address` | Who holds the lock |
| `quantity` | `uint256` | Units locked |
| `expiresAt` | `uint256` (timestamp) | Hard TTL — e.g. `now + 120 seconds` |
| `status` | `enum {Active, Completed, Expired, Cancelled}` | |

**RedemptionRequest**
| Field | Type | Notes |
|---|---|---|
| `redemptionId` | `uint256` | Auto-incremented |
| `skuId` | `bytes32/uint256` | |
| `holder` | `address` | Who redeemed |
| `quantity` | `uint256` | Units burned |
| `shippingRef` | `string` | Offchain reference (address/contact — see note below) |
| `fulfillmentStatus` | `enum {Pending, Shipped, Delivered, Disputed}` | Manually updated by merchant/truth bridge in MVP |
| `createdAt` | `uint256` (timestamp) | |

> **Privacy note for shipping data:** don't put real shipping addresses onchain. Store only a reference ID or hash onchain; keep the actual address in an offchain database the merchant/truth-bridge dashboard can read.

### 2.2 Relationships

```
Merchant (1) ──creates──> (many) SKU
SKU (1) ──mints──> (many) Claim Tokens [ERC-1155 balance, fungible per skuId]
SKU (1) ──has──> (many) Listing
Listing (1) ──can have──> (0..1 Active) Reservation
Listing (1) ──on fill──> RedemptionRequest is NOT created automatically —
   redemption is a separate, explicit holder action, independent of trading
```

---

## 3. Contract Interfaces

### 3.1 `ISKURegistry`

```solidity
interface ISKURegistry {
    struct SKUInfo {
        address merchant;
        uint256 maxSupply;
        uint256 mintedSupply;
        uint256 redeemedSupply;
        uint16 royaltyBps;
        uint256 basisValue;
        string metadataURI;
        uint8 status; // 0=Active,1=Paused,2=Deprecated
    }

    event SKUCreated(uint256 indexed skuId, address indexed merchant, uint256 maxSupply, uint16 royaltyBps);
    event SKUBasisValueUpdated(uint256 indexed skuId, uint256 newBasisValue);
    event SKUStatusChanged(uint256 indexed skuId, uint8 newStatus);

    function createSKU(
        uint256 maxSupply,
        uint16 royaltyBps,
        uint256 initialBasisValue,
        string calldata metadataURI
    ) external returns (uint256 skuId);

    function updateBasisValue(uint256 skuId, uint256 newBasisValue) external;

    function setStatus(uint256 skuId, uint8 status) external;

    function getSKU(uint256 skuId) external view returns (SKUInfo memory);

    function _checkMintCap(uint256 skuId, uint256 amount) external view returns (bool);
}
```

### 3.2 `IClaimToken` (ERC-1155 extension)

```solidity
interface IClaimToken /* is IERC1155 */ {
    event UnitsMinted(uint256 indexed skuId, address indexed to, uint256 amount);
    event UnitsRedeemed(uint256 indexed skuId, address indexed holder, uint256 amount, uint256 redemptionId);

    function mint(uint256 skuId, address to, uint256 amount) external;

    function redeem(uint256 skuId, uint256 amount, string calldata shippingRef)
        external returns (uint256 redemptionId);
}
```

### 3.3 `IMarketplace`

```solidity
interface IMarketplace {
    event Listed(uint256 indexed listingId, uint256 indexed skuId, address seller, uint256 quantity, uint256 pricePerUnit);
    event Reserved(uint256 indexed reservationId, uint256 indexed listingId, address buyer, uint256 quantity, uint256 expiresAt);
    event Purchased(uint256 indexed listingId, address buyer, uint256 quantity, uint256 totalPaid, uint256 royaltyPaid);
    event ListingCancelled(uint256 indexed listingId);
    event ReservationExpired(uint256 indexed reservationId);

    function createListing(uint256 skuId, uint256 quantity, uint256 pricePerUnit)
        external returns (uint256 listingId);

    function cancelListing(uint256 listingId) external;

    function reserve(uint256 listingId, uint256 quantity) external returns (uint256 reservationId);

    function fulfillReservation(uint256 reservationId) external;

    function releaseExpiredReservation(uint256 reservationId) external;

    function getListing(uint256 listingId) external view returns (
        uint256 skuId, address seller, uint256 quantity, uint256 pricePerUnit, uint8 status
    );
}
```

### 3.4 `IAgentGateway` (x402-facing wrapper)

```solidity
interface IAgentGateway {
    function agentPurchase(
        uint256 listingId,
        uint256 quantity,
        address payToken
    ) external returns (uint256 redemptionReadyBalanceDelta);
}
```

### 3.5 Critical Invariants

1. `mintedSupply` can never exceed `maxSupply`, under any code path, ever.
2. A token, once burned via `redeem()`, can never be transferred, listed, or reserved again.
3. Two overlapping reservations can never lock more than a listing's actual unreserved quantity (no double-lock).
4. Royalty payment and claim-token transfer happen atomically — either both succeed or the whole purchase reverts.
5. `basisValue` is informational only — it must never gate or block a trade.

---

## 4. API Specification

### 4.1 Discovery
`GET /skus?category=sneakers&maxPrice=250&available=true`

### 4.2 Pricing / listing detail
`GET /skus/{skuId}/listings`

### 4.3 Reservation
`POST /listings/{listingId}/reserve`
Body: `{ "buyer": "0xAgentWallet", "quantity": 1 }`

### 4.4 Payment (x402-gated)
`POST /reservations/{reservationId}/pay`

### 4.5 Redemption
`POST /skus/{skuId}/redeem`
Body: `{ "holder": "0xWallet", "quantity": 1, "shippingRef": "ref_9f21" }`

### 4.6 Truth bridge / merchant dashboard (internal, not agent-facing)
`GET  /admin/redemptions?status=Pending`
`POST /admin/redemptions/{redemptionId}/mark-shipped`
`POST /admin/skus/{skuId}/basis-value` Body: `{ "value": "155.00" }`

---

## 5. The MVP Mock SKU — Finalized

- **Working name:** "Restock Protocol Demo Sneaker — Model RS-01, Black/White, Size 10"
- **skuId:** `1`
- **maxSupply:** `25`
- **royaltyBps:** `300` (3%)
- **initialBasisValue:** `150.00 USDC`
- **Initial listing price:** `150.00 USDC`
- **Reservation TTL:** `120` seconds
- **Payment token:** Testnet USDC on Base Sepolia

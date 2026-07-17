# Restock Protocol Autonomous Agent Demo Placeholder

This directory is reserved for the autonomous agent demo script.

## Status
- **Phase 0 (Scaffolding):** Not yet implemented.
- **Future Phase:** We will build a Node.js/TypeScript script that simulates an autonomous agent utilizing x402 HTTP micropayments to purchase claim tokens.

## Workflow Plan
1. Query the Express backend `/skus` discovery endpoint.
2. Locate the mock SKU ("Restock Protocol Demo Sneaker — Model RS-01") listing that fits the agent's budget (< $250).
3. Request a reservation at the endpoint `/listings/{listingId}/reserve`.
4. Receive HTTP `402 Payment Required` detailing stablecoin requirements.
5. Pay stablecoin on Base Sepolia and submit the transaction hash back in the `X-Payment-Proof` header.
6. Verify token balance increases and call `/skus/{skuId}/redeem` with offchain shipping address, triggering the burn event onchain.

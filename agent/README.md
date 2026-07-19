# Restock Protocol - Autonomous purchasing Agent Demo

This directory contains a standalone autonomous agent demo script that demonstrates how an independent client agent can discover SKUs, make reservations, receive `402 Payment Required` challenges, autonomously sign EIP-3009 transfer authorizations, and receive ClaimTokens.

## Setup Instructions

### 1. Install Dependencies
Run the following command inside this directory:
```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Supply your own custom private key for the purchasing agent:
- `DEMO_AGENT_PRIVATE_KEY`: A dedicated testnet wallet private key (separate from the relayer and merchant identities).

*Note: If no private key is supplied, running the demo script will automatically generate a fresh testnet keypair and output it to the console with faucet links.*

### 3. Fund your Wallet
Make sure your demo agent wallet has at least:
- **0.005 ETH** (on Base Sepolia) for gas fees.
- **0.01 USDC** (on Base Sepolia) to complete the token purchase.

Faucets:
- **ETH**: [Coinbase Faucet](https://faucet.coinbase.com/) or [QuickNode Faucet](https://quicknode.com/faucet/base-sepolia)
- **USDC**: [Circle Faucet](https://faucet.circle.com/) (select Base Sepolia network)

---

## Running the Demo

Make sure the Restock Protocol Backend API service is running locally (`npm run dev` in the `/backend` directory).

Execute the demo script using npm:
```bash
npm run demo
```
The output will narrate each step of the autonomous purchasing process on Base Sepolia.

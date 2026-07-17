# Restock Protocol

Restock Protocol is a tokenized-inventory infrastructure project built on Base Sepolia. It allows merchants to tokenize their physical inventory as claim tokens, enabling atomic resales with royalty enforcement, agentic purchasing interfaces, and streamlined redemption workflows.

## Documentation
- [Phase 0 Design Specification](docs/design_spec.md) - The source of truth for the data model, smart contract interfaces, critical invariants, and API spec.

## Repository Structure

This is a monorepo structured as follows:

- **[`contracts/`](contracts/)**: Solidity smart contracts implementing the core registry, marketplace, and claim token mechanisms using Hardhat as the development framework.
- **[`backend/`](backend/)**: Express/TypeScript REST API service that handles offchain indexing, agent discovery, reservation routing, x402-gated payments, and merchant admin workflows.
- **[`client-placeholder/`](client-placeholder/)**: A placeholder for the web-based reference client.
- **[`agent-placeholder/`](agent-placeholder/)**: A placeholder for the autonomous agent scripts.
- **`docs/`**: Project documentation, specs, and diagrams.

## Phase 0 Status: Scaffolding Complete

This project has been scaffolded with:
- Standardised Solidity interface files in `contracts/contracts/interfaces/`.
- Concrete stub implementations and tests for five critical invariants inside `contracts/`.
- TypeScript schemas and route stubs for the Express API inside `backend/`.
- Configured environments and placeholder packages.

For phase-specific details and instructions on running tests and the backend stub, refer to the `README.md` inside each respective directory.

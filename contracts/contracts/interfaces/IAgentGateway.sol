// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentGateway {
    /// @notice Machine-facing entrypoint. Wraps reserve + fulfillReservation
    /// behind a single call so an agent can discover -> reserve -> pay ->
    /// receive in one x402-mediated request/response cycle.
    function agentPurchase(
        uint256 listingId,
        uint256 quantity,
        address payToken // stablecoin address, validated against allowlist
    ) external returns (uint256 redemptionReadyBalanceDelta);
}

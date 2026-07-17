// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAgentGateway } from "../interfaces/IAgentGateway.sol";

contract AgentGatewayStub is IAgentGateway {
    // TODO: implement in Phase 1
    function agentPurchase(
        uint256 listingId,
        uint256 quantity,
        address payToken
    ) external override returns (uint256 redemptionReadyBalanceDelta) {
        return quantity;
    }
}

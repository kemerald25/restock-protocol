// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC1155Receiver } from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import { IAgentGateway } from "../interfaces/IAgentGateway.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockReentrantAgentPayer is IERC1155Receiver {
    IAgentGateway public gateway;
    IERC20 public stableToken;
    uint256 public listingId;
    uint256 public quantity;
    bool public shouldReenter;
    bool public reentrancyFailed;

    constructor(address _gateway, address _stableToken) {
        gateway = IAgentGateway(_gateway);
        stableToken = IERC20(_stableToken);
    }

    function setPurchaseParams(uint256 _listingId, uint256 _quantity) external {
        listingId = _listingId;
        quantity = _quantity;
    }

    function setShouldReenter(bool _should) external {
        shouldReenter = _should;
    }

    function approveGateway(uint256 amount) external {
        stableToken.approve(address(gateway), amount);
    }

    function initiatePurchase() external {
        gateway.agentPurchase(listingId, quantity, address(stableToken));
    }

    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external override returns (bytes4) {
        if (shouldReenter) {
            shouldReenter = false; // Prevent infinite loop if guard fails
            try gateway.agentPurchase(listingId, quantity, address(stableToken)) {
                reentrancyFailed = false;
            } catch {
                reentrancyFailed = true; // successfully reverted!
            }
        }
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external override returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId;
    }
}

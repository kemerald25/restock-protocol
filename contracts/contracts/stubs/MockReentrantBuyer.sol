// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC1155Receiver } from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import { IMarketplace } from "../interfaces/IMarketplace.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockReentrantBuyer is IERC1155Receiver {
    IMarketplace public marketplace;
    IERC20 public stableToken;
    uint256 public reservationId;
    bool public shouldReenter;
    bool public reentrancyFailed;

    constructor(address _marketplace, address _stableToken) {
        marketplace = IMarketplace(_marketplace);
        stableToken = IERC20(_stableToken);
    }

    function setReservation(uint256 _resId) external {
        reservationId = _resId;
    }

    function setShouldReenter(bool _should) external {
        shouldReenter = _should;
    }

    function approveMarketplace(uint256 amount) external {
        stableToken.approve(address(marketplace), amount);
    }

    function reserveListing(uint256 listingId, uint256 quantity) external returns (uint256) {
        return marketplace.reserve(listingId, quantity);
    }

    function initiateFulfill() external {
        marketplace.fulfillReservation(reservationId);
    }

    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external override returns (bytes4) {
        if (shouldReenter) {
            shouldReenter = false; // Prevent infinite loop if reentrancy guard fails
            try marketplace.fulfillReservation(reservationId) {
                // If it succeeds, reentrancy failed to be blocked
                reentrancyFailed = false;
            } catch {
                // If it reverts, reentrancy was successfully blocked!
                reentrancyFailed = true;
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

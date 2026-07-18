// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAgentGateway } from "./interfaces/IAgentGateway.sol";
import { IMarketplace } from "./interfaces/IMarketplace.sol";
import { IClaimToken } from "./interfaces/IClaimToken.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ERC1155Holder } from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AgentGateway
 * @notice Wrapper contract combining reservation and fulfillment into a single atomic action.
 * Leverages Option 1A (Gateway holds and forwards to msg.sender) to deliver claim tokens 
 * without modifying Marketplace state logic.
 */
contract AgentGateway is IAgentGateway, ERC1155Holder, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IMarketplace public immutable marketplace;
    IClaimToken public immutable claimToken;
    IERC20 public immutable allowedStableToken;

    constructor(
        address _marketplace,
        address _claimToken,
        address _allowedStableToken
    ) {
        require(_marketplace != address(0), "AgentGateway: invalid marketplace address");
        require(_claimToken != address(0), "AgentGateway: invalid claim token address");
        require(_allowedStableToken != address(0), "AgentGateway: invalid stable token address");

        marketplace = IMarketplace(_marketplace);
        claimToken = IClaimToken(_claimToken);
        allowedStableToken = IERC20(_allowedStableToken);

        // Give infinite approval to the Marketplace contract for the allowed stablecoin.
        // Why this is safe:
        // 1. `marketplace` is an immutable, trusted contract address supplied at deployment time.
        // 2. The amount of stablecoin pulled per transaction is strictly bounded by the pricing/listing logic 
        //    inside `marketplace.fulfillReservation`, which has been thoroughly validated and tested.
        // 3. This saves gas by avoiding setting individual approvals per transaction.
        IERC20(_allowedStableToken).approve(_marketplace, type(uint256).max);
    }

    /// @notice Wraps reserve and fulfillReservation into a single atomic transaction.
    /// Pulls stablecoin payment from the caller, executes the purchase, and forwards 
    /// the claim tokens to the caller (msg.sender).
    function agentPurchase(
        uint256 listingId,
        uint256 quantity,
        address payToken
    ) external override nonReentrant returns (uint256 redemptionReadyBalanceDelta) {
        require(payToken == address(allowedStableToken), "AgentGateway: unsupported payment token");

        // Retrieve pricing details from the marketplace listing to compute total cost
        (uint256 skuId, , , uint256 pricePerUnit, ) = marketplace.getListing(listingId);
        uint256 totalDue = quantity * pricePerUnit;

        // Pull payment from caller to this gateway contract (requires prior approval from caller to AgentGateway)
        allowedStableToken.safeTransferFrom(msg.sender, address(this), totalDue);

        // Call reserve on Marketplace (AgentGateway becomes the buyer of record)
        uint256 reservationId = marketplace.reserve(listingId, quantity);

        // Call fulfillReservation on Marketplace (Marketplace pulls payment from AgentGateway and transfers claim tokens to AgentGateway)
        marketplace.fulfillReservation(reservationId);

        // Forward claim tokens from AgentGateway to the final recipient (msg.sender)
        claimToken.safeTransferFrom(address(this), msg.sender, skuId, quantity, "");

        // Return the number of claim tokens successfully purchased and delivered
        return quantity;
    }
}

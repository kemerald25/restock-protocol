// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC1155 } from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

interface IClaimToken is IERC1155 {
    event UnitsMinted(uint256 indexed skuId, address indexed to, uint256 amount);
    event UnitsRedeemed(uint256 indexed skuId, address indexed holder, uint256 amount, uint256 redemptionId);

    /// @notice Mints claim tokens for a SKU. Only callable by SKURegistry
    /// on the merchant's behalf, and only up to maxSupply.
    function mint(uint256 skuId, address to, uint256 amount) external;

    /// @notice Burns tokens and emits a redemption event. This is the ONLY
    /// way tokens leave circulation. One-way — no re-mint of redeemed units.
    function redeem(uint256 skuId, uint256 amount, string calldata shippingRef)
        external returns (uint256 redemptionId);
}

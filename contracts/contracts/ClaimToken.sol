// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC1155 } from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import { IClaimToken } from "./interfaces/IClaimToken.sol";
import { ISKURegistry } from "./interfaces/ISKURegistry.sol";
import { ISKURegistryInternal } from "./interfaces/ISKURegistryInternal.sol";

/**
 * @title ClaimToken
 * @notice Production implementation of the Claim Token for Restock Protocol.
 * Extends OpenZeppelin ERC1155. Handles merchant minting and user redemptions.
 */
contract ClaimToken is ERC1155, IClaimToken {
    // Immutable reference to the SKU Registry
    ISKURegistry public immutable skuRegistry;
    
    // Auto-incrementing redemption ID starting at 1
    uint256 private _nextRedemptionId = 1;

    constructor(ISKURegistry _skuRegistry) ERC1155("") {
        require(address(_skuRegistry) != address(0), "ClaimToken: invalid registry address");
        skuRegistry = _skuRegistry;
    }

    /**
     * @notice Overridden uri function to dynamically retrieve metadata URI from SKURegistry.
     * Each SKU's metadata resolves through the registry's stored SKUInfo.
     * @param skuId The token ID (SKU ID) to query.
     */
    function uri(uint256 skuId) public view override(ERC1155) returns (string memory) {
        ISKURegistry.SKUInfo memory sku = skuRegistry.getSKU(skuId);
        return sku.metadataURI;
    }

    /**
     * @notice Mints claim tokens for a SKU. Only callable by the SKU's registered merchant.
     * Coordinates with SKURegistry to check caps and increment mintedSupply.
     */
    function mint(uint256 skuId, address to, uint256 amount) external override {
        require(to != address(0), "ClaimToken: mint to the zero address");
        require(amount > 0, "ClaimToken: mint amount must be greater than 0");

        // Access Control: Query SKU merchant from the registry
        ISKURegistry.SKUInfo memory sku = skuRegistry.getSKU(skuId);
        require(msg.sender == sku.merchant, "ClaimToken: caller is not the merchant");

        // Record the mint on the registry (this will check the maxSupply limit and revert if exceeded)
        ISKURegistryInternal(address(skuRegistry)).recordMint(skuId, amount);

        // Perform standard ERC1155 mint
        _mint(to, skuId, amount, "");

        emit UnitsMinted(skuId, to, amount);
    }

    /**
     * @notice Burns tokens and emits a redemption event. This is the ONLY
     * way tokens leave circulation. One-way — no path to re-mint or restore redeemed units.
     * Treats shippingRef as an opaque reference; no shipping details are stored onchain.
     */
    function redeem(uint256 skuId, uint256 amount, string calldata shippingRef)
        external override returns (uint256 redemptionId)
    {
        // Treat shippingRef as an opaque reference (do not store onchain)
        shippingRef;

        require(amount > 0, "ClaimToken: redemption amount must be greater than 0");
        require(balanceOf(msg.sender, skuId) >= amount, "ClaimToken: insufficient balance for redemption");

        // Perform standard ERC1155 burn (irreversible)
        _burn(msg.sender, skuId, amount);

        // Record the redemption on the registry to update redeemedSupply counter
        ISKURegistryInternal(address(skuRegistry)).recordRedemption(skuId, amount);

        redemptionId = _nextRedemptionId++;

        emit UnitsRedeemed(skuId, msg.sender, amount, redemptionId);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISKURegistryInternal {
    /// @notice Records a new mint. Increments mintedSupply and reverts if maxSupply is exceeded.
    /// @dev Only callable by the ClaimToken contract.
    function recordMint(uint256 skuId, uint256 amount) external;

    /// @notice Records a new redemption (burn). Increments redeemedSupply.
    /// @dev Only callable by the ClaimToken contract.
    function recordRedemption(uint256 skuId, uint256 amount) external;
}

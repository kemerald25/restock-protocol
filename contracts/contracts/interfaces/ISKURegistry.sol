// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISKURegistry {
    struct SKUInfo {
        address merchant;
        uint256 maxSupply;
        uint256 mintedSupply;
        uint256 redeemedSupply;
        uint16 royaltyBps;
        uint256 basisValue;
        string metadataURI;
        uint8 status; // 0=Active, 1=Paused, 2=Deprecated
    }

    event SKUCreated(uint256 indexed skuId, address indexed merchant, uint256 maxSupply, uint16 royaltyBps);
    event SKUBasisValueUpdated(uint256 indexed skuId, uint256 newBasisValue);
    event SKUStatusChanged(uint256 indexed skuId, uint8 newStatus);

    /// @notice Creates a new SKU. maxSupply is IMMUTABLE after this call.
    function createSKU(
        uint256 maxSupply,
        uint16 royaltyBps,
        uint256 initialBasisValue,
        string calldata metadataURI
    ) external returns (uint256 skuId);

    /// @notice Merchant-only. Updates the reference real-world price.
    function updateBasisValue(uint256 skuId, uint256 newBasisValue) external;

    /// @notice Merchant-only. Pauses new listings; does not block redemption.
    function setStatus(uint256 skuId, uint8 status) external;

    function getSKU(uint256 skuId) external view returns (SKUInfo memory);

    /// @dev MUST revert if mintedSupply + amount > maxSupply. This is the
    /// single most important invariant in the whole system.
    function _checkMintCap(uint256 skuId, uint256 amount) external view returns (bool);
}

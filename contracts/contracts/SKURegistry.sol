// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ISKURegistry } from "./interfaces/ISKURegistry.sol";
import { ISKURegistryInternal } from "./interfaces/ISKURegistryInternal.sol";

/**
 * @title SKURegistry
 * @notice Real implementation of the SKU Registry for Restock Protocol.
 * Handles SKU registration, basis value and status updates, and supply limits.
 */
contract SKURegistry is ISKURegistry, ISKURegistryInternal, Ownable {
    // Auto-incrementing SKU ID starting at 1 (0 is reserved as a sentinel)
    uint256 private _nextSkuId = 1;
    
    // Core SKU state mapping
    mapping(uint256 => SKUInfo) private _skus;
    
    // One-time configurable address of the ClaimToken contract allowed to mutate supply counters
    address public claimTokenAddress;

    modifier onlyMerchant(uint256 skuId) {
        require(_skus[skuId].merchant != address(0), "SKU registry: SKU does not exist");
        require(_skus[skuId].merchant == msg.sender, "SKU registry: caller is not the merchant");
        _;
    }

    modifier onlyClaimToken() {
        require(msg.sender == claimTokenAddress, "SKU registry: caller is not the ClaimToken contract");
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {}

    /**
     * @notice Sets the claim token address exactly once.
     * @dev Restricts silent redirection of the trust boundary after deployment.
     */
    function setClaimTokenAddress(address _claimTokenAddress) external onlyOwner {
        require(claimTokenAddress == address(0), "SKU registry: ClaimToken address already set");
        require(_claimTokenAddress != address(0), "SKU registry: invalid address");
        claimTokenAddress = _claimTokenAddress;
    }

    /// @notice Creates a new SKU. maxSupply is IMMUTABLE after this call.
    function createSKU(
        uint256 maxSupply,
        uint16 royaltyBps,
        uint256 initialBasisValue,
        string calldata metadataURI
    ) external override returns (uint256 skuId) {
        require(maxSupply > 0, "SKU registry: max supply must be greater than 0");
        require(royaltyBps <= 10000, "SKU registry: royalty bps exceeds 100%");
        
        skuId = _nextSkuId++;
        
        _skus[skuId] = SKUInfo({
            merchant: msg.sender,
            maxSupply: maxSupply,
            mintedSupply: 0,
            redeemedSupply: 0,
            royaltyBps: royaltyBps,
            basisValue: initialBasisValue,
            metadataURI: metadataURI,
            status: 0 // Active (0=Active, 1=Paused, 2=Deprecated)
        });
        
        emit SKUCreated(skuId, msg.sender, maxSupply, royaltyBps);
    }

    /// @notice Merchant-only. Updates the reference real-world price.
    function updateBasisValue(uint256 skuId, uint256 newBasisValue) external override onlyMerchant(skuId) {
        _skus[skuId].basisValue = newBasisValue;
        emit SKUBasisValueUpdated(skuId, newBasisValue);
    }

    /// @notice Merchant-only. Pauses new listings; does not block redemption.
    function setStatus(uint256 skuId, uint8 status) external override onlyMerchant(skuId) {
        require(status <= 2, "SKU registry: invalid status");
        _skus[skuId].status = status;
        emit SKUStatusChanged(skuId, status);
    }

    /// @notice Returns SKU info
    function getSKU(uint256 skuId) external view override returns (SKUInfo memory) {
        require(_skus[skuId].merchant != address(0), "SKU registry: SKU does not exist");
        return _skus[skuId];
    }

    /// @notice Checks if the mint amount would exceed max supply (informational view).
    function _checkMintCap(uint256 skuId, uint256 amount) external view override returns (bool) {
        SKUInfo memory sku = _skus[skuId];
        if (sku.merchant == address(0)) {
            return false;
        }
        return sku.mintedSupply + amount <= sku.maxSupply;
    }

    // --- ISKURegistryInternal State Mutator Implementation ---

    /**
     * @notice Records a new mint. Increments mintedSupply and reverts if maxSupply is exceeded.
     * @dev Only callable by the ClaimToken contract.
     * Boundary decision: Explicitly checks and increments the supply counter internally.
     */
    function recordMint(uint256 skuId, uint256 amount) external override onlyClaimToken {
        SKUInfo storage sku = _skus[skuId];
        require(sku.merchant != address(0), "SKU registry: SKU does not exist");
        require(sku.mintedSupply + amount <= sku.maxSupply, "SKU registry: mint amount would exceed maxSupply");
        
        sku.mintedSupply += amount;
    }

    /**
     * @notice Records a new redemption. Increments redeemedSupply.
     * @dev Only callable by the ClaimToken contract.
     */
    function recordRedemption(uint256 skuId, uint256 amount) external override onlyClaimToken {
        SKUInfo storage sku = _skus[skuId];
        require(sku.merchant != address(0), "SKU registry: SKU does not exist");
        
        sku.redeemedSupply += amount;
    }
}

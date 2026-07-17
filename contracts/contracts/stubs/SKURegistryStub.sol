// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISKURegistry } from "../interfaces/ISKURegistry.sol";

contract SKURegistryStub is ISKURegistry {
    mapping(uint256 => SKUInfo) private _skus;
    uint256 private _nextSkuId = 1;

    // TODO: implement in Phase 1
    function createSKU(
        uint256 maxSupply,
        uint16 royaltyBps,
        uint256 initialBasisValue,
        string calldata metadataURI
    ) external override returns (uint256 skuId) {
        skuId = _nextSkuId++;
        _skus[skuId] = SKUInfo({
            merchant: msg.sender,
            maxSupply: maxSupply,
            mintedSupply: 0,
            redeemedSupply: 0,
            royaltyBps: royaltyBps,
            basisValue: initialBasisValue,
            metadataURI: metadataURI,
            status: 0 // Active
        });
        emit SKUCreated(skuId, msg.sender, maxSupply, royaltyBps);
    }

    // TODO: implement in Phase 1
    function updateBasisValue(uint256 skuId, uint256 newBasisValue) external override {
        SKUInfo storage sku = _skus[skuId];
        sku.basisValue = newBasisValue;
        emit SKUBasisValueUpdated(skuId, newBasisValue);
    }

    // TODO: implement in Phase 1
    function setStatus(uint256 skuId, uint8 status) external override {
        SKUInfo storage sku = _skus[skuId];
        sku.status = status;
        emit SKUStatusChanged(skuId, status);
    }

    // TODO: implement in Phase 1
    function getSKU(uint256 skuId) external view override returns (SKUInfo memory) {
        return _skus[skuId];
    }

    // TODO: implement in Phase 1
    function _checkMintCap(uint256 skuId, uint256 amount) external view override returns (bool) {
        SKUInfo memory sku = _skus[skuId];
        return (sku.mintedSupply + amount <= sku.maxSupply);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC1155 } from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import { IClaimToken } from "../interfaces/IClaimToken.sol";

contract ClaimTokenStub is ERC1155, IClaimToken {
    uint256 private _nextRedemptionId = 1;

    constructor(string memory uri) ERC1155(uri) {}

    // TODO: implement in Phase 1
    function mint(uint256 skuId, address to, uint256 amount) external override {
        _mint(to, skuId, amount, "");
        emit UnitsMinted(skuId, to, amount);
    }

    // TODO: implement in Phase 1
    function redeem(uint256 skuId, uint256 amount, string calldata shippingRef)
        external override returns (uint256 redemptionId)
    {
        _burn(msg.sender, skuId, amount);
        redemptionId = _nextRedemptionId++;
        emit UnitsRedeemed(skuId, msg.sender, amount, redemptionId);
    }
}

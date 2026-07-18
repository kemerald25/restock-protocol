// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IMarketplace } from "./interfaces/IMarketplace.sol";
import { IClaimToken } from "./interfaces/IClaimToken.sol";
import { ISKURegistry } from "./interfaces/ISKURegistry.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title Marketplace
 * @notice Real implementation of the Marketplace for Restock Protocol.
 * Handles listing creation, cancellations, and reservations.
 * Fulfillments are implemented with stablecoin payments and royalty routing.
 * 
 * LIMITATIONS & DESIGN TRADEOFFS:
 * 1. Transfer-Away Risk: Listings do not escrow tokens. A seller can list tokens,
 *    then transfer them away. Any subsequent fulfillReservation call will revert.
 *    This is an accepted tradeoff for simplicity in Phase 0-4.
 * 2. Double-Listing Risk: A seller can create multiple simultaneous listings for 
 *    the same token balance (e.g. listing the same 5 tokens across three separate
 *    listings of 5 units each). Because the marketplace checks balance only at 
 *    creation time (and does not escrow), this can result in multiple reservations
 *    being made against the same physical token backing, which will cause all but 
 *    the first fulfillment to fail. This is a recognized limitation of the current
 *    no-escrow system.
 */
contract Marketplace is IMarketplace, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private _nextListingId = 1;
    uint256 private _nextReservationId = 1;

    IClaimToken public immutable claimToken;
    ISKURegistry public immutable skuRegistry;
    IERC20 public immutable stableToken;

    // 120 seconds reservation TTL
    uint256 public constant RESERVATION_TTL = 120;

    // Core onchain storage
    mapping(uint256 => Listing) private _listings;
    mapping(uint256 => Reservation) private _reservations;

    // Tracks quantity currently locked by active reservations per listing.
    // Avoids gas-intensive loops to determine available unreserved inventory.
    mapping(uint256 => uint256) private _reservedQuantities;

    constructor(IClaimToken _claimToken, ISKURegistry _skuRegistry, IERC20 _stableToken) {
        require(address(_claimToken) != address(0), "Marketplace: invalid claim token address");
        require(address(_skuRegistry) != address(0), "Marketplace: invalid registry address");
        require(address(_stableToken) != address(0), "Marketplace: invalid stable token address");
        claimToken = _claimToken;
        skuRegistry = _skuRegistry;
        stableToken = _stableToken;
    }

    /// @notice Creates a new listing. Verifies seller holds enough tokens.
    function createListing(uint256 skuId, uint256 quantity, uint256 pricePerUnit)
        external override returns (uint256 listingId)
    {
        require(quantity > 0, "Marketplace: quantity must be greater than 0");
        require(pricePerUnit > 0, "Marketplace: price must be greater than 0");

        // Verify SKU exists in the registry (reverts if not found)
        skuRegistry.getSKU(skuId);

        // Verify seller holds enough token balance
        require(
            claimToken.balanceOf(msg.sender, skuId) >= quantity,
            "Marketplace: seller has insufficient token balance"
        );

        listingId = _nextListingId++;
        _listings[listingId] = Listing({
            listingId: listingId,
            skuId: skuId,
            seller: msg.sender,
            quantity: quantity,
            pricePerUnit: pricePerUnit,
            status: ListingStatus.Open,
            createdAt: block.timestamp
        });

        emit Listed(listingId, skuId, msg.sender, quantity, pricePerUnit);
    }

    /// @notice Cancels an open listing. Fails if active reservations exist.
    function cancelListing(uint256 listingId) external override {
        Listing storage listing = _listings[listingId];
        require(listing.seller != address(0), "Marketplace: listing does not exist");
        require(listing.seller == msg.sender, "Marketplace: caller is not the seller");
        require(listing.status == ListingStatus.Open, "Marketplace: listing is not open");
        
        // Block cancellation if active reservations still lock quantity
        require(_reservedQuantities[listingId] == 0, "Marketplace: listing has active reservations");

        listing.status = ListingStatus.Cancelled;
        emit ListingCancelled(listingId);
    }

    /// @notice Locks quantity units for a buyer for 120s. Enforces unreserved supply availability.
    function reserve(uint256 listingId, uint256 quantity) external override returns (uint256 reservationId) {
        Listing memory listing = _listings[listingId];
        require(listing.seller != address(0), "Marketplace: listing does not exist");
        require(listing.status == ListingStatus.Open, "Marketplace: listing is not open");
        require(quantity > 0, "Marketplace: quantity must be greater than 0");

        // Double-locking check
        uint256 available = listing.quantity - _reservedQuantities[listingId];
        require(quantity <= available, "Marketplace: insufficient unreserved quantity");

        reservationId = _nextReservationId++;
        uint256 expiresAt = block.timestamp + RESERVATION_TTL;

        _reservations[reservationId] = Reservation({
            reservationId: reservationId,
            listingId: listingId,
            buyer: msg.sender,
            quantity: quantity,
            expiresAt: expiresAt,
            status: ReservationStatus.Active
        });

        _reservedQuantities[listingId] += quantity;

        emit Reserved(reservationId, listingId, msg.sender, quantity, expiresAt);
    }

    /// @notice Sweeps an expired reservation to free up unreserved inventory. Permissionless.
    function releaseExpiredReservation(uint256 reservationId) external override {
        Reservation storage res = _reservations[reservationId];
        require(res.buyer != address(0), "Marketplace: reservation does not exist");
        require(res.status == ReservationStatus.Active, "Marketplace: reservation is not active");
        require(block.timestamp > res.expiresAt, "Marketplace: reservation has not expired yet");

        res.status = ReservationStatus.Expired;
        _reservedQuantities[res.listingId] -= res.quantity;

        emit ReservationExpired(reservationId);
    }

    /// @notice Completes purchase against an ACTIVE, non-expired reservation.
    /// Performs atomic token transfer, stablecoin payment collection, and merchant royalty splitting.
    /// Restricted to buyer only, protected against reentrancy.
    function fulfillReservation(uint256 reservationId) external override nonReentrant {
        Reservation storage res = _reservations[reservationId];
        require(res.buyer != address(0), "Marketplace: reservation does not exist");
        require(res.status == ReservationStatus.Active, "Marketplace: reservation is not active");
        require(block.timestamp <= res.expiresAt, "Marketplace: reservation expired, use releaseExpiredReservation");
        require(msg.sender == res.buyer, "Marketplace: caller must be the buyer");

        Listing storage listing = _listings[res.listingId];
        require(listing.status == ListingStatus.Open, "Marketplace: listing is not open");

        // 1. Effects: Transition status and quantities (Checks-Effects-Interactions)
        res.status = ReservationStatus.Completed;
        listing.quantity -= res.quantity;
        _reservedQuantities[res.listingId] -= res.quantity;

        if (listing.quantity == 0) {
            listing.status = ListingStatus.Filled;
        }

        // 2. Calculations
        uint256 totalDue = res.quantity * listing.pricePerUnit;
        ISKURegistry.SKUInfo memory sku = skuRegistry.getSKU(listing.skuId);
        
        // Division truncates (rounds down) in Solidity, meaning any fractional remainder
        // in the royalty calculation is retained by the seller. This favors the seller.
        uint256 royaltyAmount = (totalDue * sku.royaltyBps) / 10000;
        uint256 sellerAmount = totalDue - royaltyAmount;

        // 3. Interactions: Atomic value movement
        // Pull payment from buyer to the Marketplace contract (requires prior approval)
        stableToken.safeTransferFrom(res.buyer, address(this), totalDue);

        // Distribute payment to the SKU merchant and the seller
        if (royaltyAmount > 0) {
            stableToken.safeTransfer(sku.merchant, royaltyAmount);
        }
        if (sellerAmount > 0) {
            stableToken.safeTransfer(listing.seller, sellerAmount);
        }

        // Transfer claim tokens from seller to buyer (requires seller ERC-1155 approval)
        claimToken.safeTransferFrom(listing.seller, res.buyer, listing.skuId, res.quantity, "");

        emit Purchased(res.listingId, res.buyer, res.quantity, totalDue, royaltyAmount);
    }

    /// @notice Retrieves listing details stored onchain.
    function getListing(uint256 listingId) external view override returns (
        uint256 skuId, address seller, uint256 quantity, uint256 pricePerUnit, uint8 status
    ) {
        Listing memory listing = _listings[listingId];
        require(listing.seller != address(0), "Marketplace: listing does not exist");
        return (listing.skuId, listing.seller, listing.quantity, listing.pricePerUnit, uint8(listing.status));
    }

    /// @notice Retrieves reservation details stored onchain.
    function getReservation(uint256 reservationId) external view override returns (Reservation memory) {
        Reservation memory res = _reservations[reservationId];
        require(res.buyer != address(0), "Marketplace: reservation does not exist");
        return res;
    }
}

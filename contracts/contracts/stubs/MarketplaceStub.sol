// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IMarketplace } from "../interfaces/IMarketplace.sol";

contract MarketplaceStub is IMarketplace {
    uint256 private _nextListingId = 1;
    uint256 private _nextReservationId = 1;

    // Core onchain storage confirming the design decision to keep reservations and listings onchain
    mapping(uint256 => Listing) private _listings;
    mapping(uint256 => Reservation) private _reservations;

    // TODO: implement in Phase 1
    function createListing(uint256 skuId, uint256 quantity, uint256 pricePerUnit)
        external override returns (uint256 listingId)
    {
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

    // TODO: implement in Phase 1
    function cancelListing(uint256 listingId) external override {
        Listing storage listing = _listings[listingId];
        listing.status = ListingStatus.Cancelled;
        emit ListingCancelled(listingId);
    }

    // TODO: implement in Phase 1
    function reserve(uint256 listingId, uint256 quantity) external override returns (uint256 reservationId) {
        reservationId = _nextReservationId++;
        uint256 expiresAt = block.timestamp + 120; // 120s TTL
        _reservations[reservationId] = Reservation({
            reservationId: reservationId,
            listingId: listingId,
            buyer: msg.sender,
            quantity: quantity,
            expiresAt: expiresAt,
            status: ReservationStatus.Active
        });
        emit Reserved(reservationId, listingId, msg.sender, quantity, expiresAt);
    }

    // TODO: implement in Phase 1
    function fulfillReservation(uint256 reservationId) external override {
        Reservation storage res = _reservations[reservationId];
        res.status = ReservationStatus.Completed;
        
        Listing storage listing = _listings[res.listingId];
        listing.status = ListingStatus.Filled;
        
        emit Purchased(res.listingId, res.buyer, res.quantity, listing.pricePerUnit * res.quantity, 0);
    }

    // TODO: implement in Phase 1
    function releaseExpiredReservation(uint256 reservationId) external override {
        Reservation storage res = _reservations[reservationId];
        res.status = ReservationStatus.Expired;
        emit ReservationExpired(reservationId);
    }

    // TODO: implement in Phase 1
    function getListing(uint256 listingId) external view override returns (
        uint256 skuId, address seller, uint256 quantity, uint256 pricePerUnit, uint8 status
    ) {
        Listing memory listing = _listings[listingId];
        return (listing.skuId, listing.seller, listing.quantity, listing.pricePerUnit, uint8(listing.status));
    }

    // TODO: implement in Phase 1
    function getReservation(uint256 reservationId) external view override returns (Reservation memory) {
        return _reservations[reservationId];
    }
}

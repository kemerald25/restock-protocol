// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMarketplace {
    enum ListingStatus { Open, Filled, Cancelled }
    enum ReservationStatus { Active, Completed, Expired, Cancelled }

    struct Listing {
        uint256 listingId;
        uint256 skuId;
        address seller;
        uint256 quantity;
        uint256 pricePerUnit;
        ListingStatus status;
        uint256 createdAt;
    }

    struct Reservation {
        uint256 reservationId;
        uint256 listingId;
        address buyer;
        uint256 quantity;
        uint256 expiresAt;
        ReservationStatus status;
    }

    event Listed(uint256 indexed listingId, uint256 indexed skuId, address indexed seller, uint256 quantity, uint256 pricePerUnit);
    event Reserved(uint256 indexed reservationId, uint256 indexed listingId, address indexed buyer, uint256 quantity, uint256 expiresAt);
    event Purchased(uint256 indexed listingId, address indexed buyer, uint256 quantity, uint256 totalPaid, uint256 royaltyPaid);
    event ListingCancelled(uint256 indexed listingId);
    event ReservationExpired(uint256 indexed reservationId);

    function createListing(uint256 skuId, uint256 quantity, uint256 pricePerUnit)
        external returns (uint256 listingId);

    function cancelListing(uint256 listingId) external;

    /// @notice Locks `quantity` units of a listing for `buyer` for a fixed TTL.
    /// MUST fail if requested quantity exceeds what's unreserved on that listing.
    function reserve(uint256 listingId, uint256 quantity) external returns (uint256 reservationId);

    /// @notice Completes purchase against an ACTIVE, non-expired reservation.
    /// MUST: (1) verify reservation ownership + expiry, (2) pull stablecoin
    /// payment, (3) split royalty to SKU.merchant, (4) transfer claim tokens,
    /// (5) mark reservation Completed and listing partially/fully Filled.
    function fulfillReservation(uint256 reservationId) external;

    /// @notice Anyone can call this to sweep an expired reservation back to
    /// available inventory — needed so expired locks don't permanently freeze supply.
    function releaseExpiredReservation(uint256 reservationId) external;

    function getListing(uint256 listingId) external view returns (
        uint256 skuId, address seller, uint256 quantity, uint256 pricePerUnit, uint8 status
    );

    /// @notice Retrieves reservation details stored onchain.
    function getReservation(uint256 reservationId) external view returns (Reservation memory);
}

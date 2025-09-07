// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Muaban — Escrow Commerce (MVP, no-admin keys)
 *
 * - Listings priced in USD-6 (1 USD = 1_000_000)
 * - Payments in VIN (ERC-20, 18 decimals)
 * - VIN token address is hardcoded for Viction Mainnet
 * - No on-chain FX: dApp computes exact VIN off-chain
 * - One-time registration fee per wallet: 0.001 VIN
 *      -> transferred directly to FEE_RECIPIENT
 * - Escrow flow:
 *      Buyer deposits VIN into contract when placing an order (escrow).
 *      Seller marks shipped (off-chain logistics).
 *      Buyer confirms receipt -> contract releases VIN (tax -> taxWallet, remainder -> payoutWallet).
 *      If buyer does not confirm by deadline -> anyone can trigger auto-refund back to buyer.
 * - Seller profile & product metadata live on IPFS/Pinata; contract stores only URI + content hash.
 *
 * Security:
 * - No owner / no pause / no mutable config / no rescue.
 * - Reentrancy guarded on token-moving functions.
 * - Accounting via totalEscrowedVin to separate user escrow from anything else.
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract Muaban is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ===== Hardcoded VIN (Viction Mainnet) =====
    // VIN token: 0x941F63807401efCE8afe3C9d88d368bAA287Fac4
    IERC20 public constant VIN = IERC20(0x941F63807401efCE8afe3C9d88d368bAA287Fac4);

    // ===== Immutable fee recipient =====
    address public immutable FEE_RECIPIENT;      // wallet receiving registration fees

    // ===== Constants =====
    uint256 public constant REGISTRATION_FEE = 1e15; // 0.001 VIN (VIN has 18 decimals)
    uint256 public constant CONFIRM_WINDOW   = 3 days;

    // ===== Registration =====
    mapping(address => bool) public registered;

    // ===== Data Types =====

    /// @notice Off-chain seller profile anchor (PII kept in IPFS/Pinata)
    struct SellerProfile {
        string  profileURI;   // ipfs://... seller profile (private link or encrypted)
        bytes32 profileHash;  // keccak256/sha256 hash of profile content for integrity check
    }

    /// @notice Listing entry
    struct Listing {
        address seller;        // listing owner (must be registered)
        address payoutWallet;  // seller revenue wallet
        address taxWallet;     // seller tax wallet (for compliance)
        uint16  taxBps;        // tax in basis points (10_000 = 100%)
        uint256 priceUsd6;     // unit price in USD-6 (e.g., 10 USD = 10_000_000)
        uint256 inventory;     // available quantity
        bool    active;        // listing enabled?
        string  productURI;    // ipfs://... product media/description
        bytes32 productHash;   // hash of product content
    }

    /// @notice Order lifecycle
    enum OrderStatus { None, Escrowed, Released, Refunded, Cancelled }

    /// @notice Order stored on-chain (escrow)
    struct Order {
        uint256 listingId;
        address buyer;
        address seller;         // snapshot
        address payoutWallet;   // snapshot
        address taxWallet;      // snapshot
        uint16  taxBps;         // snapshot
        uint256 qty;
        uint256 vinAmount;      // exact VIN escrowed (computed off-chain)
        uint256 createdAt;
        uint256 confirmDeadline;   // createdAt + CONFIRM_WINDOW

        // Transparency-only snapshots (not used for math):
        uint256 priceUsd6Unit;  // USD-6 unit price at order placement
        uint256 vinPerUnit;     // VIN per unit (off-chain computed)
        string  contactURI;     // ipfs://... buyer contact (private/encrypted)
        bytes32 contactHash;    // integrity check

        OrderStatus status;
        bool    sellerMarked;   // seller marked "shipped/sent"
    }

    // ===== Storage =====
    mapping(address => SellerProfile) public sellerProfiles;

    mapping(uint256 => Listing) public listings;
    uint256 public nextListingId = 1;

    mapping(uint256 => Order) public orders;
    uint256 public nextOrderId = 1;

    // Tracks all VIN currently held in escrow across orders.
    uint256 public totalEscrowedVin;

    // ===== Events =====
    event Registered(address indexed wallet, uint256 fee);

    event SellerProfileUpdated(address indexed seller, string profileURI, bytes32 profileHash);

    event ListingCreated(
        uint256 indexed id,
        address indexed seller,
        address payoutWallet,
        address taxWallet,
        uint16  taxBps,
        uint256 priceUsd6,
        uint256 inventory,
        bool    active,
        string  productURI,
        bytes32 productHash
    );

    event ListingUpdated(
        uint256 indexed id,
        address payoutWallet,
        address taxWallet,
        uint16  taxBps,
        uint256 priceUsd6,
        uint256 inventory,
        bool    active,
        string  productURI,
        bytes32 productHash
    );

    // NEW: granular, gas-friendly events for quick toggles
    event ListingActiveChanged(uint256 indexed id, bool active);
    event InventoryUpdated(uint256 indexed id, uint256 inventory);

    // NOTE: contactURI removed from event to reduce metadata exposure in logs
    event OrderPlaced(
        uint256 indexed orderId,
        uint256 indexed listingId,
        address indexed buyer,
        address seller,
        uint256 qty,
        uint256 priceUsd6Unit,
        uint256 vinPerUnit,
        uint256 vinAmount,
        uint256 createdAt,
        uint256 confirmDeadline,
        bytes32 contactHash
    );

    event SellerMarked(uint256 indexed orderId, address indexed seller, uint256 at);
    event OrderReleased(uint256 indexed orderId, address indexed buyer, address indexed seller, uint256 vinToSeller, uint256 vinTax);
    event OrderRefunded(uint256 indexed orderId, address indexed buyer, uint256 vinAmount);
    event OrderCancelled(uint256 indexed orderId, address indexed caller);

    // ===== Errors =====
    error AlreadyRegistered();
    error NotRegistered();
    error ZeroAddress();
    error InvalidListing();
    error Inactive();
    error InsufficientInventory();
    error InvalidQty();
    error InvalidValue();
    error NotBuyer();
    error NotSeller();
    error BadStatus();
    error TooEarly();
    error NothingToDo();

    // ===== Constructor =====

    /**
     * @param feeRecipient  wallet receiving the one-time registration fees
     */
    constructor(address feeRecipient) {
        if (feeRecipient == address(0)) revert ZeroAddress();
        FEE_RECIPIENT = feeRecipient;
    }

    // ===== Registration =====

/// @notice One-time registration for any wallet (buyer or seller)
function register() external nonReentrant {
    if (registered[msg.sender]) revert AlreadyRegistered();

    // Transfer the fixed registration fee directly to the fee recipient
    VIN.safeTransferFrom(msg.sender, FEE_RECIPIENT, REGISTRATION_FEE);

    registered[msg.sender] = true;
    emit Registered(msg.sender, REGISTRATION_FEE);
}


    // ===== Seller profile (PII kept off-chain; store URI + hash) =====

    function updateSellerProfile(string calldata profileURI, bytes32 profileHash) external {
        if (!registered[msg.sender]) revert NotRegistered();
        sellerProfiles[msg.sender] = SellerProfile({
            profileURI: profileURI,
            profileHash: profileHash
        });
        emit SellerProfileUpdated(msg.sender, profileURI, profileHash);
    }

    // ===== Listings =====

    /**
     * @dev Create a new listing. Inventory must be > 0 on creation.
     */
    function createListing(
        address payoutWallet,
        address taxWallet,
        uint16  taxBps,
        uint256 priceUsd6,
        uint256 inventory,
        bool    active,
        string calldata productURI,
        bytes32 productHash
    ) external returns (uint256 id) {
        if (!registered[msg.sender]) revert NotRegistered();
        if (payoutWallet == address(0) || taxWallet == address(0)) revert ZeroAddress();
        if (taxBps > 10_000) revert InvalidValue();   // >100%
        if (priceUsd6 == 0) revert InvalidValue();
        if (inventory == 0) revert InvalidValue();

        id = nextListingId++;

        listings[id] = Listing({
            seller:        msg.sender,
            payoutWallet:  payoutWallet,
            taxWallet:     taxWallet,
            taxBps:        taxBps,
            priceUsd6:     priceUsd6,
            inventory:     inventory,
            active:        active,
            productURI:    productURI,
            productHash:   productHash
        });

        emit ListingCreated(
            id,
            msg.sender,
            payoutWallet,
            taxWallet,
            taxBps,
            priceUsd6,
            inventory,
            active,
            productURI,
            productHash
        );
    }

    /**
     * @dev Update a listing. Allows inventory to be set to any value (including 0).
     */
    function updateListing(
        uint256 id,
        address payoutWallet,
        address taxWallet,
        uint16  taxBps,
        uint256 priceUsd6,
        uint256 inventory,
        bool    active,
        string calldata productURI,
        bytes32 productHash
    ) external {
        Listing storage L = listings[id];
        if (L.seller == address(0)) revert InvalidListing();
        if (msg.sender != L.seller) revert NotSeller();

        if (payoutWallet == address(0) || taxWallet == address(0)) revert ZeroAddress();
        if (taxBps > 10_000) revert InvalidValue();     // >100%
        if (priceUsd6 == 0) revert InvalidValue();

        L.payoutWallet = payoutWallet;
        L.taxWallet    = taxWallet;
        L.taxBps       = taxBps;
        L.priceUsd6    = priceUsd6;
        L.inventory    = inventory; // zero allowed here; seller may also use setInventory()
        L.active       = active;
        L.productURI   = productURI;
        L.productHash  = productHash;

        emit ListingUpdated(
            id,
            payoutWallet,
            taxWallet,
            taxBps,
            priceUsd6,
            inventory,
            active,
            productURI,
            productHash
        );
    }

    /// @notice Toggle active flag without touching other fields.
    function setListingActive(uint256 id, bool active) external {
        Listing storage L = listings[id];
        if (L.seller == address(0)) revert InvalidListing();
        if (msg.sender != L.seller) revert NotSeller();
        L.active = active;
        emit ListingActiveChanged(id, active);
    }

    /// @notice Adjust inventory (allows zero to effectively pause via stock).
    function setInventory(uint256 id, uint256 newInventory) external {
        Listing storage L = listings[id];
        if (L.seller == address(0)) revert InvalidListing();
        if (msg.sender != L.seller) revert NotSeller();
        L.inventory = newInventory;
        emit InventoryUpdated(id, newInventory);
    }

    // ===== Orders & Escrow =====

    /**
     * Buyer places an order:
     * - Buyer and listing's seller must be registered.
     * - Transfers exact VIN from buyer to the contract (escrow).
     * - Decreases inventory immediately.
     * - Sets confirm deadline = now + CONFIRM_WINDOW.
     *
     * @param listingId     target listing
     * @param qty           quantity to buy (must be > 0 and <= inventory)
     * @param vinAmount     exact VIN escrowed (computed off-chain)
     * @param priceUsd6Unit snapshot USD-6 unit price (for transparency/log only)
     * @param vinPerUnit    snapshot VIN per unit (off-chain; for log only)
     * @param contactURI    ipfs://... buyer contact info (private/limited access)
     * @param contactHash   keccak256/sha256 of the contact content (integrity check)
     */
    function placeOrder(
        uint256 listingId,
        uint256 qty,
        uint256 vinAmount,
        uint256 priceUsd6Unit,
        uint256 vinPerUnit,
        string calldata contactURI,
        bytes32 contactHash
    ) external nonReentrant returns (uint256 orderId) {
        if (!registered[msg.sender]) revert NotRegistered();
        if (qty == 0) revert InvalidQty();
        if (vinAmount == 0) revert InvalidValue();

        Listing storage L = listings[listingId];
        if (L.seller == address(0)) revert InvalidListing();
        if (!L.active) revert Inactive();
        if (!registered[L.seller]) revert NotRegistered();
        if (qty > L.inventory) revert InsufficientInventory();

        // Transfer VIN from buyer to escrow
        VIN.safeTransferFrom(msg.sender, address(this), vinAmount);
        totalEscrowedVin += vinAmount;

        // Decrease inventory
        L.inventory -= qty;

        // Create order
        orderId = nextOrderId++;
        orders[orderId] = Order({
            listingId:        listingId,
            buyer:            msg.sender,
            seller:           L.seller,
            payoutWallet:     L.payoutWallet,
            taxWallet:        L.taxWallet,
            taxBps:           L.taxBps,
            qty:              qty,
            vinAmount:        vinAmount,
            createdAt:        block.timestamp,
            confirmDeadline:  block.timestamp + CONFIRM_WINDOW,
            priceUsd6Unit:    priceUsd6Unit,
            vinPerUnit:       vinPerUnit,
            contactURI:       contactURI,
            contactHash:      contactHash,
            status:           OrderStatus.Escrowed,
            sellerMarked:     false
        });

        // Emit without contactURI to reduce metadata exposure in logs
        emit OrderPlaced(
            orderId,
            listingId,
            msg.sender,
            L.seller,
            qty,
            priceUsd6Unit,
            vinPerUnit,
            vinAmount,
            block.timestamp,
            block.timestamp + CONFIRM_WINDOW,
            contactHash
        );
    }

    /**
     * @notice Seller marks the order as "shipped/sent".
     *         Procedural only; used for UX & state tracking (no funds move).
     */
    function sellerMarkShipped(uint256 orderId) external {
        Order storage O = orders[orderId];
        if (O.status != OrderStatus.Escrowed) revert BadStatus();
        if (msg.sender != O.seller) revert NotSeller();
        if (O.sellerMarked) revert NothingToDo();

        O.sellerMarked = true;
        emit SellerMarked(orderId, msg.sender, block.timestamp);
    }

    /**
     * @notice Buyer confirms receipt -> release funds to seller & tax wallet.
     */
    function buyerRelease(uint256 orderId) external nonReentrant {
        Order storage O = orders[orderId];
        if (O.status != OrderStatus.Escrowed) revert BadStatus();
        if (msg.sender != O.buyer) revert NotBuyer();

        // Compute tax & revenue
        uint256 vinTax = (O.vinAmount * O.taxBps) / 10_000;
        uint256 vinSeller = O.vinAmount - vinTax;

        // Update status first (checks-effects-interactions)
        O.status = OrderStatus.Released;
        totalEscrowedVin -= O.vinAmount;

        // Payouts
        if (vinTax > 0) {
            VIN.safeTransfer(O.taxWallet, vinTax);
        }
        VIN.safeTransfer(O.payoutWallet, vinSeller);

        emit OrderReleased(orderId, O.buyer, O.seller, vinSeller, vinTax);
    }

    /**
     * @notice Timeout refund (permissionless):
     *         Anyone can call after confirmDeadline if still Escrowed.
     *         Refunds full VIN to buyer; status -> Refunded.
     */
    function claimTimeoutRefund(uint256 orderId) external nonReentrant {
        Order storage O = orders[orderId];
        if (O.status != OrderStatus.Escrowed) revert BadStatus();
        if (block.timestamp <= O.confirmDeadline) revert TooEarly();

        O.status = OrderStatus.Refunded;
        totalEscrowedVin -= O.vinAmount;
        VIN.safeTransfer(O.buyer, O.vinAmount);

        emit OrderRefunded(orderId, O.buyer, O.vinAmount);
    }

    /**
     * @notice Buyer cancels the order before seller has marked shipped.
     *         Status must be Escrowed and sellerMarked == false.
     *         Refund VIN to buyer and restock inventory.
     */
    function buyerCancelBeforeShipped(uint256 orderId) external nonReentrant {
        Order storage O = orders[orderId];
        if (O.status != OrderStatus.Escrowed) revert BadStatus();
        if (msg.sender != O.buyer) revert NotBuyer();
        if (O.sellerMarked) revert TooEarly(); // already marked shipped -> cannot cancel

        // Restock inventory
        Listing storage L = listings[O.listingId];
        if (L.seller == address(0)) revert InvalidListing();
        L.inventory += O.qty;

        // Refund & close
        O.status = OrderStatus.Cancelled;
        totalEscrowedVin -= O.vinAmount;
        VIN.safeTransfer(O.buyer, O.vinAmount);

        emit OrderCancelled(orderId, msg.sender);
    }

    // ===== Views =====

    /// @notice Quick read of balances for transparency.
    function contractBalances()
        external
        view
        returns (uint256 vinBalance, uint256 escrowedVin, uint256 withdrawableFeesVin)
    {
        vinBalance = VIN.balanceOf(address(this));
        escrowedVin = totalEscrowedVin;
        withdrawableFeesVin = 0; // fees go directly to FEE_RECIPIENT; contract holds only escrow
    }

    /// @notice Return full listing struct
    function getListing(uint256 id) external view returns (Listing memory) {
        if (listings[id].seller == address(0)) revert InvalidListing();
        return listings[id];
    }

    /// @notice Return full order struct
    function getOrder(uint256 orderId) external view returns (Order memory) {
        return orders[orderId];
    }
}

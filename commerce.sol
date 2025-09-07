// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Muaban — Escrow Commerce (MVP)
 *
 * - Listings are priced in USD-6 (1 USD = 1_000_000)
 * - Payments are in VIN (ERC-20, 18 decimals)
 * - No on-chain FX: the dApp computes VIN amount off-chain and sends exact VIN
 * - One-time registration fee per wallet (buyer or seller): 0.001 VIN
 * - Escrow flow:
 *      Buyer deposits VIN into contract (escrow) when placing an order.
 *      Seller ships/marks shipped.
 *      Buyer confirms receipt -> contract releases VIN (minus tax) to seller and tax wallet.
 *      If buyer does not confirm by deadline -> contract auto-refunds to buyer.
 * - Tax per listing via BPS (basis points), sent at release time.
 * - PII and product media live on IPFS/Pinata; contract stores only URI + content hash.
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract Muaban is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ===== Config =====
    IERC20 public immutable VIN;            // VIN token (ERC-20, 18 decimals)
    uint256 public registrationFee = 1e15;  // 0.001 VIN (10^15 wei, since VIN has 18 decimals)
    uint256 public confirmWindow = 3 days;  // time window for buyer confirmation

    // ===== Registration =====
    mapping(address => bool) public registered;

    // ===== Data Types =====
    struct SellerProfile {
        string  profileURI;   // ipfs://... seller profile (PII off-chain)
        bytes32 profileHash;  // hash of profile content (integrity check)
    }

    struct Listing {
        address seller;        // listing owner (must be registered)
        address payoutWallet;  // seller's revenue wallet
        address taxWallet;     // seller's tax wallet (for compliance)
        uint16  taxBps;        // tax in basis points (10_000 = 100%)
        uint256 priceUsd6;     // unit price in USD-6 (e.g., 10 USD = 10_000_000)
        uint256 inventory;     // available quantity
        bool    active;        // listing enabled?
        string  productURI;    // ipfs://... product media/description
        bytes32 productHash;   // hash of product content
    }

    enum OrderStatus { None, Escrowed, Released, Refunded, Cancelled }

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
        uint256 confirmDeadline;   // createdAt + confirmWindow

        // Transparency-only snapshots (not used for math):
        uint256 priceUsd6Unit;  // USD-6 unit price at order placement
        uint256 vinPerUnit;     // VIN per unit (off-chain computed)
        string  contactURI;     // ipfs://... buyer contact (private link / encrypted)
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

    // ===== Events =====
    event Registered(address indexed wallet, uint256 fee);
    event RegistrationFeeUpdated(uint256 newFee);
    event ConfirmWindowUpdated(uint256 newWindow);

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
        string  contactURI,
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

    constructor(IERC20 vinToken, address initialOwner) {
        if (address(vinToken) == address(0) || initialOwner == address(0)) revert ZeroAddress();
        VIN = vinToken;                 // pass 0x941F63807401efCE8afe3C9d88d368bAA287Fac4 at deployment
        _transferOwnership(initialOwner);
    }
}
    // ===== Admin (owner) config =====
    function setRegistrationFee(uint256 newFee) external onlyOwner {
        registrationFee = newFee;
        emit RegistrationFeeUpdated(newFee);
    }

    function setConfirmWindow(uint256 newWindow) external onlyOwner {
        require(newWindow > 0, "confirmWindow=0");
        confirmWindow = newWindow;
        emit ConfirmWindowUpdated(newWindow);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ===== Registration (one-time per wallet) =====
    function register() external whenNotPaused {
        if (registered[msg.sender]) revert AlreadyRegistered();
        if (registrationFee == 0) revert InvalidValue();

        // collect VIN fee from caller
        VIN.safeTransferFrom(msg.sender, address(this), registrationFee);

        registered[msg.sender] = true;
        emit Registered(msg.sender, registrationFee);
    }

    // ===== Seller profile (PII kept off-chain; store URI + hash) =====
    function updateSellerProfile(string calldata profileURI, bytes32 profileHash) external whenNotPaused {
        if (!registered[msg.sender]) revert NotRegistered();
        sellerProfiles[msg.sender] = SellerProfile({
            profileURI: profileURI,
            profileHash: profileHash
        });
        emit SellerProfileUpdated(msg.sender, profileURI, profileHash);
    }

    // ===== Listings =====
    function createListing(
        address payoutWallet,
        address taxWallet,
        uint16  taxBps,
        uint256 priceUsd6,
        uint256 inventory,
        bool    active,
        string calldata productURI,
        bytes32 productHash
    ) external whenNotPaused returns (uint256 id) {
        if (!registered[msg.sender]) revert NotRegistered();
        if (payoutWallet == address(0) || taxWallet == address(0)) revert ZeroAddress();
        if (taxBps > 10_000) revert InvalidValue();              // >100%
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
    ) external whenNotPaused {
        Listing storage L = listings[id];
        if (L.seller == address(0)) revert InvalidListing();
        if (msg.sender != L.seller) revert NotSeller();

        if (payoutWallet == address(0) || taxWallet == address(0)) revert ZeroAddress();
        if (taxBps > 10_000) revert InvalidValue();
        if (priceUsd6 == 0) revert InvalidValue();
        if (inventory == 0) revert InvalidValue();

        L.payoutWallet = payoutWallet;
        L.taxWallet    = taxWallet;
        L.taxBps       = taxBps;
        L.priceUsd6    = priceUsd6;
        L.inventory    = inventory;
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
    // ===== Orders & Escrow =====

    /**
     * Buyer places an order:
     * - Requires both buyer and listing's seller to be registered (buyer must register too).
     * - Transfers exact VIN from buyer to the contract (escrow).
     * - Decreases inventory immediately.
     * - Sets confirm deadline = now + confirmWindow.
     *
     * @param listingId     target listing
     * @param qty           quantity to buy (must be > 0 and <= inventory)
     * @param vinAmount     exact VIN escrowed (computed off-chain)
     * @param priceUsd6Unit snapshot USD-6 unit price (for transparency/log only)
     * @param vinPerUnit    snapshot VIN per unit (off-chain; for log only)
     * @param contactURI    ipfs://... buyer contact info (private/limited access)
     * @param contactHash   keccak256 of the contact content (integrity check)
     */
    function placeOrder(
        uint256 listingId,
        uint256 qty,
        uint256 vinAmount,
        uint256 priceUsd6Unit,
        uint256 vinPerUnit,
        string calldata contactURI,
        bytes32 contactHash
    ) external whenNotPaused nonReentrant returns (uint256 orderId) {
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
            confirmDeadline:  block.timestamp + confirmWindow,
            priceUsd6Unit:    priceUsd6Unit,
            vinPerUnit:       vinPerUnit,
            contactURI:       contactURI,
            contactHash:      contactHash,
            status:           OrderStatus.Escrowed,
            sellerMarked:     false
        });

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
            block.timestamp + confirmWindow,
            contactURI,
            contactHash
        );
    }

    /**
     * Seller marks the order as "shipped/sent".
     * - Purely procedural (no funds move); used for UX & state tracking.
     */
    function sellerMarkShipped(uint256 orderId) external whenNotPaused {
        Order storage O = orders[orderId];
        if (O.status != OrderStatus.Escrowed) revert BadStatus();
        if (msg.sender != O.seller) revert NotSeller();
        if (O.sellerMarked) revert NothingToDo();

        O.sellerMarked = true;
        emit SellerMarked(orderId, msg.sender, block.timestamp);
    }

    /**
     * Buyer confirms receipt -> release funds:
     * - Splits VIN into tax + seller revenue using snapshot taxBps/wallets.
     * - Updates status to Released.
     */
    function buyerRelease(uint256 orderId) external whenNotPaused nonReentrant {
        Order storage O = orders[orderId];
        if (O.status != OrderStatus.Escrowed) revert BadStatus();
        if (msg.sender != O.buyer) revert NotBuyer();

        // Compute tax & revenue
        uint256 vinTax = (O.vinAmount * O.taxBps) / 10_000;
        uint256 vinSeller = O.vinAmount - vinTax;

        // Update status first (checks-effects-interactions)
        O.status = OrderStatus.Released;

        // Payouts
        if (vinTax > 0) {
            VIN.safeTransfer(O.taxWallet, vinTax);
        }
        VIN.safeTransfer(O.payoutWallet, vinSeller);

        emit OrderReleased(orderId, O.buyer, O.seller, vinSeller, vinTax);
    }

    /**
     * Timeout refund (permissionless):
     * - Anyone can call after confirmDeadline if still Escrowed.
     * - Refund full VIN to buyer; status -> Refunded.
     *
     * Note: "Auto" in blockchain means "callable by anyone"; a front-end/bot can
     *       trigger this to ensure liveness.
     */
    function claimTimeoutRefund(uint256 orderId) external nonReentrant {
        Order storage O = orders[orderId];
        if (O.status != OrderStatus.Escrowed) revert BadStatus();
        if (block.timestamp <= O.confirmDeadline) revert TooEarly();

        O.status = OrderStatus.Refunded;
        VIN.safeTransfer(O.buyer, O.vinAmount);

        emit OrderRefunded(orderId, O.buyer, O.vinAmount);
    }

    /**
     * Buyer cancels the order before seller has marked shipped.
     * - Status must be Escrowed and sellerMarked == false.
     * - Refund VIN to buyer and restock inventory.
     */
    function buyerCancelBeforeShipped(uint256 orderId) external whenNotPaused nonReentrant {
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
        VIN.safeTransfer(O.buyer, O.vinAmount);

        emit OrderCancelled(orderId, msg.sender);
    }
    // ===== Accounting / Views / Utilities =====

    // Tracks all VIN currently held in escrow across orders.
    uint256 public totalEscrowedVin;

    /// @notice Quick read of balances for transparency.
    function contractBalances()
        external
        view
        returns (uint256 vinBalance, uint256 escrowedVin, uint256 withdrawableFeesVin)
    {
        vinBalance = VIN.balanceOf(address(this));
        escrowedVin = totalEscrowedVin;
        withdrawableFeesVin = vinBalance > escrowedVin ? (vinBalance - escrowedVin) : 0;
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

    // ===== Quick seller controls (lightweight updates) =====

    event ListingActiveChanged(uint256 indexed id, bool active);
    event InventoryUpdated(uint256 indexed id, uint256 inventory);

    /// @notice Toggle active flag without touching other fields.
    function setListingActive(uint256 id, bool active) external whenNotPaused {
        Listing storage L = listings[id];
        if (L.seller == address(0)) revert InvalidListing();
        if (msg.sender != L.seller) revert NotSeller();
        L.active = active;
        emit ListingActiveChanged(id, active);
    }

    /// @notice Adjust inventory (allows zero to pause via stock).
    function setInventory(uint256 id, uint256 newInventory) external whenNotPaused {
        Listing storage L = listings[id];
        if (L.seller == address(0)) revert InvalidListing();
        if (msg.sender != L.seller) revert NotSeller();
        L.inventory = newInventory; // zero allowed
        emit InventoryUpdated(id, newInventory);
    }

    // ===== Owner withdrawals (registration fees only) =====

    /**
     * @notice Withdraw VIN that are NOT part of escrow (i.e., accumulated registration fees).
     * Safety: only allows withdrawing the free surplus: balance - totalEscrowedVin.
     */
    function ownerWithdrawFees(uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = VIN.balanceOf(address(this));
        require(bal >= totalEscrowedVin, "escrow>balance"); // invariant check
        uint256 free = bal - totalEscrowedVin;
        require(amount <= free, "amount>free");
        VIN.safeTransfer(to, amount);
    }

    // ===== Rescue tokens sent by mistake (non-VIN only) =====
    function rescueERC20(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0) || token == address(0)) revert ZeroAddress();
        require(token != address(VIN), "no-rescue-VIN");
        IERC20(token).safeTransfer(to, amount);
    }
}


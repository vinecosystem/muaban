// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

/**
 * Muaban — Pure on-chain commerce (Viction chain)
 * Key points:
 * - One-time platform registration fee in VIN (0.001 VIN per wallet).
 * - Products priced in USD; frontend converts to VIN using VIC/USDT * 100 at purchase time.
 * - Escrowed orders; buyer confirms receipt before funds are released to seller/tax/shipping.
 * - Expired orders refundable to buyer; only refunded buyers can submit a post-expiry review.
 *
 * NOTES:
 * - No on-chain oracle: conversion is provided off-chain by the frontend.
 * - Seller’s public encryption key and buyer’s shipping ciphertext are opaque byte blobs.
 */

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address a) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amt) external returns (bool);
    function transfer(address to, uint256 amt) external returns (bool);
    function transferFrom(address from, address to, uint256 amt) external returns (bool);
    function decimals() external view returns (uint8);
}

/** Minimal non-reentrancy guard */
abstract contract ReentrancyGuard {
    uint256 private _guard;
    modifier nonReentrant() {
        require(_guard == 0, "REENTRANT");
        _guard = 1;
        _;
        _guard = 0;
    }
}

/** Minimal Ownable */
abstract contract Ownable {
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    address public owner;
    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }
    modifier onlyOwner() {
        require(msg.sender == owner, "ONLY_OWNER");
        _;
    }
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_ADDR");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
/// ---------- Core contract ----------
contract Muaban is ReentrancyGuard, Ownable {
    // --- Core token & platform fee ---
    IERC20 public immutable vin;                 // VIN token (18 decimals expected)
    uint8   public immutable vinDecimals;
    uint256 public constant PLATFORM_FEE = 1e15; // 0.001 VIN (wei)

    // One-time registration per wallet
    mapping(address => bool) public isRegistered;

    // --- Product model ---
    struct Product {
        uint256 productId;
        address seller;

        // presentation & commercial terms
        string  name;             // short name
        string  descriptionCID;   // IPFS CID for long description
        string  imageCID;         // IPFS CID for main image

        uint256 priceUsdCents;    // e.g., $12.34 => 1234
        uint256 shippingUsdCents; // in USD cents
        uint16  taxRateBps;       // basis points (10_000 = 100%)
        uint32  deliveryDaysMax;  // max delivery window in days

        // revenue routing
        address revenueWallet;
        address taxWallet;
        address shippingWallet;   // optional (can be zero)

        // encryption
        bytes   sellerEncryptPubKey; // opaque bytes (e.g., X25519 or secp256k1)

        bool    active;           // listing status
        uint64  createdAt;
        uint64  updatedAt;
        uint256 stock;            // 0 => out of stock
    }

    // Lifetime seller stats (rolling windows computed off-chain from events)
    struct SellerStats {
        uint256 expiredRefundCount;
        uint256 scamCount;
        uint256 ratingSum;   // sum of ratings (1..5)
        uint256 ratingCount; // number of ratings
    }

    // --- Order model ---
    enum OrderStatus { NONE, PLACED, RELEASED, REFUNDED }

    struct Order {
        uint256 orderId;
        uint256 productId;
        address buyer;
        address seller;
        uint256 quantity;

        // fixed at purchase time
        uint256 vinAmountTotal; // escrowed total (revenue + shipping + tax)
        uint256 placedAt;       // timestamp
        uint256 deadline;       // placedAt + deliveryDaysMax * 1 days

        // buyer-encrypted shipping info (opaque blob)
        bytes shippingInfoCiphertext;

        OrderStatus status;
        bool reviewed;          // true once post-expiry review submitted
    }

    // --- Storage ---
    uint256 private _productSeq;
    uint256 private _orderSeq;

    mapping(uint256 => Product) public products;          // productId => Product
    mapping(uint256 => Order)   public orders;            // orderId   => Order
    mapping(address => uint256[]) public sellerProducts;  // seller => productIds
    mapping(address => SellerStats) public sellerStats;   // seller => stats

    // --- Events ---
    event RegistrationPaid(address indexed wallet, uint256 amount);

    event ProductCreated(
        uint256 indexed productId,
        address indexed seller,
        string  name,
        string  descriptionCID,
        string  imageCID,
        uint256 priceUsdCents,
        uint256 shippingUsdCents,
        uint16  taxRateBps,
        uint32  deliveryDaysMax,
        address revenueWallet,
        address taxWallet,
        address shippingWallet,
        bytes   sellerEncryptPubKey,
        uint256 stock
    );

    event ProductUpdated(
        uint256 indexed productId,
        uint256 priceUsdCents,
        uint256 shippingUsdCents,
        uint16  taxRateBps,
        uint32  deliveryDaysMax,
        address revenueWallet,
        address taxWallet,
        address shippingWallet,
        uint256 stock,
        bytes   sellerEncryptPubKey
    );

    event ProductStatusChanged(uint256 indexed productId, bool active);

    event OrderPlaced(
        uint256 indexed orderId,
        uint256 indexed productId,
        address indexed buyer,
        address seller,
        uint256 quantity,
        uint256 vinAmountTotal,
        uint256 placedAt,
        uint256 deadline,
        bytes   shippingInfoCiphertext
    );

    event OrderReleased(
        uint256 indexed orderId,
        uint256 indexed productId,
        address indexed buyer,
        address seller,
        uint256 vinAmountTotal
    );

    event OrderRefunded(
        uint256 indexed orderId,
        uint256 indexed productId,
        address indexed buyer,
        address seller,
        uint256 vinAmountTotal
    );

    event Reviewed(
        uint256 indexed orderId,
        address indexed seller,
        uint8   rating,     // 1..5
        bool    scamFlag
    );

    // --- Constructor ---
    constructor(address vinToken) {
        require(vinToken != address(0), "VIN_ZERO");
        vin = IERC20(vinToken);
        vinDecimals = vin.decimals();
        require(vinDecimals == 18, "VIN_DECIMALS_18_REQUIRED");
    }
    /// ---------- Registration (one-time 0.001 VIN) ----------
    function payRegistration() external nonReentrant {
        require(!isRegistered[msg.sender], "ALREADY_REGISTERED");
        // Requires prior approve(address(this), PLATFORM_FEE)
        _pullVIN(msg.sender, owner, PLATFORM_FEE);
        isRegistered[msg.sender] = true;
        emit RegistrationPaid(msg.sender, PLATFORM_FEE);
    }

    /// Restrict actions to registered wallets (buyers or sellers)
    modifier onlyRegistered() {
        require(isRegistered[msg.sender], "NOT_REGISTERED");
        _;
    }

    /// ---------- Product management ----------
    function createProduct(
        string calldata name_,
        string calldata descriptionCID_,
        string calldata imageCID_,
        uint256 priceUsdCents_,
        uint256 shippingUsdCents_,
        uint16  taxRateBps_,
        uint32  deliveryDaysMax_,
        address revenueWallet_,
        address taxWallet_,
        address shippingWallet_,
        bytes   calldata sellerEncryptPubKey_,
        uint256 stock_,
        bool    active_
    ) external onlyRegistered nonReentrant returns (uint256 productId) {
        require(bytes(name_).length > 0, "NAME_REQ");
        require(priceUsdCents_ > 0, "PRICE_REQ");
        require(taxRateBps_ <= 10_000, "TAX_BPS_MAX");
        require(deliveryDaysMax_ > 0, "DELIV_DAYS_REQ");
        require(revenueWallet_ != address(0), "REV_WALLET_ZERO");
        require(taxWallet_ != address(0), "TAX_WALLET_ZERO");
        // shippingWallet_ may be zero (optional)

        productId = ++_productSeq;

        products[productId] = Product({
            productId: productId,
            seller: msg.sender,
            name: name_,
            descriptionCID: descriptionCID_,
            imageCID: imageCID_,
            priceUsdCents: priceUsdCents_,
            shippingUsdCents: shippingUsdCents_,
            taxRateBps: taxRateBps_,
            deliveryDaysMax: deliveryDaysMax_,
            revenueWallet: revenueWallet_,
            taxWallet: taxWallet_,
            shippingWallet: shippingWallet_,
            sellerEncryptPubKey: sellerEncryptPubKey_,
            active: active_,
            createdAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp),
            stock: stock_
        });

        sellerProducts[msg.sender].push(productId);

        emit ProductCreated(
            productId,
            msg.sender,
            name_,
            descriptionCID_,
            imageCID_,
            priceUsdCents_,
            shippingUsdCents_,
            taxRateBps_,
            deliveryDaysMax_,
            revenueWallet_,
            taxWallet_,
            shippingWallet_,
            sellerEncryptPubKey_,
            stock_
        );
    }

    function updateProduct(
        uint256 productId,
        uint256 priceUsdCents_,
        uint256 shippingUsdCents_,
        uint16  taxRateBps_,
        uint32  deliveryDaysMax_,
        address revenueWallet_,
        address taxWallet_,
        address shippingWallet_,
        uint256 stock_,
        bytes   calldata sellerEncryptPubKey_
    ) external onlyRegistered nonReentrant {
        Product storage p = products[productId];
        require(p.seller != address(0), "PROD_NOT_FOUND");
        require(p.seller == msg.sender, "NOT_SELLER");
        require(taxRateBps_ <= 10_000, "TAX_BPS_MAX");
        require(deliveryDaysMax_ > 0, "DELIV_DAYS_REQ");
        require(revenueWallet_ != address(0), "REV_WALLET_ZERO");
        require(taxWallet_ != address(0), "TAX_WALLET_ZERO");

        p.priceUsdCents = priceUsdCents_;
        p.shippingUsdCents = shippingUsdCents_;
        p.taxRateBps = taxRateBps_;
        p.deliveryDaysMax = deliveryDaysMax_;
        p.revenueWallet = revenueWallet_;
        p.taxWallet = taxWallet_;
        p.shippingWallet = shippingWallet_;
        p.stock = stock_;
        p.sellerEncryptPubKey = sellerEncryptPubKey_;
        p.updatedAt = uint64(block.timestamp);

        emit ProductUpdated(
            productId,
            priceUsdCents_,
            shippingUsdCents_,
            taxRateBps_,
            deliveryDaysMax_,
            revenueWallet_,
            taxWallet_,
            shippingWallet_,
            stock_,
            sellerEncryptPubKey_
        );
    }

    function setProductActive(uint256 productId, bool active_) external onlyRegistered {
        Product storage p = products[productId];
        require(p.seller != address(0), "PROD_NOT_FOUND");
        require(p.seller == msg.sender, "NOT_SELLER");
        p.active = active_;
        p.updatedAt = uint64(block.timestamp);
        emit ProductStatusChanged(productId, active_);
    }

    /// ---------- Internal helpers ----------
    /// Pull VIN from 'from' into 'to'
    function _pullVIN(address from, address to, uint256 amount) internal {
        require(amount > 0, "AMOUNT_ZERO");
        bool ok = vin.transferFrom(from, to, amount); // requires prior approve
        require(ok, "VIN_TRANSFER_FROM_FAIL");
    }

    /// Convert USD cents to VIN (wei) using vinPerUSD (wei per USD)
    /// Ceil to protect seller: ceil(usdCents * vinPerUSD / 100)
    function _usdCentsToVin(uint256 usdCents, uint256 vinPerUSD) internal pure returns (uint256) {
        if (usdCents == 0) return 0;
        uint256 num = usdCents * vinPerUSD;
        return (num + 99) / 100; // ceil division by 100
    }
    /// ---------- Orders (escrow lifecycle) ----------

    /**
     * @param productId  Product to buy
     * @param quantity   Units to buy (>=1)
     * @param vinPerUSD  VIN wei per 1 USD (from frontend: VIC/USDT * 100)
     * @param shippingInfoCiphertext_  Buyer-encrypted shipping info (opaque bytes)
     */
    function placeOrder(
        uint256 productId,
        uint256 quantity,
        uint256 vinPerUSD,
        bytes calldata shippingInfoCiphertext_
    ) external onlyRegistered nonReentrant returns (uint256 orderId) {
        require(quantity >= 1, "QTY_MIN_1");
        require(vinPerUSD > 0, "VIN_PER_USD_REQ");

        Product storage p = products[productId];
        require(p.seller != address(0), "PROD_NOT_FOUND");
        require(p.active, "PROD_INACTIVE");
        require(p.stock >= quantity, "INSUFFICIENT_STOCK");

        // USD-cents math
        uint256 priceUsdCentsAll = p.priceUsdCents * quantity;
        uint256 shipUsdCents = p.shippingUsdCents;
        // tax on price (not on shipping)
        uint256 taxUsdCents = (priceUsdCentsAll * p.taxRateBps + 9_999) / 10_000;

        // Convert each component to VIN (wei), ceil to protect seller
        uint256 vinRevenue = _usdCentsToVin(priceUsdCentsAll, vinPerUSD);
        uint256 vinShipping = _usdCentsToVin(shipUsdCents, vinPerUSD);
        uint256 vinTax = _usdCentsToVin(taxUsdCents, vinPerUSD);
        uint256 vinTotal = vinRevenue + vinShipping + vinTax;
        require(vinTotal > 0, "VIN_TOTAL_ZERO");

        // Pull VIN from buyer into escrow (this contract)
        _pullVIN(msg.sender, address(this), vinTotal);

        // Stock control
        p.stock -= quantity;

        // Create order
        orderId = ++_orderSeq;
        uint256 placedAt = block.timestamp;
        uint256 deadline = placedAt + uint256(p.deliveryDaysMax) * 1 days;

        orders[orderId] = Order({
            orderId: orderId,
            productId: productId,
            buyer: msg.sender,
            seller: p.seller,
            quantity: quantity,
            vinAmountTotal: vinTotal,
            placedAt: placedAt,
            deadline: deadline,
            shippingInfoCiphertext: shippingInfoCiphertext_,
            status: OrderStatus.PLACED,
            reviewed: false
        });

        emit OrderPlaced(
            orderId,
            productId,
            msg.sender,
            p.seller,
            quantity,
            vinTotal,
            placedAt,
            deadline,
            shippingInfoCiphertext_
        );
    }

    /**
     * Buyer confirms receipt within deadline → release escrow to seller/tax/shipping wallets.
     */
    function confirmReceipt(uint256 orderId) external onlyRegistered nonReentrant {
        Order storage o = orders[orderId];
        require(o.status == OrderStatus.PLACED, "NOT_PLACED");
        require(o.buyer == msg.sender, "NOT_BUYER");
        require(block.timestamp <= o.deadline, "EXPIRED");

        Product storage p = products[o.productId];

        // Reconstruct proportions using USD components captured from Product
        uint256 priceUsdCentsAll = p.priceUsdCents * o.quantity;
        uint256 shipUsdCents = p.shippingUsdCents;
        uint256 taxUsdCents = (priceUsdCentsAll * p.taxRateBps + 9_999) / 10_000;

        uint256 remaining = o.vinAmountTotal;

        // pay tax first
        uint256 vinTax = _ceilShare(remaining, taxUsdCents, priceUsdCentsAll + shipUsdCents + taxUsdCents);
        if (vinTax > remaining) vinTax = remaining;
        remaining -= vinTax;

        // then shipping
        uint256 vinShip = _ceilShare(remaining, shipUsdCents, priceUsdCentsAll + shipUsdCents);
        if (vinShip > remaining) vinShip = remaining;
        remaining -= vinShip;

        // revenue gets the rest
        uint256 vinRev = remaining;

        _sendVIN(p.taxWallet, vinTax);
        address shippingDest = p.shippingWallet == address(0) ? p.revenueWallet : p.shippingWallet;
        _sendVIN(shippingDest, vinShip);
        _sendVIN(p.revenueWallet, vinRev);

        o.status = OrderStatus.RELEASED;

        emit OrderReleased(orderId, o.productId, o.buyer, o.seller, o.vinAmountTotal);
    }

    /**
     * Anyone can trigger refund after deadline if the order is still PLACED.
     * Funds go back to the buyer.
     */
    function refundIfExpired(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.status == OrderStatus.PLACED, "NOT_REFUNDABLE");
        require(block.timestamp > o.deadline, "NOT_EXPIRED");

        uint256 amt = o.vinAmountTotal;
        o.status = OrderStatus.REFUNDED;
        _sendVIN(o.buyer, amt);

        sellerStats[o.seller].expiredRefundCount += 1;

        emit OrderRefunded(orderId, o.productId, o.buyer, o.seller, amt);
    }

    /**
     * Post-expiry review: only allowed if the order was refunded due to expiry.
     * rating: 1..5, scamFlag: true/false
     */
    function reviewAfterRefund(uint256 orderId, uint8 rating, bool scamFlag) external onlyRegistered {
        Order storage o = orders[orderId];
        require(o.status == OrderStatus.REFUNDED, "ORDER_NOT_REFUNDED");
        require(o.buyer == msg.sender, "NOT_BUYER");
        require(!o.reviewed, "ALREADY_REVIEWED");
        require(rating >= 1 && rating <= 5, "RATING_1_TO_5");

        SellerStats storage s = sellerStats[o.seller];
        s.ratingSum += rating;
        s.ratingCount += 1;
        if (scamFlag) s.scamCount += 1;
        o.reviewed = true;

        emit Reviewed(orderId, o.seller, rating, scamFlag);
    }

    /// ---------- Internal payout helpers ----------

    function _sendVIN(address to, uint256 amount) internal {
        if (amount == 0) return;
        require(to != address(0), "DEST_ZERO");
        bool ok = vin.transfer(to, amount);
        require(ok, "VIN_TRANSFER_FAIL");
    }

    /// ceil(remaining * numer / denom), denom>0
    function _ceilShare(uint256 remaining, uint256 numer, uint256 denom) internal pure returns (uint256) {
        if (numer == 0) return 0;
        require(denom > 0, "DENOM_ZERO");
        unchecked {
            uint256 x = remaining * numer;
            return (x + denom - 1) / denom;
        }
    }
    /// ---------- View helpers ----------

    /**
     * Quote VIN amounts for a product and quantity at a given vinPerUSD (wei per USD).
     * Returns (vinRevenue, vinShipping, vinTax, vinTotal).
     */
    function quoteVinForProduct(
        uint256 productId,
        uint256 quantity,
        uint256 vinPerUSD
    ) external view returns (uint256 vinRevenue, uint256 vinShipping, uint256 vinTax, uint256 vinTotal) {
        require(quantity >= 1, "QTY_MIN_1");
        require(vinPerUSD > 0, "VIN_PER_USD_REQ");
        Product storage p = products[productId];
        require(p.seller != address(0), "PROD_NOT_FOUND");

        uint256 priceUsdCentsAll = p.priceUsdCents * quantity;
        uint256 shipUsdCents = p.shippingUsdCents;
        uint256 taxUsdCents = (priceUsdCentsAll * p.taxRateBps + 9_999) / 10_000;

        vinRevenue = _usdCentsToVin(priceUsdCentsAll, vinPerUSD);
        vinShipping = _usdCentsToVin(shipUsdCents, vinPerUSD);
        vinTax = _usdCentsToVin(taxUsdCents, vinPerUSD);
        vinTotal = vinRevenue + vinShipping + vinTax;
    }

    /// Lightweight getters
    function getProduct(uint256 productId) external view returns (Product memory) {
        Product storage p = products[productId];
        require(p.seller != address(0), "PROD_NOT_FOUND");
        return p;
    }

    function getOrder(uint256 orderId) external view returns (Order memory) {
        Order storage o = orders[orderId];
        require(o.buyer != address(0), "ORDER_NOT_FOUND");
        return o;
    }

    function isOrderActive(uint256 orderId) external view returns (bool) {
        Order storage o = orders[orderId];
        if (o.status != OrderStatus.PLACED) return false;
        return block.timestamp <= o.deadline;
    }

    function getSellerStats(address sellerAddr) external view returns (SellerStats memory) {
        return sellerStats[sellerAddr];
    }

    function getSellerProductIds(address sellerAddr) external view returns (uint256[] memory) {
        return sellerProducts[sellerAddr];
    }
}

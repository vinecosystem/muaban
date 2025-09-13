// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MuabanVND
 * @notice On-chain commerce platform where product prices are stored in VND (integer).
 *         Payment is always made in VIN, converted at VIN/VND rate provided at purchase time.
 *         VIN tokens are held in escrow until buyer confirms delivery or deadline expires.
 */

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amt) external returns (bool);
    function transfer(address to, uint256 amt) external returns (bool);
    function transferFrom(address from, address to, uint256 amt) external returns (bool);
    function decimals() external view returns (uint8);
}

contract MuabanVND {
    IERC20 public immutable vin;
    uint8  public immutable vinDecimals;

    constructor(address vinToken) {
        require(vinToken != address(0), "VIN_ADDRESS_ZERO");
        vin = IERC20(vinToken);
        vinDecimals = vin.decimals();
        require(vinDecimals == 18, "VIN_DECIMALS_MUST_BE_18");
    }

    // ---------- Data Models ----------
    struct Product {
        uint256 productId;
        address seller;
        string  name;
        string  descriptionCID;
        string  imageCID;
        uint256 priceVND;        // Product price in VND (integer, tax & shipping included)
        uint32  deliveryDaysMax; // Max delivery days
        address payoutWallet;    // Seller's payout wallet
        uint256 stock;
        bool    active;
        uint64  createdAt;
        uint64  updatedAt;
    }

    enum OrderStatus { NONE, PLACED, RELEASED, REFUNDED }

    struct Order {
        uint256 orderId;
        uint256 productId;
        address buyer;
        address seller;
        uint256 quantity;
        uint256 vinAmount;     // Escrowed VIN amount
        uint256 placedAt;
        uint256 deadline;
        OrderStatus status;
    }

    // ---------- Storage ----------
    uint256 private _productSeq;
    uint256 private _orderSeq;
    mapping(uint256 => Product) public products;
    mapping(uint256 => Order)   public orders;
    mapping(address => uint256[]) public sellerProducts;

    // ---------- Events ----------
    event ProductCreated(uint256 indexed productId, address indexed seller, string name, uint256 priceVND);
    event ProductUpdated(uint256 indexed productId, uint256 priceVND, uint32 deliveryDaysMax, bool active, uint256 stock);
    event OrderPlaced(uint256 indexed orderId, uint256 indexed productId, address indexed buyer, uint256 quantity, uint256 vinAmount);
    event OrderReleased(uint256 indexed orderId, uint256 vinAmount);
    event OrderRefunded(uint256 indexed orderId, uint256 vinAmount);

    // ---------- Internal helper ----------
    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }

    // ---------- Product Management ----------
    function createProduct(
        string calldata name,
        string calldata descriptionCID,
        string calldata imageCID,
        uint256 priceVND,
        uint32  deliveryDaysMax,
        address payoutWallet,
        uint256 stock,
        bool    active
    ) external returns (uint256 pid) {
        require(priceVND > 0, "PRICE_REQUIRED");
        require(deliveryDaysMax > 0, "DELIVERY_REQUIRED");
        require(payoutWallet != address(0), "PAYOUT_WALLET_ZERO");

        pid = ++_productSeq;
        products[pid] = Product({
            productId: pid,
            seller: msg.sender,
            name: name,
            descriptionCID: descriptionCID,
            imageCID: imageCID,
            priceVND: priceVND,
            deliveryDaysMax: deliveryDaysMax,
            payoutWallet: payoutWallet,
            stock: stock,
            active: active,
            createdAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp)
        });
        sellerProducts[msg.sender].push(pid);

        emit ProductCreated(pid, msg.sender, name, priceVND);
    }

    function updateProduct(
        uint256 pid,
        uint256 priceVND,
        uint32  deliveryDaysMax,
        address payoutWallet,
        uint256 stock,
        bool    active
    ) external {
        Product storage p = products[pid];
        require(p.seller == msg.sender, "NOT_SELLER");
        require(priceVND > 0, "PRICE_REQUIRED");
        require(deliveryDaysMax > 0, "DELIVERY_REQUIRED");
        require(payoutWallet != address(0), "PAYOUT_WALLET_ZERO");

        p.priceVND = priceVND;
        p.deliveryDaysMax = deliveryDaysMax;
        p.payoutWallet = payoutWallet;
        p.stock = stock;
        p.active = active;
        p.updatedAt = uint64(block.timestamp);

        emit ProductUpdated(pid, priceVND, deliveryDaysMax, active, stock);
    }

    // ---------- Orders ----------
    function placeOrder(
        uint256 productId,
        uint256 quantity,
        uint256 vinPerVND  // VIN wei per 1 VND, provided by frontend
    ) external returns (uint256 oid) {
        Product storage p = products[productId];
        require(p.seller != address(0), "PRODUCT_NOT_FOUND");
        require(p.active && p.stock >= quantity, "OUT_OF_STOCK");
        require(quantity > 0, "QUANTITY_REQUIRED");
        require(vinPerVND > 0, "VIN_PER_VND_REQUIRED");

        // Calculate required VIN
        uint256 totalVND = p.priceVND * quantity;
        uint256 vinAmount = _ceilDiv(totalVND * vinPerVND, 1); // ceil to protect seller

        // Escrow VIN
        bool ok = vin.transferFrom(msg.sender, address(this), vinAmount);
        require(ok, "VIN_TRANSFER_FAIL");

        oid = ++_orderSeq;
        orders[oid] = Order({
            orderId: oid,
            productId: productId,
            buyer: msg.sender,
            seller: p.seller,
            quantity: quantity,
            vinAmount: vinAmount,
            placedAt: block.timestamp,
            deadline: block.timestamp + uint256(p.deliveryDaysMax) * 1 days,
            status: OrderStatus.PLACED
        });

        // Reduce stock
        p.stock -= quantity;

        emit OrderPlaced(oid, productId, msg.sender, quantity, vinAmount);
    }

    function confirmReceipt(uint256 orderId) external {
        Order storage o = orders[orderId];
        require(o.status == OrderStatus.PLACED, "NOT_PLACED");
        require(o.buyer == msg.sender, "NOT_BUYER");

        o.status = OrderStatus.RELEASED;
        bool ok = vin.transfer(products[o.productId].payoutWallet, o.vinAmount);
        require(ok, "VIN_TRANSFER_FAIL");
        emit OrderReleased(orderId, o.vinAmount);
    }

    function refundIfExpired(uint256 orderId) external {
        Order storage o = orders[orderId];
        require(o.status == OrderStatus.PLACED, "NOT_PLACED");
        require(block.timestamp > o.deadline, "NOT_EXPIRED");
        require(o.buyer == msg.sender, "NOT_BUYER");

        o.status = OrderStatus.REFUNDED;
        bool ok = vin.transfer(o.buyer, o.vinAmount);
        require(ok, "VIN_TRANSFER_FAIL");
        emit OrderRefunded(orderId, o.vinAmount);
    }

    // ---------- View helpers ----------
    function getProduct(uint256 pid) external view returns (Product memory) {
        return products[pid];
    }

    function getOrder(uint256 oid) external view returns (Order memory) {
        return orders[oid];
    }
}

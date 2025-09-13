// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MuabanVND
 * @notice On-chain commerce platform where product prices are stored in VND (integer).
 *         Payment is always made in VIN, converted at VIN/VND rate provided at purchase time.
 *         VIN tokens are held in escrow until buyer confirms delivery or deadline expires.
 *         Users must register once (pay 0.001 VIN) before listing or buying.
 *         The contract owner only receives the registration fee and has no further power.
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
    address public immutable owner;

    uint256 public constant REG_FEE = 1e15; // 0.001 VIN (18 decimals)

    constructor(address vinToken) {
        require(vinToken != address(0), "VIN_ADDRESS_ZERO");
        vin = IERC20(vinToken);
        vinDecimals = vin.decimals();
        require(vinDecimals == 18, "VIN_DECIMALS_MUST_BE_18");
        owner = msg.sender;
    }

    // ---------- Registration ----------
    mapping(address => bool) public registered;

    event Registered(address indexed user);

    modifier onlyRegistered() {
        require(registered[msg.sender], "NOT_REGISTERED");
        _;
    }

    function payRegistration() external {
        require(!registered[msg.sender], "ALREADY_REGISTERED");
        bool ok = vin.transferFrom(msg.sender, owner, REG_FEE);
        require(ok, "VIN_TRANSFER_FAIL");
        registered[msg.sender] = true;
        emit Registered(msg.sender);
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
        uint256 vinAmount;       // Escrowed VIN amount
        uint256 placedAt;
        uint256 deadline;
        OrderStatus status;
        string  buyerInfoCipher; // Encrypted info (only seller can decrypt off-chain)
    }

    // ---------- Storage ----------
    uint256 private _productSeq;
    uint256 private _orderSeq;
    mapping(uint256 => Product) public products;
    mapping(uint256 => Order)   public orders;
    mapping(address => uint256[]) public sellerProducts;

    // ---------- Events ----------
    event ProductCreated(uint256 indexed productId, address indexed seller, string name, uint256 priceVND);
    event ProductUpdated(uint256 indexed productId, uint256 priceVND, uint32 deliveryDaysMax, bool active);
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
        bool    active
    ) external onlyRegistered returns (uint256 pid) {
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
        bool    active
    ) external onlyRegistered {
        Product storage p = products[pid];
        require(p.seller == msg.sender, "NOT_SELLER");
        require(priceVND > 0, "PRICE_REQUIRED");
        require(deliveryDaysMax > 0, "DELIVERY_REQUIRED");
        require(payoutWallet != address(0), "PAYOUT_WALLET_ZERO");

        p.priceVND = priceVND;
        p.deliveryDaysMax = deliveryDaysMax;
        p.payoutWallet = payoutWallet;
        p.active = active;
        p.updatedAt = uint64(block.timestamp);

        emit ProductUpdated(pid, priceVND, deliveryDaysMax, active);
    }

    function setProductActive(uint256 pid, bool active) external onlyRegistered {
        Product storage p = products[pid];
        require(p.seller == msg.sender, "NOT_SELLER");
        p.active = active;
        p.updatedAt = uint64(block.timestamp);
    }

    function getSellerProductIds(address seller) external view returns (uint256[] memory) {
        return sellerProducts[seller];
    }

    // ---------- Orders ----------
    function placeOrder(
        uint256 productId,
        uint256 quantity,
        uint256 vinPerVND,       // VIN wei per 1 VND, provided by frontend
        string calldata buyerInfoCipher
    ) external onlyRegistered returns (uint256 oid) {
        Product storage p = products[productId];
        require(p.seller != address(0), "PRODUCT_NOT_FOUND");
        require(p.active, "PRODUCT_NOT_ACTIVE");
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
            status: OrderStatus.PLACED,
            buyerInfoCipher: buyerInfoCipher
        });

        emit OrderPlaced(oid, productId, msg.sender, quantity, vinAmount);
    }

    function confirmReceipt(uint256 orderId) external onlyRegistered {
        Order storage o = orders[orderId];
        require(o.status == OrderStatus.PLACED, "NOT_PLACED");
        require(o.buyer == msg.sender, "NOT_BUYER");

        o.status = OrderStatus.RELEASED;
        bool ok = vin.transfer(products[o.productId].payoutWallet, o.vinAmount);
        require(ok, "VIN_TRANSFER_FAIL");
        emit OrderReleased(orderId, o.vinAmount);
    }

    function refundIfExpired(uint256 orderId) external onlyRegistered {
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

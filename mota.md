Muaban — Đặc tả Sản phẩm & Kỹ thuật (MVP)

Ngày: 07/09/2025 (GMT+7)
Chuỗi: Viction Mainnet (chainId = 88)
Token thanh toán: VIN (ERC-20, 18 decimals) — địa chỉ: 0x941F63807401efCE8afe3C9d88d368bAA287Fac4
Triết lý: On-chain tối giản, minh bạch, escrow an toàn, không key admin; dữ liệu nặng/PII để IPFS/Pinata.
Giao diện DApp:

VI: https://vinecosystem.github.io/muaban (làm trước)

EN: https://vinecosystem.github.io/commerce (làm sau)
Ngôn ngữ hợp đồng: Toàn bộ tiếng Anh (để verify công khai). Tài liệu này chỉ để mô tả/điều phối.

1) Mục tiêu & Phạm vi

Niêm yết giá USD; thanh toán bằng VIN.

Escrow on-chain: Buyer nạp VIN vào hợp đồng khi đặt hàng; Buyer xác nhận nhận hàng ⇒ hợp đồng giải ngân cho Seller (tách thuế). Nếu quá hạn Buyer không xác nhận ⇒ tự động hoàn VIN cho Buyer.

Mỗi ví (mua/bán) phải đăng ký 1 lần: phí 0.001 VIN.

Thuế theo sản phẩm (BPS); khi giải ngân sẽ chuyển thuế về ví thuế, doanh thu về ví doanh thu của Seller.

Thông tin định danh/ảnh/mô tả không on-chain; on-chain chỉ lưu URI + hash (IPFS) để kiểm chứng toàn vẹn.

Ngoài phạm vi MVP (để phiên bản sau): tranh chấp (dispute), phí nền tảng theo đơn, mã giảm giá, shipping fee động, oracle tỷ giá có chữ ký, v.v.

2) Kiến trúc “No-Admin Keys”

REGISTRATION_FEE = 0.001 VIN (hằng số).

CONFIRM_WINDOW = 3 days (hằng số).

FEE_RECIPIENT = ví nhận phí đăng ký (thường là ví deploy) — immutable khi triển khai.

register() chuyển phí trực tiếp tới FEE_RECIPIENT.

Không có owner, không pause, không đổi cấu hình, không rescue.

Hợp đồng chỉ giữ VIN ký quỹ (escrow), theo dõi bằng totalEscrowedVin.

3) Vai trò

Buyer (Người mua): xem sản phẩm, đặt hàng (ký quỹ VIN), có thể hủy trước khi Seller đánh dấu “đã gửi”, xác nhận nhận hàng để giải ngân, hoặc được hoàn tự động khi quá hạn.

Seller (Người bán): đăng ký, cập nhật hồ sơ IPFS, tạo/cập nhật sản phẩm (giá USD, thuế BPS, tồn kho, ví doanh thu & ví thuế, URI+hash), giao hàng & bấm “đã gửi”.

DApp: tính số VIN off-chain theo thị trường, hiển thị & gọi hàm on-chain.

(Không có Owner): không ai có quyền can thiệp vào escrow.

4) Dữ liệu On-chain
4.1. Đăng ký

registered[address] → bool.

4.2. Hồ sơ người bán (neo off-chain)

SellerProfile { profileURI (ipfs://…), profileHash (bytes32) }.

4.3. Sản phẩm (Listing)
Listing {
  seller        (address)  // chủ listing (đã đăng ký)
  payoutWallet  (address)  // ví nhận doanh thu
  taxWallet     (address)  // ví thuế
  taxBps        (uint16)   // thuế theo BPS (10_000 = 100%)
  priceUsd6     (uint256)  // USD-6 (1 USD = 1_000_000)
  inventory     (uint256)  // tồn kho
  active        (bool)     // đang bán?
  productURI    (string)   // ipfs://… mô tả + hình ảnh
  productHash   (bytes32)  // hash nội dung
}

4.4. Đơn hàng (Order, escrow)
Order {
  listingId       (uint256)
  buyer           (address)
  seller          (address)   // snapshot tại thời điểm đặt
  payoutWallet    (address)   // snapshot
  taxWallet       (address)   // snapshot
  taxBps          (uint16)    // snapshot
  qty             (uint256)
  vinAmount       (uint256)   // VIN ký quỹ (tính off-chain)
  createdAt       (uint256)
  confirmDeadline (uint256)   // = createdAt + CONFIRM_WINDOW

  // Chỉ để minh bạch/log (không dùng để tính):
  priceUsd6Unit   (uint256)
  vinPerUnit      (uint256)
  contactURI      (string)    // ipfs://… thông tin liên hệ buyer (private)
  contactHash     (bytes32)

  status          (enum)      // None / Escrowed / Released / Refunded / Cancelled
  sellerMarked    (bool)      // Seller đã “đã gửi”
}

4.5. Kế toán

totalEscrowedVin (uint256) — tổng VIN đang giữ hộ trong escrow.

5) API Hợp đồng (tên hàm tiếng Anh)
5.1. Đăng ký & Hồ sơ

register() — thu 0.001 VIN và chuyển thẳng FEE_RECIPIENT; set registered[msg.sender]=true.

updateSellerProfile(string profileURI, bytes32 profileHash).

5.2. Sản phẩm

createListing(address payoutWallet, address taxWallet, uint16 taxBps, uint256 priceUsd6, uint256 inventory, bool active, string productURI, bytes32 productHash) returns (uint256 id)

updateListing(uint256 id, address payoutWallet, address taxWallet, uint16 taxBps, uint256 priceUsd6, uint256 inventory, bool active, string productURI, bytes32 productHash)

setListingActive(uint256 id, bool active)

setInventory(uint256 id, uint256 newInventory) (cho phép = 0)

5.3. Đơn hàng & Escrow

placeOrder(uint256 listingId, uint256 qty, uint256 vinAmount, uint256 priceUsd6Unit, uint256 vinPerUnit, string contactURI, bytes32 contactHash) returns (uint256 orderId)

sellerMarkShipped(uint256 orderId)

buyerRelease(uint256 orderId) — chia tiền: tax = vinAmount * taxBps / 10_000 → taxWallet, phần còn lại → payoutWallet

claimTimeoutRefund(uint256 orderId) — sau confirmDeadline nếu vẫn Escrowed → hoàn 100% VIN cho Buyer (permissionless)

buyerCancelBeforeShipped(uint256 orderId) — Buyer hủy nếu Escrowed và sellerMarked == false (phục hồi tồn kho, hoàn VIN)

5.4. View

contractBalances() → (vinBalance, escrowedVin, withdrawableFeesVin=0)

getListing(uint256 id) → Listing

getOrder(uint256 orderId) → Order

Không có: owner, pause, đổi cấu hình, withdraw fees, rescue ERC20.

6) Luồng Nghiệp vụ
6.1. Đăng ký ví

Kết nối ví → approve(VIN, contract, 0.001 VIN) → register()

Từ giờ ví có thể mua hoặc bán.

6.2. Seller tạo/cập nhật sản phẩm

Cập nhật hồ sơ: updateSellerProfile(profileURI, profileHash)

Tạo: khai priceUsd6, inventory, taxBps, payoutWallet, taxWallet, productURI+productHash, active

Chỉnh nhanh: setListingActive, setInventory

6.3. Buyer đặt hàng (escrow)

DApp tính VIN cần ký quỹ off-chain:
vinAmount = ceil( (priceUsd × qty) / (VIN/USD thị trường) )

Buyer: approve(VIN, contract, vinAmount) → placeOrder(...)

Hợp đồng: giảm tồn kho, giữ VIN vào escrow, đặt confirmDeadline = now + CONFIRM_WINDOW, phát OrderPlaced.

6.4. Giao hàng & xác nhận

Seller giao hàng (off-chain), bấm sellerMarkShipped(orderId)

Buyer nhận & kiểm tra → nếu OK: buyerRelease(orderId) → hợp đồng tách thuế & giải ngân.

6.5. Quá hạn không xác nhận

Sau confirmDeadline còn Escrowed → ai cũng có thể gọi claimTimeoutRefund(orderId) → hoàn 100% VIN cho Buyer.

6.6. Hủy trước khi Seller “đã gửi”

buyerCancelBeforeShipped(orderId) → hoàn VIN + phục hồi tồn kho, trạng thái Cancelled.

7) Đặc tả DApp (UI/UX)
7.1. Nguyên tắc

Song ngữ VI/EN, chuyển đổi tức thì; bản VI triển khai trước.

Thời gian: hiển thị 24h, dd/mm/yyyy, GMT+7; on-chain dùng block.timestamp.

Tiền tệ:

USD: hiển thị định dạng locale;

VIN: rút gọn 18 decimals (ví dụ 123.456789 VIN).

Không lộ PII: hồ sơ/ảnh/chi tiết… lấy từ profileURI/productURI trên IPFS; contactURI của Buyer là link riêng/tùy chọn mã hóa.

7.2. Điều hướng & Màn hình

Trang chủ: Thanh tìm kiếm + bộ lọc (sticky), danh sách sản phẩm (List view mặc định 1 cột; Grid view tùy chọn).

Trang sản phẩm: ảnh (carousel), mô tả, giá USD, ước tính VIN realtime, form số lượng, nút Đặt mua (thực thi approve + placeOrder), hiển thị chính sách/ghi chú từ metadata.

Khu Buyer – Đơn hàng của tôi: bảng orders, trạng thái, đếm ngược deadline, nút Xác nhận nhận hàng, Hủy (nếu chưa shipped), Hoàn do quá hạn.

Khu Seller – Bán hàng: form hồ sơ, quản lý sản phẩm (Create/Update/Active/Inventory), danh sách orders của mình, nút Đã gửi.

7.3. Trạng thái & Màu sắc

Escrowed (vàng), Shipped (xanh dương nhạt — khi sellerMarked), Released (xanh lá), Refunded (xám), Cancelled (đỏ nhạt).

Tooltip giải thích ngắn từng trạng thái.

8) Tìm kiếm kiểu “Google” (cực kỳ quan trọng)
8.1. Thanh tìm kiếm (search bar)

Full-text theo: tiêu đề, tóm tắt, mô tả, tags, seller alias (từ product metadata JSON trên IPFS).

Gợi ý (typeahead) theo lịch sử/từ khóa phổ biến.

Toán tử cơ bản:

"cụm từ": tìm chính xác cụm,

-từ : loại trừ,

từ1 từ2: mặc định AND.

8.2. Bộ lọc (filters)

Phạm vi giá USD (min/max).

Thuế suất (BPS range).

Còn hàng (inventory > 0).

Danh mục / tags (từ metadata).

Người bán (địa chỉ ví hoặc bí danh off-chain).

Sắp xếp: mới nhất, giá tăng/giảm, tồn kho nhiều.

8.3. Kiến trúc tìm kiếm

Client-side index (ví dụ: MiniSearch/Lunr) đủ đến ~10k sản phẩm.

Quy mô lớn: khuyến khích cộng đồng chạy Indexer/API mở:

Lắng nghe ListingCreated/Updated →

Fetch productURI (JSON/IPFS) →

Cập nhật chỉ mục & phục vụ API public.

DApp ưu tiên API nếu có; fallback về index client-side khi không có API.

9) Lược đồ Metadata (IPFS)
9.1. product.json (gợi ý)
{
  "title": "Classic Leather Wallet",
  "summary": "Genuine leather, 8 card slots.",
  "description": "Full details...",
  "images": ["ipfs://bafy.../1.jpg", "ipfs://bafy.../2.jpg"],
  "category": "Accessories",
  "tags": ["leather", "wallet", "handmade"],
  "sku": "WAL-CL-001",
  "priceUSD": 49.99,
  "decimals": 2,
  "sellerAlias": "Store ABC",
  "shippingPolicy": "Ships in 2–3 days.",
  "returnPolicy": "7-day returns.",
  "extra": {}
}


On-chain chuẩn là priceUsd6. priceUSD/decimals chỉ để UI hiển thị.

9.2. seller-profile.json
{
  "displayName": "Store ABC",
  "about": "Handmade leather goods.",
  "contacts": {
    "website": "https://abc.example",
    "email": "hello@abc.example"
  },
  "proofs": ["business license link (optional)"]
}

9.3. contact.json (Buyer)
{
  "name": "Nguyen Van A",
  "phone": "+84-xxx-xxx",
  "address": "xx/yy/zz, ...",
  "notes": "Please call before delivery."
}


Khuyến nghị: dùng link riêng khó đoán hoặc mã hóa trước khi upload IPFS.

10) Tính toán VIN & An toàn giao dịch

DApp tự tính vinAmount off-chain (gợi ý: dùng VIC/USDT × 100 ≈ VIN/USD).

Hiển thị “ước tính VIN” + ghi chú có thể trượt do thị trường.

Seller nên xem vinAmount trong order trước khi giao; nếu bất thường, có thể không giao (đơn sẽ hoàn khi quá hạn).

Invariants kỹ thuật:

totalEscrowedVin tăng khi placeOrder (sau transferFrom) và giảm khi buyerRelease / claimTimeoutRefund / buyerCancelBeforeShipped.

Không có đường rút VIN nào khác ngoài ba luồng trên.

Dùng nonReentrant + trình tự checks-effects-interactions.

11) Kiểm thử Tối thiểu (E2E)

Đăng ký: A (Seller), B (Buyer) — phí chuyển thẳng FEE_RECIPIENT.

Tạo sản phẩm: tồn kho 10, taxBps=1000 (10%).

Đặt mua: B mua qty=2, vinAmount hợp lệ → Escrowed, tồn kho còn 8.

Giao & Giải ngân: Seller sellerMarkShipped; Buyer buyerRelease → thuế → taxWallet, doanh thu → payoutWallet.

Timeout refund: Buyer khác đặt nhưng không xác nhận → sau hạn, ai cũng gọi được claimTimeoutRefund → VIN về Buyer.

Hủy trước ship: Buyer đặt xong bấm hủy (chưa sellerMarked) → VIN về Buyer, tồn kho phục hồi.

12) Triển khai & Verify

Triển khai (constructor):

vinToken = 0x941F63807401efCE8afe3C9d88d368bAA287Fac4

feeRecipient = <ví nhận phí> (thường là ví deploy)

Verify hợp đồng trên VicScan (Solidity ^0.8.24, OpenZeppelin).

Lưu ABI + địa chỉ vào repo /abi.

DApp (ethers.js):

Kiểm tra registered, approve + register

approve + placeOrder, buyerRelease, sellerMarkShipped, claimTimeoutRefund, buyerCancelBeforeShipped

Đồng hồ đếm đến confirmDeadline (hiển thị GMT+7).

13) Quy ước UI/UX & Kỹ thuật Frontend

List view mặc định (1 cột) để đọc mô tả dài; Grid view (2–3 cột) tùy chọn.

Responsive: ưu tiên mobile trước; tối thiểu iPhone SE trở lên.

Trạng thái có màu & tooltip; ẩn các nút không hợp lệ theo trạng thái.

Toast/Snackbar cho mỗi hành động (approve/đặt/hủy/giải ngân/hoàn).

Bộ nhớ tạm: cache metadata IPFS, retry nếu lỗi; loading skeleton.

Phân trang: infinite scroll hoặc server-side paging (nếu dùng API).

Bảo mật: cảnh báo người dùng trước khi đẩy thông tin liên hệ lên IPFS; khuyến nghị mã hóa nếu nhạy cảm.

A11y: keyboard-friendly, aria-labels cho nút hành động quan trọng.

14) Cấu trúc Repo (gợi ý)
/contracts
  Muaban.sol
/abi
  Muaban.json
/app
  /muaban      # VI
  /commerce    # EN
  /shared      # logic dùng chung, hooks, i18n
/docs
  mota.md
  README_VI.md
  README_EN.md

15) Lộ trình nâng cấp (ngoài MVP)

Dispute với trọng tài (đa chữ ký), partial shipment.

Platform fee theo đơn (bật/tắt).

Oracle VIN/USD có chữ ký (nếu muốn cố định rate on-chain khi đặt).

Voucher/mã giảm giá, flash sale, bundle.

Đánh giá Seller & điểm uy tín (off-chain, chống spam).

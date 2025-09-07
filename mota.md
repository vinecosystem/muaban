# Mô tả chi tiết nền tảng muaban (Spec)

## 1. Giới thiệu chung

**muaban** là một nền tảng thương mại điện tử thuần on-chain trên mạng **Viction (VIC)**, không tên miền, không máy chủ.  
Mọi giao dịch mua bán đều do **hợp đồng thông minh** điều khiển, không có trung gian, không ai có quyền can thiệp.  

- **Đơn vị thanh toán:** Token **VIN** (ERC-20 trên mạng VIC). Địa chỉ token VIN trên mạng VIC: 0x941F63807401efCE8afe3C9d88d368bAA287Fac4
- **Giá niêm yết:** Tính bằng **USD** để người mua dễ hiểu; khi đặt mua, hệ thống sẽ quy đổi sang VIN theo tỷ giá **VIC/USDT trên Binance × 100**.  
- **Cơ chế escrow:** Khi mua, VIN được khóa trong hợp đồng; chỉ khi người mua bấm “Đã nhận hàng” trong hạn thì VIN mới được giải ngân cho người bán.  
- **Nguyên tắc Pre-Confirm:** Người bán chỉ giao hàng sau khi buyer bấm “Đã nhận hàng” và tx on-chain thành công.  
- **Hoàn tiền:** Nếu hết hạn giao hàng mà buyer chưa bấm, họ có quyền bấm “Hoàn tiền” → VIN trả lại cho buyer.  

Nền tảng đảm bảo:  
- Minh bạch, công bằng, không cần tin tưởng trung gian.  
- Người bán có thể đăng, cập nhật sản phẩm trực tiếp bằng ví.  
- Người mua có thể chọn, thanh toán, xác nhận nhận hàng trực tiếp bằng ví.  
- Thông tin giao hàng của buyer được mã hoá, chỉ người bán đọc được, không công khai.  

## 2. Cơ chế phí duy nhất (0.001 VIN)

- Mỗi ví khi lần đầu muốn **mua hàng** hoặc **đăng sản phẩm** đều phải trả phí đăng ký nền tảng: **0.001 VIN**.  
- Phí này chỉ thu **một lần duy nhất cho mỗi ví**. Sau khi đã đăng ký, ví đó có thể:  
  - Đặt hàng, xác nhận, hoàn tiền.  
  - Đăng nhiều sản phẩm, cập nhật giá và số lượng.  

- Sau khi đã đăng ký, tất cả hành động tiếp theo **chỉ tốn phí gas VIC** cho mạng blockchain, nền tảng **không thu thêm bất kỳ phí nào**.  
- Không thu phần trăm từ doanh thu bán hàng.  
- Không động chạm đến ví nhận tiền của người bán.  

**Tóm lại:**  
- Một ví → chỉ trả 0.001 VIN duy nhất.  
- Sau đó dùng thoải mái để mua hoặc bán, chỉ còn phải trả gas mạng VIC.  

## 3. Quy trình mua hàng (JIT, Escrow, Pre-Confirm)

1. **Đăng sản phẩm**
   - Người bán niêm yết sản phẩm bằng USD (giá bán, phí giao hàng, thuế suất, thời hạn giao hàng).
   - Hình ảnh, mô tả chi tiết lưu trên IPFS, hợp đồng chỉ giữ link (CID).
   - Người bán khai báo sẵn ví nhận doanh thu (revenueWallet), ví thu hộ thuế (taxWallet), và nếu cần, ví phí giao hàng (shippingWallet).

2. **Đặt hàng (Buyer bấm Mua)**
   - Frontend lấy giá VIC/USDT hiện tại từ Binance API.
   - Quy đổi số VIN = (giá USD + phí ship USD + thuế USD) × (100 / VIC/USDT).
   - Buyer ký `approve` và `placeOrder`, VIN chuyển vào escrow của hợp đồng.
   - Thông tin giao hàng (Tên, SĐT, Địa chỉ, Ghi chú) được mã hoá cục bộ và đính kèm trong sự kiện `OrderPlaced`.

3. **Giao hàng (Pre-Confirm)**
   - Người bán chuẩn bị hàng và giao đến buyer.
   - Tại điểm giao, buyer bấm **“Đã nhận hàng”** trên DApp.
   - Hợp đồng lập tức giải ngân VIN trong escrow:
     - Doanh thu → revenueWallet
     - Thuế → taxWallet
     - Phí giao hàng → shippingWallet (nếu có)
   - Seller kiểm tra tx thành công trên explorer rồi mới trao hàng.

4. **Nguyên tắc bảo đảm**
   - Seller không thể rút VIN nếu buyer chưa bấm.
   - Buyer không thể huỷ đơn giữa chừng; chỉ có 2 khả năng: **Xác nhận** hoặc **Hết hạn → Hoàn tiền**.

## 4. Hoàn tiền khi quá hạn

- Khi người bán đăng sản phẩm, họ khai rõ **thời hạn giao hàng tối đa** (ví dụ 7 ngày).
- Hệ thống ghi lại `deadline = thời điểm đặt hàng + thời hạn giao`.

### Hành vi nút cho buyer
- **Trong hạn (`now ≤ deadline`):**
  - Nút **“Đã nhận hàng”** → BẬT
  - Nút **“Hoàn tiền”** → TẮT
- **Hết hạn (`now > deadline`):**
  - Nút **“Đã nhận hàng”** → TẮT
  - Nút **“Hoàn tiền”** → BẬT

### Hành vi trên hợp đồng
- Nếu buyer bấm **“Đã nhận hàng”** trong hạn → VIN giải ngân cho seller.
- Nếu hết hạn mà buyer chưa bấm:
  - Buyer có quyền gọi hàm `refundIfExpired(orderId)`.
  - VIN trong escrow trả lại ví buyer.
- Seller không cần và không có quyền hủy đơn.

### Tính chất
- **Không bot, không server**: chỉ khi buyer (hoặc bất kỳ ai muốn giúp) bấm thì giao dịch mới chạy.
- Buyer an tâm: không bấm xác nhận thì không mất VIN.
- Seller an tâm: không có xác nhận thì không phải giao hàng.

## 5. Thông tin giao hàng & bảo mật

### Nguyên tắc
- Người mua cần nhập thông tin cơ bản để seller giao hàng:  
  - Tên người nhận  
  - Số điện thoại  
  - Địa chỉ giao hàng  
  - Ghi chú (tùy chọn)  

- Các thông tin này **không được lưu rõ ràng trên blockchain** để tránh lộ công khai.  

### Cách bảo mật
- Khi buyer bấm **Mua**, trình duyệt sẽ:
  1. Lấy **public key mã hoá** mà seller đã khai khi đăng sản phẩm.  
  2. **Mã hoá cục bộ** thông tin giao hàng ngay trên máy buyer.  
  3. Đưa **bản mã** (ciphertext) vào sự kiện `OrderPlaced`.  

- Kết quả:  
  - On-chain chỉ có bản mã, không ai đọc được.  
  - Chỉ seller (có private key) mới giải mã được thông tin.  

### Trải nghiệm người dùng
- Buyer: chỉ cần điền 3–4 ô, không phải làm thêm thao tác.  
- Seller: trong bảng điều khiển, mỗi đơn hàng có nút **“Xem thông tin giao hàng”** → trình duyệt giải mã bằng private key và hiển thị ngay.  

### Ưu điểm
- Không server, không bot, không Pinata bắt buộc cho thông tin cá nhân.  
- Đảm bảo riêng tư: chỉ seller thật sự mới thấy được thông tin cần thiết để giao hàng.  

## 6. Quyền cập nhật sản phẩm

### Các quyền của người bán
Một ví đã đăng ký (trả 0.001 VIN) có thể:
- Đăng sản phẩm mới.
- Cập nhật giá bán (USD).
- Cập nhật số lượng còn hàng (stock).
- Ẩn hoặc hiển thị lại sản phẩm khi muốn dừng/bán tiếp.

### Cơ chế an toàn
- Mỗi sản phẩm có `productId` duy nhất, gắn với ví người bán đã tạo.
- Chỉ ví đã tạo sản phẩm đó mới có quyền cập nhật.
- Mọi cập nhật phát sự kiện `ProductUpdated` để người mua thấy thay đổi tức thì.

### Quy tắc công bằng
- Đơn hàng đã đặt vẫn giữ nguyên giá và số lượng tại thời điểm buyer bấm Mua.
- Việc cập nhật chỉ ảnh hưởng tới các đơn hàng phát sinh sau đó.

### Giao diện người bán
- Bảng "Sản phẩm của tôi": hiển thị danh sách sản phẩm (ảnh, mô tả, giá USD, tồn kho).
- Có nút "Sửa giá", "Cập nhật số lượng", "Ẩn/Hiện".
- Thay đổi xong hiển thị ngay, buyer sẽ luôn thấy giá/tồn kho mới.

## 7. Đánh giá & cảnh báo người bán

### Nguyên tắc công bằng
- Chỉ **buyer** của đơn hàng bị **hoàn vì quá hạn** (REFUNDED_EXPIRED) mới có quyền đánh giá.
- Buyer không được đánh giá nếu đơn đã hoàn tất thành công.

### Cơ chế đánh giá
- Mỗi đơn chỉ được đánh giá **một lần duy nhất**.
- Buyer có thể:
  - Chấm điểm (1–5 sao).
  - Gắn cờ "Lừa đảo, đừng mua".
  - Thêm bình luận (lưu trên IPFS, on-chain chỉ giữ hash).

### Dữ liệu lưu trên hợp đồng
- `expired_refund_count` – số đơn hoàn do quá hạn.
- `scam_count` – số lần bị gắn cờ lừa đảo.
- `rating_sum` và `rating_count` – để tính điểm trung bình.

### Hiển thị trên giao diện
- Với mỗi seller, hiển thị:
  - Tỷ lệ đơn bị hoàn vì quá hạn (rolling 90 ngày).
  - Điểm trung bình đánh giá (nếu có).
  - Số lần bị gắn cờ lừa đảo.
  - Danh sách bình luận (IPFS + link đến tx để kiểm chứng).
- Nếu seller có `scam_count ≥ 1` trong 90 ngày gần nhất → hiển thị banner đỏ cảnh báo.

### Tính chất
- Đảm bảo minh bạch: đánh giá gắn liền với ID đơn hàng và địa chỉ ví buyer.
- Tránh spam: chỉ buyer đã thực sự đặt hàng và bị hoàn mới được quyền đánh giá.

## 8. Bảng điều khiển người bán

### Chức năng chính
- **Đơn mới (Order Queue):**
  - Hiển thị danh sách đơn mới đặt, đếm ngược đến deadline.
  - Chuông thông báo + toast khi có đơn mới (lọc theo ví seller).
  - Có thể bật thông báo trình duyệt (Web Notifications) để báo ngay cả khi tab ở nền.

- **Chi tiết đơn (Order Detail):**
  - Hiển thị đầy đủ thông tin: mã đơn, sản phẩm, số lượng, giá VIN đã thanh toán, trạng thái.
  - Nút "Xem thông tin giao hàng" → giải mã bằng private key để hiện Tên/SĐT/Địa chỉ.
  - QR/link xác nhận để shipper đưa cho buyer bấm tại điểm giao.

- **Theo dõi xác nhận theo thời gian thực:**
  - Listener block mới → khi có sự kiện `OrderConfirmed`:
    - Hiện banner xanh “ĐÃ NHẬN VIN – Có thể giao hàng”.
    - Nút mở VicScan với tx-hash.

- **Đơn sắp hết hạn:**
  - Danh sách riêng các đơn còn ≤24h đến deadline.
  - Có nút “Gửi lại link xác nhận” để nhắc buyer.

### Giao diện sản phẩm
- Danh sách "Sản phẩm của tôi":
  - Ảnh, mô tả, giá, số lượng còn lại.
  - Nút Sửa giá, Cập nhật tồn kho, Ẩn/Hiện.
- Mọi thao tác cập nhật chỉ tốn gas VIC, không phí khác.

### Thống kê cửa hàng
- Tỷ lệ hoàn do quá hạn (90 ngày).
- Điểm trung bình đánh giá sau-refund.
- Số lần bị gắn cờ lừa đảo.
- Danh sách bình luận IPFS kèm link tx để minh bạch.

### Vai trò nhân viên (operator)
- Chủ cửa hàng (owner) có thể thêm ví nhân viên để họ đăng/cập nhật sản phẩm.
- Dù nhân viên đăng, VIN doanh thu và thuế vẫn luôn chảy về ví mà owner đã khai báo.
- Nhân viên chỉ chịu phí gas cho thao tác đăng/cập nhật.

## 9. UI/UX cho buyer & seller

### Buyer (người mua)
- **Đặt hàng:**
  - Chọn sản phẩm → điền 4 ô thông tin giao hàng (Tên, SĐT, Địa chỉ, Ghi chú).
  - Bấm **Mua** → dApp tự quy đổi VIN theo giá VIC/USDT → ký giao dịch.
- **Trong hạn giao hàng:**
  - Nút **“Đã nhận hàng”** hiển thị rõ ràng, màu xanh.
  - Nút **“Hoàn tiền”** bị ẩn (disable).
- **Hết hạn giao hàng:**
  - Nút **“Đã nhận hàng”** bị ẩn.
  - Nút **“Hoàn tiền”** hiển thị rõ, màu đỏ.
- **Trải nghiệm an toàn:**
  - Buyer không cần tin server, chỉ cần kiểm tra tx trên VicScan.
  - Không xác nhận thì không mất VIN.

### Seller (người bán)
- **Đăng sản phẩm:**
  - Form gồm: Tên hàng, Mô tả, Ảnh (IPFS), Giá USD, Phí ship USD, Thuế %, Thời hạn giao hàng, Ví nhận VIN, Khóa public mã hoá.
  - Chỉ ví đã đăng ký mới bấm được "Đăng sản phẩm".
- **Quản lý đơn hàng:**
  - Bảng điều khiển có tab: Đơn mới, Đơn sắp hết hạn, Đơn hoàn tất, Đơn hết hạn.
  - Có QR/link xác nhận để buyer bấm tại điểm giao.
- **Giao hàng (Pre-Confirm):**
  - Shipper yêu cầu buyer bấm "Đã nhận hàng".
  - Khi tx thành công → seller thấy VIN đã về ví → mới trao hàng.

### Nguyên tắc UX chung
- Giao diện rõ ràng, ít nút, dễ dùng.
- Nút bật/tắt theo trạng thái (tránh buyer bấm nhầm).
- Luôn có link mở VicScan để tra cứu minh bạch.

## 10. Tìm kiếm & hiển thị sản phẩm

### Mục tiêu
- Khi số lượng sản phẩm nhiều, người mua cần tìm nhanh và dễ.
- Thông tin hiển thị phải thống nhất để so sánh giá giữa nhiều người bán.

### Chuẩn dữ liệu sản phẩm
- `productId` – mã duy nhất trên hợp đồng.
- `seller` – ví đã đăng sản phẩm.
- `name` – tên sản phẩm (ngắn gọn, rõ nghĩa).
- `description` – mô tả chi tiết, lưu IPFS, hợp đồng chỉ giữ link.
- `imageCID` – CID ảnh sản phẩm trên IPFS.
- `priceUSD` – giá bán niêm yết bằng USD.
- `shippingUSD` – phí giao hàng (USD).
- `taxRate` – thuế suất (%).
- `deliveryDays` – số ngày giao hàng tối đa.
- `status` – đang bán / ẩn.

### Tìm kiếm
- Người mua có thể tìm theo:
  - Tên sản phẩm (keyword search).
  - Người bán (địa chỉ ví).
  - Khoảng giá (USD).
  - Trạng thái (còn hàng / hết hàng).
- Frontend sẽ tải dữ liệu on-chain (qua event logs) và lập chỉ mục tạm trong bộ nhớ/IndexedDB để lọc nhanh.

### Hiển thị
- Danh sách sản phẩm dạng lưới hoặc danh sách cuộn.
- Mỗi sản phẩm hiển thị:
  - Ảnh (IPFS).
  - Tên sản phẩm.
  - Giá bán (USD) + giá quy đổi VIN (theo VIC/USDT hiện tại).
  - Tên/địa chỉ seller (ví).
  - Thời hạn giao hàng tối đa.
- Khi click vào sản phẩm → mở chi tiết: ảnh lớn, mô tả IPFS, giá, phí ship, thuế, thời hạn, nút Mua.

### Nguyên tắc minh bạch
- Toàn bộ dữ liệu hiển thị đều từ blockchain hoặc IPFS → không ai có thể sửa/giấu.
- Các sản phẩm ẩn (status=hidden) vẫn tồn tại on-chain nhưng frontend không hiển thị.

## 11. Tóm tắt nguyên tắc công bằng

1. **Phí nền tảng**
   - Mỗi ví trả 0.001 VIN duy nhất một lần để được quyền mua hoặc bán.
   - Sau đó, chỉ trả phí gas VIC cho mạng, không có phí nền tảng nào khác.

2. **Niêm yết giá**
   - Giá sản phẩm tính bằng USD.
   - Lúc buyer bấm Mua → quy đổi sang VIN theo giá VIC/USDT hiện tại ×100.
   - Đơn hàng đã đặt giữ nguyên giá tại thời điểm mua.

3. **Escrow & Pre-Confirm**
   - Buyer bấm Mua → VIN chuyển vào escrow.
   - Seller chỉ giao hàng khi buyer bấm “Đã nhận hàng” → VIN tự động chuyển cho seller (chia revenue/tax/ship).

4. **Hoàn tiền**
   - Nếu hết hạn giao hàng mà buyer chưa xác nhận:
     - Nút “Hoàn tiền” bật lên.
     - Buyer bấm → VIN trả lại ví buyer.

5. **Thông tin giao hàng**
   - Buyer nhập Tên/SĐT/Địa chỉ/Ghi chú.
   - DApp mã hoá cục bộ, on-chain chỉ lưu bản mã.
   - Chỉ seller giải mã được → đảm bảo riêng tư.

6. **Quản lý sản phẩm**
   - Seller có thể đăng, sửa giá, sửa tồn kho, ẩn/hiện sản phẩm.
   - Cập nhật chỉ ảnh hưởng đơn đặt sau đó, không ảnh hưởng đơn đã mua.

7. **Đánh giá người bán**
   - Chỉ buyer của đơn bị hoàn vì quá hạn mới được đánh giá.
   - Có thể chấm điểm, gắn cờ lừa đảo, thêm bình luận IPFS.
   - Dữ liệu minh bạch: số đơn thành công, số đơn quá hạn, số lần bị gắn cờ.

8. **Bảng điều khiển seller**
   - Hiển thị đơn mới, đơn sắp hết hạn, đơn đã hoàn tất, đơn hết hạn.
   - Có QR/link để yêu cầu buyer bấm xác nhận tại điểm giao.
   - Thống kê uy tín: tỷ lệ hoàn, điểm đánh giá, số lần bị gắn cờ.

9. **Tìm kiếm & hiển thị sản phẩm**
   - Chuẩn dữ liệu thống nhất (ID, tên, mô tả IPFS, giá USD, phí ship, thuế, thời hạn).
   - Frontend hỗ trợ tìm kiếm theo tên, ví seller, giá, trạng thái.
   - Giao diện minh bạch, dễ so sánh nhiều người bán.

---

## Kết luận
Nền tảng **muaban** được thiết kế thuần on-chain, không trung gian, không máy chủ.  
Người mua và người bán giao dịch trực tiếp qua hợp đồng thông minh VIN/VIC.  
Mọi quy trình rõ ràng, công bằng, minh bạch, dễ sử dụng, đảm bảo riêng tư và có khả năng mở rộng khi số lượng sản phẩm và đơn hàng tăng cao.

# 📄 Bản mô tả DApp **muaban.vin**

## 0) Thông tin nền tảng
- **Phi tập trung – Hợp đồng là trọng tài**  
- Người bán đưa sản phẩm lên để bán (giá theo VND).  
- Người mua thanh toán bằng VIN vào hợp đồng.  
- Người bán phải giao hàng đúng hạn để được giải ngân.  
- Nếu quá hạn, buyer bấm **Hoàn tiền** để lấy lại VIN.  

**Địa chỉ hợp đồng Muaban (VIC):** `0xcC8bb4278FD8321830450460dE9E2FB743d08368`  
**Địa chỉ token VIN (VIC):** `0x941F63807401efCE8afe3C9d88d368bAA287Fac4`  
**Logo & favicon:** `logo.png`  
**Phí đăng ký ví:** 0.001 VIN  

---

## 1) Giá & thanh toán
- Giá sản phẩm: người bán nhập bằng **VND** (bao gồm thuế & phí).  
- Công thức quy đổi VIN/VND:  
```

VIN/VND = (VIC/USDT từ Binance × 100) × (USDT/VND từ CoinGecko)

```
- Làm tròn xuống số nguyên.  
- Hiển thị ví dụ: `1 VIN = 631.214 VND`.  

---

## 2) Mockup giao diện

### A) Chưa kết nối ví
```

---

## | LOGO + slogan                        \[ Kết nối ví ] |

## | 1 VIN = 631.214 VND                               |

## | \[ ô tìm kiếm ............ ] \[ Tìm ]               |

\|  \[Ảnh SP]  Tên sản phẩm                           |
\|           350.000 VND / cái                       |
\|           Trạng thái: Còn hàng/Hết hàng           |
\|                                                   |
\|  \[Ảnh SP]  Tên sản phẩm                           |
\|           120.000 VND / hộp                       |
\|           Trạng thái: Hết hàng                    |
------------------------------------------------------

## | Hợp đồng | VIN Token | Swap VIN/VIC | Hướng dẫn   |

```

### B) Đã kết nối ví
```

---

## | LOGO + slogan     VIN: 100.5   VIC: 50.2  \[0x123..]|

## | Menu: \[Đăng sản phẩm] \[Đơn hàng mua] \[Đơn hàng bán]|

## | 1 VIN = 631.214 VND                               |

## | \[ ô tìm kiếm ............ ] \[ Tìm ]               |

\|  \[Ảnh SP]  Tên sản phẩm                           |
\|           350.000 VND / cái                       |
\|           Trạng thái: Còn hàng                    |
\|   -> Nếu là buyer: \[Mua]                          |
\|   -> Nếu là seller: \[Cập nhật sản phẩm]           |
-------------------------------------------------------

## | Hợp đồng | VIN Token | Swap VIN/VIC | Hướng dẫn   |

```

---

## 3) Logic hiển thị
- **Chưa kết nối ví**: xem được sản phẩm nhưng không có nút Mua.  
- **Kết nối ví nhưng chưa đăng ký**: chỉ hiện nút **Đăng ký**.  
- **Kết nối ví và đã đăng ký**:  
  - Nếu ví là **seller**: hiển thị nút **Cập nhật sản phẩm**.  
  - Nếu ví là **buyer**: hiển thị nút **Mua** khi sản phẩm còn hàng.  

---

## 4) Đăng sản phẩm
Form gồm:  
- Tên sản phẩm (≤ 500 ký tự)  
- Link IPFS ảnh/video  
- Đơn vị tính (cái/chiếc/…)  
- Giá bán VNĐ  
- Ví nhận thanh toán  
- Thời gian giao hàng tối đa (ngày)  
- Nút Đăng  

👉 Không nhập số lượng. Sản phẩm mới đăng mặc định là **“Còn hàng”**.  

---

## 5) Mua sản phẩm
- Buyer bấm **Mua** → Form:  
  - Họ tên  
  - Địa chỉ  
  - SĐT  
  - Phụ ghi (UI tự mã hóa)  
  - Số lượng  
- UI tính tổng VIN cần trả, hiển thị rõ.  
- Buyer ký giao dịch `placeOrder(...)`.  

---

## 6) Đơn hàng của tôi
- **Buyer**: Xem đơn hàng đã đặt, có nút **Xác nhận đã nhận hàng** và **Hoàn tiền**.  
- **Seller**: Xem đơn hàng mới của sản phẩm mình, biết hạn giao hàng.  

---

## 7) Cập nhật sản phẩm
- Seller có thể cập nhật giá, thời gian giao hàng, ví nhận thanh toán, bật/tắt bán, hoặc đánh dấu hết hàng (stock = 0 hoặc active = false).  
- Nút **Cập nhật sản phẩm** chỉ hiện với seller.  

---

## 8) Bảo mật thông tin giao hàng
- Thông tin cá nhân buyer (tên, địa chỉ, SĐT, phụ ghi) **không lưu plaintext** on-chain.  
- UI tự động **mã hóa ngầm định** thành ciphertext trước khi gửi vào hợp đồng.  
- Seller giải mã client-side khi xem đơn hàng.  

---

## 9) Chức năng hợp đồng cần dùng
- `payRegistration()` – đăng ký ví.  
- `createProduct(...)` – đăng sản phẩm.  
- `updateProduct(...)` – cập nhật sản phẩm.  
- `setProductActive(...)` – bật/tắt bán.  
- `placeOrder(...)` – mua sản phẩm.  
- `confirmReceipt(...)` – xác nhận nhận hàng.  
- `refundIfExpired(...)` – hoàn tiền khi quá hạn.  
- `getProduct`, `getOrder`, `getSellerProductIds` – hiển thị dữ liệu.  

---

## 10) Kết luận
- Hợp đồng hiện tại đã đáp ứng đầy đủ yêu cầu, không cần viết lại.  
- Giao diện DApp sẽ: **đơn giản – dễ dùng – chuyên nghiệp – đẹp – bố trí khoa học**.  
- Người mới có thể tham khảo mục **Hướng dẫn** ở footer.
```

---


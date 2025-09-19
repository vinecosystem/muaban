/* ========== muaban.vin — app.js (full) ========== */
/* Phụ thuộc: ethers@5.x UMD + HTML hiện tại (đã có sẵn các id trong index.html) */

/* -------------------- CẤU HÌNH -------------------- */
const CONFIG = {
  CHAIN_ID_DEC: 88,                    // Viction Mainnet
  CHAIN_ID_HEX: "0x58",
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://vicscan.xyz",

  // Địa chỉ lấy từ file index.html & mô tả (mota.md)
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",

  // Endpoints tính tỷ giá: VIN/VND = (VIC/USDT từ Binance × 100) × (USDT/VND từ CoinGecko)
  BINANCE_VICUSDT: "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",
  COINGECKO_USDTVND: "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",

  // Giới hạn quét (khi chưa có API liệt kê hết từ contract)
  SCAN_MAX_PRODUCTS: 200,   // quét pid từ 1..N để tìm kiếm
  SCAN_MAX_ORDERS: 400,     // quét orderId từ 1..N để lọc đơn mua/bán của tôi
};

/* -------------------- TIỆN ÍCH DOM -------------------- */
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(msg, type="info", ms=3500) {
  console.log(`[${type}]`, msg);
  // Có thể gắn snackbar đẹp ở đây. Tạm thời dùng alert nhẹ cho lỗi nghiêm trọng.
  if (type === "error") {
    // popup ngắn gọn
    alert(msg);
  }
}

function shortAddr(addr) {
  if (!addr) return "";
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function setShow(el, show) {
  if (!el) return;
  el.style.display = show ? "" : "none";
}

function formatVND(num) {
  // nhập số nguyên VND → hiển thị "1.234.567 VND"
  try {
    return Number(num).toLocaleString("vi-VN");
  } catch {
    return String(num);
  }
}

function formatVinHuman(bn, decimals = 18, fraction = 4) {
  try {
    const s = ethers.utils.formatUnits(bn || 0, decimals);
    // đưa về 4 số thập phân max (theo yêu cầu trước đó)
    return (Math.floor(parseFloat(s) * 10**fraction) / 10**fraction).toFixed(fraction);
  } catch { return "0.0000"; }
}

/* -------------------- BIẾN TOÀN CỤC -------------------- */
let providerRead;      // provider read-only (RPC)
let web3Provider;      // window.ethereum provider
let signer;            // signer sau khi kết nối
let account;           // địa chỉ ví
let muaban, vin;       // contracts (ethers.Contract)
let VIN_DECIMALS = 18; // đọc từ token khi đã kết nối
let vinPerVND = null;  // BigNumber: VIN wei cho 1 VND (dùng placeOrder)
let vinPriceVND = null;// số nguyên làm tròn xuống để hiển thị "1 VIN = X VND"
let isRegistered = false;

/* -------------------- KHỞI TẠO -------------------- */
(async function init() {
  try {
    // Provider read-only để lấy dữ liệu khi chưa kết nối ví
    providerRead = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);

    // Gắn sự kiện UI
    bindUI();

    // Hiển thị giá VIN theo VND (chế độ khách/đã kết nối đều dùng)
    await refreshVinPrice();

    // Nếu đã có ví sẵn (MetaMask inject), khôi phục trạng thái rút gọn
    if (window.ethereum) {
      window.ethereum.on('accountsChanged', handleAccountsChanged);
      window.ethereum.on('chainChanged', () => window.location.reload());
    }
  } catch (err) {
    console.error("init error:", err);
    toast("Không thể khởi tạo ứng dụng.", "error");
  }
})();

/* -------------------- GẮN SỰ KIỆN UI -------------------- */
function bindUI() {
  $("#btnConnect")?.addEventListener("click", connectWallet);
  $("#btnDisconnect")?.addEventListener("click", disconnectUI);

  $("#btnRegister")?.addEventListener("click", onRegister);

  // Điều hướng menu
  $("#btnCreate")?.addEventListener("click", () => showSection("create"));
  $("#btnOrdersBuy")?.addEventListener("click", () => showSection("ordersBuy"));
  $("#btnOrdersSell")?.addEventListener("click", () => showSection("ordersSell"));

  // Tìm sản phẩm
  $("#btnSearch")?.addEventListener("click", onSearchProducts);

  // Submit form
  $("#btnSubmitCreate")?.addEventListener("click", onSubmitCreate);
  $("#btnSubmitUpdate")?.addEventListener("click", onSubmitUpdate);
  $("#btnSubmitBuy")?.addEventListener("click", onSubmitBuy);

  // Khi thay đổi số lượng mua → cập nhật tổng VIN cần trả
  $("#buyQty")?.addEventListener("input", updateBuyTotalVIN);
}

/* -------------------- KẾT NỐI VÍ -------------------- */
async function ensureVictionNetwork() {
  if (!window.ethereum) throw new Error("Không tìm thấy MetaMask.");
  const chainId = await window.ethereum.request({ method: 'eth_chainId' });
  if (chainId !== CONFIG.CHAIN_ID_HEX) {
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: CONFIG.CHAIN_ID_HEX }],
      });
    } catch (switchErr) {
      // Nếu chain chưa add vào MetaMask
      if (switchErr.code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: CONFIG.CHAIN_ID_HEX,
            chainName: 'Viction Mainnet',
            rpcUrls: [CONFIG.RPC_URL],
            nativeCurrency: { name: 'VIC', symbol: 'VIC', decimals: 18 },
            blockExplorerUrls: [CONFIG.EXPLORER],
          }],
        });
      } else {
        throw switchErr;
      }
    }
  }
}

async function connectWallet() {
  try {
    if (!window.ethereum) {
      toast("Vui lòng cài MetaMask để kết nối.", "error");
      return;
    }
    // Ép về đúng mạng VIC
    await ensureVictionNetwork();

    // Yêu cầu kết nối tài khoản (nếu ví đang khóa sẽ yêu cầu bạn mở khóa/đăng nhập)
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!accounts || !accounts[0]) throw new Error("Không chọn được tài khoản.");
    account = ethers.utils.getAddress(accounts[0]);

    web3Provider = new ethers.providers.Web3Provider(window.ethereum, "any");
    signer = web3Provider.getSigner();

    // Khởi tạo contracts (dùng ABI JSON local trong repo)
    const [muabanAbi, vinAbi] = await Promise.all([
      fetch("./Muaban_ABI.json").then(r => r.json()),
      fetch("./VinToken_ABI.json").then(r => r.json()),
    ]);

    muaban = new ethers.Contract(CONFIG.MUABAN_ADDR, muabanAbi, signer);
    vin    = new ethers.Contract(CONFIG.VIN_ADDR,    vinAbi,    signer);

    // Lấy decimals token VIN
    try {
      VIN_DECIMALS = await vin.decimals();
    } catch { VIN_DECIMALS = 18; }

    // Cập nhật UI ví
    await refreshWalletBox();

    // Kiểm tra đã đăng ký?
    isRegistered = await muaban.registered(account);
    updateMenuByRegisterState();

    // Tải danh sách sản phẩm mặc định (quét nhẹ)
    await listProductsDefault();

    // Xem đơn của tôi
    await refreshMyOrders();

  } catch (err) {
    console.error("connectWallet error:", err);
    if (String(err?.message || "").includes("Internal JSON-RPC error")) {
      toast("Lỗi RPC nội bộ. Vui lòng kiểm tra mạng VIC, gas, và thử lại.", "error");
    } else {
      toast(err?.message || "Kết nối ví thất bại.", "error");
    }
  }
}

function disconnectUI() {
  // Không thể “ngắt” ví từ DApp, chỉ reset UI
  account = null; signer = null; web3Provider = null;
  $("#accountShort").textContent = "";
  $("#vinBalance").textContent = "VIN: 0";
  $("#vicBalance").textContent = "VIC: 0";
  setShow($("#walletBox"), false);
  setShow($("#menuBox"), false);
  // Ẩn form
  showSection(null);
  // Giữ giá VIN theo VND vẫn hiển thị
}

async function handleAccountsChanged(accs) {
  if (!accs || !accs[0]) { disconnectUI(); return; }
  account = ethers.utils.getAddress(accs[0]);
  signer  = web3Provider?.getSigner();
  // refresh
  await refreshWalletBox();
  isRegistered = await muaban.registered(account);
  updateMenuByRegisterState();
  await refreshMyOrders();
}

/* -------------------- VÍ & SỐ DƯ -------------------- */
async function refreshWalletBox() {
  try {
    if (!signer) return;
    const addr = await signer.getAddress();

    // Số dư VIC (native)
    const vicBal = await web3Provider.getBalance(addr);
    $("#vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;

    // Số dư VIN (ERC20)
    const vinBal = await vin.balanceOf(addr);
    $("#vinBalance").textContent = `VIN: ${formatVinHuman(vinBal, VIN_DECIMALS, 4)}`;

    $("#accountShort").textContent = shortAddr(addr);
    $("#accountShort").href = `${CONFIG.EXPLORER}/address/${addr}`;
    setShow($("#walletBox"), true);
    setShow($("#menuBox"), true);

  } catch (err) {
    console.error("refreshWalletBox error:", err);
  }
}

function updateMenuByRegisterState() {
  // Nếu chưa đăng ký → chỉ hiển thị nút "Đăng ký"
  setShow($("#btnRegister"), !isRegistered);
  setShow($("#btnCreate"),   isRegistered);
  setShow($("#btnOrdersBuy"), true);
  setShow($("#btnOrdersSell"), isRegistered);
}

/* -------------------- GIÁ VIN THEO VND -------------------- */
async function refreshVinPrice() {
  try {
    $("#vinPrice").textContent = "Loading price...";

    // Lấy VIC/USDT từ Binance
    const vicJson = await fetch(CONFIG.BINANCE_VICUSDT).then(r => r.json());
    const vicUsdt = parseFloat(vicJson?.price || "0");
    if (!(vicUsdt > 0)) throw new Error("Không lấy được VIC/USDT từ Binance.");

    // Lấy USDT/VND từ CoinGecko
    const cgJson = await fetch(CONFIG.COINGECKO_USDTVND).then(r => r.json());
    const usdtVnd = parseFloat(cgJson?.tether?.vnd || "0");
    if (!(usdtVnd > 0)) throw new Error("Không lấy được USDT/VND từ CoinGecko.");

    // VIN/VND = (vicUsdt × 100) × usdtVnd
    const vinVndFloat = vicUsdt * 100 * usdtVnd;

    // Hiển thị: làm tròn xuống số nguyên
    vinPriceVND = Math.floor(vinVndFloat);

    // Tính vinPerVND (VIN wei cho 1 VND) dùng cho on-chain (ceil bảo vệ người bán)
    // vinPerVND = ceil(1e18 / (VIN/VND))
    const denom = ethers.BigNumber.from("1000000000000000000"); // 1e18
    const divisor = ethers.BigNumber.from(String(vinPriceVND > 0 ? vinPriceVND : 1));
    // ceil(a/b) = (a + b - 1) / b
    vinPerVND = denom.add(divisor).sub(1).div(divisor);

    $("#vinPrice").textContent = `1 VIN = ${formatVND(vinPriceVND)} VND`;

  } catch (err) {
    console.error("refreshVinPrice error:", err);
    $("#vinPrice").textContent = "1 VIN = — VND";
  }
}

/* -------------------- ĐĂNG KÝ -------------------- */
async function onRegister() {
  try {
    if (!signer || !vin || !muaban) { toast("Vui lòng kết nối ví trước.", "error"); return; }

    // Lấy phí đăng ký từ hợp đồng
    const fee = await muaban.REG_FEE(); // tính theo VIN (18 decimals)
    // Kiểm tra allowance → approve nếu thiếu
    await ensureAllowance(vin, CONFIG.MUABAN_ADDR, fee);

    const tx = await muaban.payRegistration();
    toast("Đang gửi giao dịch đăng ký...");
    await tx.wait();

    isRegistered = await muaban.registered(account);
    updateMenuByRegisterState();
    toast("Đăng ký thành công!");
  } catch (err) {
    console.error("onRegister error:", err);
    handleTxError(err, "Đăng ký thất bại.");
  }
}

async function ensureAllowance(token, spender, required) {
  const cur = await token.allowance(account, spender);
  if (cur.gte(required)) return;
  const tx = await token.approve(spender, required);
  toast("Đang gửi giao dịch approve...");
  await tx.wait();
}

/* -------------------- SẢN PHẨM -------------------- */
function showSection(which) {
  // Ẩn tất
  setShow($("#formCreate"), false);
  setShow($("#formUpdate"), false);
  setShow($("#formBuy"), false);
  setShow($("#ordersBuySection"), false);
  setShow($("#ordersSellSection"), false);

  if (which === "create") setShow($("#formCreate"), true);
  if (which === "update") setShow($("#formUpdate"), true);
  if (which === "buy")    setShow($("#formBuy"),    true);
  if (which === "ordersBuy")  setShow($("#ordersBuySection"),  true);
  if (which === "ordersSell") setShow($("#ordersSellSection"), true);
}

async function onSubmitCreate() {
  try {
    if (!signer || !muaban) { toast("Vui lòng kết nối ví.", "error"); return; }
    if (!isRegistered) { toast("Bạn chưa đăng ký. Vui lòng đăng ký trước khi đăng sản phẩm.", "error"); return; }

    const name   = ($("#createName").value || "").trim();
    const ipfs   = ($("#createIPFS").value || "").trim();     // hình/video IPFS
    const unit   = ($("#createUnit").value || "").trim();     // ví dụ: cái, hộp, kg...
    const priceVND = Math.max(1, Number($("#createPrice").value || 0)); // số nguyên VND
    const wallet = ($("#createWallet").value || "").trim();   // ví nhận tiền
    const days   = Math.max(1, Number($("#createDays").value || 0));

    if (!name || !ipfs || !unit || !priceVND || !wallet || !days) {
      toast("Vui lòng nhập đủ thông tin.", "error"); return;
    }

    // Gắn unit vào descriptionCID theo mô tả
    const descriptionCID = `unit:${unit}`;
    const imageCID = ipfs;
    const active = true;

    // Gọi createProduct(name, descriptionCID, imageCID, priceVND, deliveryDaysMax, payoutWallet, active)
    const tx = await muaban.createProduct(
      name,
      descriptionCID,
      imageCID,
      ethers.BigNumber.from(String(priceVND)),
      days,
      wallet,
      active
    );
    toast("Đang gửi giao dịch tạo sản phẩm...");
    const rc = await tx.wait();
    toast("Đăng sản phẩm thành công!");

    // Làm mới danh sách
    await listProductsDefault();
  } catch (err) {
    console.error("onSubmitCreate error:", err);
    handleTxError(err, "Đăng sản phẩm thất bại.");
  }
}

async function onSubmitUpdate() {
  try {
    if (!signer || !muaban) { toast("Vui lòng kết nối ví.", "error"); return; }

    const pid    = Number($("#updatePid").value || 0);
    const priceVND = Math.max(0, Number($("#updatePrice").value || 0)); // 0 = giữ nguyên?
    const days   = Math.max(0, Number($("#updateDays").value || 0));
    const wallet = ($("#updateWallet").value || "").trim();
    const active = !!$("#updateActive").checked;

    if (!pid) { toast("Vui lòng nhập Product ID.", "error"); return; }

    const tx = await muaban.updateProduct(
      ethers.BigNumber.from(String(pid)),
      ethers.BigNumber.from(String(priceVND)),
      days,
      wallet || ethers.constants.AddressZero,
      active
    );
    toast("Đang gửi giao dịch cập nhật sản phẩm...");
    await tx.wait();
    toast("Cập nhật sản phẩm thành công!");

    await listProductsDefault();
  } catch (err) {
    console.error("onSubmitUpdate error:", err);
    handleTxError(err, "Cập nhật sản phẩm thất bại.");
  }
}

/* -------------------- MUA HÀNG -------------------- */
function updateBuyTotalVIN() {
  try {
    const qty = Math.max(1, Number($("#buyQty").value || 1));
    const priceVND = Number($("#buyProductInfo")?.dataset?.priceVND || 0);
    if (!vinPerVND || !priceVND) {
      $("#buyTotalVIN").textContent = "Tổng VIN cần trả: 0";
      return;
    }
    // total = priceVND * qty * vinPerVND
    const total = ethers.BigNumber.from(String(priceVND))
      .mul(ethers.BigNumber.from(String(qty)))
      .mul(vinPerVND);
    $("#buyTotalVIN").textContent = `Tổng VIN cần trả: ${formatVinHuman(total, VIN_DECIMALS, 4)}`;
    $("#buyTotalVIN").dataset.totalWei = total.toString();
  } catch {
    $("#buyTotalVIN").textContent = "Tổng VIN cần trả: 0";
    $("#buyTotalVIN").dataset.totalWei = "0";
  }
}

async function onSubmitBuy() {
  try {
    if (!signer || !muaban || !vin) { toast("Vui lòng kết nối ví.", "error"); return; }
    const infoDiv = $("#buyProductInfo");
    const pid = Number(infoDiv?.dataset?.pid || 0);
    const priceVND = Number(infoDiv?.dataset?.priceVND || 0);
    const seller = infoDiv?.dataset?.seller || "";
    if (!pid || !priceVND || !seller) { toast("Thiếu dữ liệu sản phẩm.", "error"); return; }

    const name  = ($("#buyName").value || "").trim();
    const addr  = ($("#buyAddress").value || "").trim();
    const phone = ($("#buyPhone").value || "").trim();
    const note  = ($("#buyNote").value || "").trim();
    const qty   = Math.max(1, Number($("#buyQty").value || 1));

    if (!name || !addr || !phone) {
      toast("Vui lòng nhập đầy đủ tên, địa chỉ và số điện thoại.", "error"); return;
    }
    if (!vinPerVND) {
      toast("Chưa lấy được tỷ giá VIN/VND. Hãy tải lại trang.", "error"); return;
    }

    // buyerInfoCipher: tạm thời serialize JSON (nếu muốn mã hoá sau này có thể thay)
    const buyerInfoCipher = JSON.stringify({ name, addr, phone, note });

    // Tính tổng VIN cần approve = priceVND * qty * vinPerVND
    const totalWei = ethers.BigNumber.from(String(priceVND))
      .mul(ethers.BigNumber.from(String(qty)))
      .mul(vinPerVND);

    await ensureAllowance(vin, CONFIG.MUABAN_ADDR, totalWei);

    // placeOrder(productId, quantity, vinPerVND, buyerInfoCipher)
    const tx = await muaban.placeOrder(
      ethers.BigNumber.from(String(pid)),
      ethers.BigNumber.from(String(qty)),
      vinPerVND,
      buyerInfoCipher
    );
    toast("Đang gửi giao dịch đặt mua...");
    await tx.wait();

    toast("Đặt mua thành công! Hãy theo dõi mục 'Đơn hàng mua'.");
    showSection("ordersBuy");
    await refreshMyOrders();

  } catch (err) {
    console.error("onSubmitBuy error:", err);
    handleTxError(err, "Đặt mua thất bại.");
  }
}

/* -------------------- DANH SÁCH SẢN PHẨM -------------------- */
async function listProductsDefault() {
  try {
    $("#productList").innerHTML = "";
    // Thử quét 1..SCAN_MAX_PRODUCTS và lọc những sản phẩm active để hiển thị
    // (Vì contract không có hàm trả về toàn bộ, nên tạm chọn giải pháp quét.)
    const cards = [];
    for (let pid = 1; pid <= CONFIG.SCAN_MAX_PRODUCTS; pid++) {
      try {
        const p = await muaban.getProduct(pid);
        if (!p || !p.productId || p.productId.toString() !== String(pid)) continue;
        if (!p.active) continue;

        cards.push(renderProductCard(p));
        if (cards.length >= 24) break; // tránh quá nhiều
      } catch {}
    }
    if (!cards.length) {
      $("#productList").innerHTML = `<div class="muted">Chưa có sản phẩm nào (hoặc ngoài phạm vi quét).</div>`;
    } else {
      $("#productList").append(...cards);
    }
  } catch (err) {
    console.error("listProductsDefault error:", err);
  }
}

async function onSearchProducts() {
  try {
    const q = ($("#searchInput").value || "").trim().toLowerCase();
    $("#productList").innerHTML = "";
    const found = [];
    for (let pid = 1; pid <= CONFIG.SCAN_MAX_PRODUCTS; pid++) {
      try {
        const p = await muaban.getProduct(pid);
        if (!p || !p.active) continue;
        const name = (p.name || "").toLowerCase();
        if (q && !name.includes(q)) continue;
        found.push(renderProductCard(p));
        if (found.length >= 32) break;
      } catch {}
    }
    if (!found.length) {
      $("#productList").innerHTML = `<div class="muted">Không tìm thấy sản phẩm phù hợp.</div>`;
    } else {
      $("#productList").append(...found);
    }
  } catch (err) {
    console.error("onSearchProducts error:", err);
  }
}

function renderProductCard(p) {
  // p: struct Product
  const div = document.createElement("div");
  div.className = "product-card";

  // Lấy unit từ descriptionCID = "unit:<...>"
  let unit = "";
  if (p.descriptionCID && typeof p.descriptionCID === "string" && p.descriptionCID.startsWith("unit:")) {
    unit = p.descriptionCID.slice(5);
  }

  const priceVND = Number(p.priceVND?.toString() || "0");
  const priceStr = formatVND(priceVND);
  const seller = p.seller;

  div.innerHTML = `
    <div class="product-media">
      <img src="https://ipfs.io/ipfs/${p.imageCID}" alt="${p.name}"/>
    </div>
    <div class="product-body">
      <div class="product-title">${p.name || "No name"}</div>
      <div class="product-sub">Giá: ${priceStr} VND / ${unit || "đơn vị"}</div>
      <div class="product-sub">Người bán: <a target="_blank" href="${CONFIG.EXPLORER}/address/${seller}">${shortAddr(seller)}</a></div>
      <div class="product-actions">
        <button class="btn btn-buy" data-pid="${p.productId}" data-pricevnd="${priceVND}" data-seller="${seller}">Mua</button>
        ${account && account.toLowerCase() === seller.toLowerCase()
          ? `<button class="btn btn-secondary" data-updatepid="${p.productId}">Cập nhật</button>`
          : ``}
      </div>
    </div>
  `;

  // Nút Mua
  div.querySelector(".btn-buy")?.addEventListener("click", (ev) => {
    const btn = ev.currentTarget;
    const pid = Number(btn.dataset.pid);
    const priceVND = Number(btn.dataset.pricevnd);
    const seller = btn.dataset.seller;

    // đổ dữ liệu sang formBuy
    $("#buyProductInfo").dataset.pid = String(pid);
    $("#buyProductInfo").dataset.priceVND = String(priceVND);
    $("#buyProductInfo").dataset.seller = seller;
    $("#buyProductInfo").innerHTML = `
      <div><b>Product ID:</b> ${pid}</div>
      <div><b>Giá:</b> ${formatVND(priceVND)} VND</div>
      <div><b>Người bán:</b> <a target="_blank" href="${CONFIG.EXPLORER}/address/${seller}">${shortAddr(seller)}</a></div>
    `;
    $("#buyQty").value = "1";
    updateBuyTotalVIN();

    showSection("buy");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // Nút Cập nhật
  div.querySelector("[data-updatepid]")?.addEventListener("click", (ev) => {
    const pid = Number(ev.currentTarget.dataset.updatepid || 0);
    $("#updatePid").value = String(pid);
    $("#updatePrice").value = "";
    $("#updateDays").value = "";
    $("#updateWallet").value = "";
    $("#updateActive").checked = true;
    showSection("update");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  return div;
}

/* -------------------- ĐƠN HÀNG CỦA TÔI -------------------- */
async function refreshMyOrders() {
  try {
    if (!signer) return;
    const my = (await signer.getAddress()).toLowerCase();

    const buyWrap  = $("#ordersBuySection");
    const sellWrap = $("#ordersSellSection");
    buyWrap.innerHTML  = `<div class="muted">Đang tải đơn mua…</div>`;
    sellWrap.innerHTML = `<div class="muted">Đang tải đơn bán…</div>`;

    const buyCards = [];
    const sellCards = [];

    for (let oid = 1; oid <= CONFIG.SCAN_MAX_ORDERS; oid++) {
      try {
        const o = await muaban.getOrder(oid);
        if (!o || !o.orderId || o.orderId.toString() !== String(oid)) continue;

        const buyer = String(o.buyer || "").toLowerCase();
        const seller = String(o.seller || "").toLowerCase();

        const row = renderOrderRow(o);

        if (buyer === my) buyCards.push(row);
        if (seller === my) sellCards.push(row);

        if (buyCards.length >= 50 && sellCards.length >= 50) break;
      } catch {}
    }

    buyWrap.innerHTML  = "";
    sellWrap.innerHTML = "";

    if (!buyCards.length)  buyWrap.innerHTML  = `<div class="muted">Chưa có đơn mua nào (trong phạm vi quét).</div>`;
    if (!sellCards.length) sellWrap.innerHTML = `<div class="muted">Chưa có đơn bán nào (trong phạm vi quét).</div>`;

    if (buyCards.length)  buyWrap.append(...buyCards);
    if (sellCards.length) sellWrap.append(...sellCards);

  } catch (err) {
    console.error("refreshMyOrders error:", err);
  }
}

function renderOrderRow(o) {
  // o: struct Order
  const wrap = document.createElement("div");
  wrap.className = "order-row";

  const statusMap = {
    0: "Đang xử lý",
    1: "Đã giao (chờ buyer xác nhận)",
    2: "Hoàn tất",
    3: "Đã hoàn tiền",
  };
  const statusStr = statusMap[o.status] ?? `Trạng thái: ${o.status}`;

  const vinAmt = o.vinAmount; // BigNumber
  const placedAt = new Date(Number(o.placedAt) * 1000);
  const deadline = new Date(Number(o.deadline) * 1000);

  wrap.innerHTML = `
    <div class="order-main">
      <div><b>Order #${o.orderId}</b> — Sản phẩm #${o.productId} — SL: ${o.quantity}</div>
      <div>VIN đã gửi: ${formatVinHuman(vinAmt, VIN_DECIMALS, 4)}</div>
      <div>Người bán: <a target="_blank" href="${CONFIG.EXPLORER}/address/${o.seller}">${shortAddr(o.seller)}</a></div>
      <div>Người mua: <a target="_blank" href="${CONFIG.EXPLORER}/address/${o.buyer}">${shortAddr(o.buyer)}</a></div>
      <div>Đặt lúc: ${placedAt.toLocaleString()}</div>
      <div>Hạn giao tối đa: ${deadline.toLocaleString()}</div>
      <div><b>${statusStr}</b></div>
    </div>
    <div class="order-actions" data-oid="${o.orderId}">
      <button class="btn btn-primary btn-confirm">Tôi đã nhận hàng</button>
      <button class="btn btn-warning btn-refund">Hoàn tiền (quá hạn)</button>
    </div>
  `;

  // Hành động
  wrap.querySelector(".btn-confirm")?.addEventListener("click", async () => {
    try {
      const tx = await muaban.confirmReceipt(o.orderId);
      toast("Gửi giao dịch xác nhận đã nhận hàng...");
      await tx.wait();
      toast("Đã xác nhận. Đơn sẽ chuyển trạng thái.");
      await refreshMyOrders();
    } catch (err) {
      handleTxError(err, "Xác nhận nhận hàng thất bại.");
    }
  });

  wrap.querySelector(".btn-refund")?.addEventListener("click", async () => {
    try {
      const tx = await muaban.refundIfExpired(o.orderId);
      toast("Gửi giao dịch hoàn tiền...");
      await tx.wait();
      toast("Hoàn tiền (nếu đã quá hạn) thành công.");
      await refreshMyOrders();
    } catch (err) {
      handleTxError(err, "Hoàn tiền thất bại.");
    }
  });

  return wrap;
}

/* -------------------- XỬ LÝ LỖI TX -------------------- */
function handleTxError(err, fallbackMsg="Giao dịch thất bại.") {
  console.error("TX ERR:", err);
  const msg = String(err?.data?.message || err?.error?.message || err?.message || "");
  if (msg.includes("Internal JSON-RPC error")) {
    toast("Lỗi RPC nội bộ (Internal JSON-RPC error). Hãy kiểm tra:\n- Đúng mạng VIC (chain 88)\n- Gas/nonce hợp lệ\n- Tham số truyền vào không rỗng\n- Đã approve đủ VIN trước khi gọi.", "error");
  } else if (msg.toLowerCase().includes("user rejected")) {
    toast("Bạn đã huỷ ký giao dịch.", "error");
  } else {
    toast(fallbackMsg + "\n" + (msg || ""), "error");
  }
}

/* -------------------- HỖ TRỢ KHÁC -------------------- */
// Dò sản phẩm của người bán hiện tại (nếu muốn hiển thị riêng)
// (Không bắt buộc; hiện đang quét mặc định tất cả pid trong khoảng SCAN_MAX_PRODUCTS)

/* ===================================================== */

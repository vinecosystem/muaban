/* muaban.vin – app.js
   ✅ Viết lại toàn bộ, xử dứt lỗi "Internal JSON-RPC error." khi Đăng sản phẩm / Mua hàng
   - Ethers v5 (UMD đã nhúng trong index.html)
   - Hỗ trợ cả đọc RPC (public) & ghi qua MetaMask
   - Bắt revert sớm bằng callStatic + validate dữ liệu trước khi gửi tx
   - Bắt buộc tx type 0 + gasPrice từ provider để tránh EIP-1559 không tương thích
   - Tự động approve VIN khi cần (đăng ký & mua)
   - Khớp 100% ABI/Tham số trong MuabanVND.sol
*/

(() => {
  const { ethers } = window.ethers ? window : window;
  if (!ethers) {
    console.error("ethers.js chưa sẵn sàng");
    return;
  }

  // -------------------- Hằng số --------------------
  const CHAIN_ID_HEX = "0x58"; // 88 (Viction mainnet)
  const RPCS = [
    "https://rpc.viction.xyz",
    "https://rpc.tomochain.com",
  ];

  const MUABAN_ADDR = "0x190FD18820498872354eED9C4C080cB365Cd12E0";
  const VIN_ADDR    = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4";

  // UI elements
  const el = (id) => document.getElementById(id);
  const $vinPrice = el("vinPrice");
  const $btnConnect = el("btnConnect");
  const $btnDisconnect = el("btnDisconnect");
  const $walletBox = el("walletBox");
  const $accountShort = el("accountShort");
  const $vinBal = el("vinBalance");
  const $vicBal = el("vicBalance");
  const $menuBox = el("menuBox");
  const $btnRegister = el("btnRegister");
  const $btnCreate = el("btnCreate");
  const $btnOrdersBuy = el("btnOrdersBuy");
  const $btnOrdersSell = el("btnOrdersSell");

  const $formCreate = el("formCreate");
  const $btnSubmitCreate = el("btnSubmitCreate");

  const $formUpdate = el("formUpdate");
  const $btnSubmitUpdate = el("btnSubmitUpdate");

  const $formBuy = el("formBuy");
  const $btnSubmitBuy = el("btnSubmitBuy");
  const $buyTotalVIN = el("buyTotalVIN");

  const $productList = el("productList");
  const $ordersBuySection = el("ordersBuySection");
  const $ordersSellSection = el("ordersSellSection");
  const $ordersBuyList = el("ordersBuyList");
  const $ordersSellList = el("ordersSellList");

  // State
  let readProvider;           // JSON-RPC để đọc
  let walletProvider;         // MetaMask provider
  let signer;                 // Signer
  let account = null;         // ví đang dùng
  let vinDecimals = 18;
  let muabanR, muabanW;       // Contract read/write
  let vinR, vinW;             // VIN ERC20 read/write

  // Cached ABIs
  let ABI_MUABAN = null;
  let ABI_ERC20  = null;

  // ---------- Utils ----------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const shortAddr = (a) => a ? a.slice(0,6)+"…"+a.slice(-4) : "0x…";
  const isAddress = (s) => {
    try { return ethers.utils.getAddress(s), true } catch { return false }
  }

  const show = (node) => node?.classList?.remove("hidden");
  const hide = (node) => node?.classList?.add("hidden");

  const alertErr = (msg, e=null) => {
    console.error(msg, e);
    alert(msg + (e?.error?.message ? ("\n\n"+e.error.message) : e?.message ? ("\n\n"+e.message) : ""));
  };

  // Lấy gasPrice an toàn, ép type 0 (legacy) để tránh lỗi JSON-RPC trên vài RPC không hỗ trợ EIP-1559
  async function legacyFeeOverrides() {
    try {
      const gp = await walletProvider.getGasPrice();
      return { gasPrice: gp, type: 0 };
    } catch {
      return { gasPrice: ethers.utils.parseUnits("1", "gwei"), type: 0 };
    }
  }

  // Parse JSON-RPC revert reason (thân thiện)
  function parseRevert(e) {
    const msg = e?.error?.message || e?.data?.message || e?.message || "";
    const known = [
      "NOT_REGISTERED","ALREADY_REGISTERED","PRICE_REQUIRED","DELIVERY_REQUIRED",
      "PAYOUT_WALLET_ZERO","PRODUCT_NOT_FOUND","PRODUCT_NOT_ACTIVE",
      "QUANTITY_REQUIRED","VIN_PER_VND_REQUIRED","VIN_TRANSFER_FAIL","NOT_SELLER","NOT_BUYER","NOT_PLACED","NOT_EXPIRED"
    ];
    for (const k of known) if (msg.includes(k)) return k;
    return msg || "Transaction failed";
  }

  // Tải ABI từ file bên cạnh
  async function loadAbis() {
    if (ABI_MUABAN && ABI_ERC20) return;
    const [muabanAbi, vinAbi] = await Promise.all([
      fetch("Muaban_ABI.json").then(r => r.json()),
      fetch("VinToken_ABI.json").then(r => r.json())
    ]);
    ABI_MUABAN = muabanAbi;
    ABI_ERC20 = vinAbi;
  }

  // Khởi tạo providers & contracts (read)
  async function initRead() {
    for (const url of RPCS) {
      try {
        const p = new ethers.providers.JsonRpcProvider(url, { name: "viction", chainId: 88 });
        await p.getBlockNumber(); // test
        readProvider = p;
        break;
      } catch {}
    }
    if (!readProvider) {
      throw new Error("Không kết nối được RPC để đọc dữ liệu");
    }
    await loadAbis();
    muabanR = new ethers.Contract(MUABAN_ADDR, ABI_MUABAN, readProvider);
    vinR    = new ethers.Contract(VIN_ADDR, ABI_ERC20, readProvider);
    try {
      vinDecimals = (await muabanR.vinDecimals()).toNumber?.() ?? 18;
    } catch {
      vinDecimals = 18;
    }
  }

  // Kết nối ví / chuẩn mạng
  async function connectWallet() {
    if (!window.ethereum) {
      alert("Vui lòng cài MetaMask để sử dụng.");
      return;
    }
    await initRead();

    // yêu cầu tài khoản
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    account = ethers.utils.getAddress(accounts[0]);

    // yêu cầu/switch network 88
    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    if (chainId !== CHAIN_ID_HEX) {
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: CHAIN_ID_HEX }],
        });
      } catch (e) {
        // thêm chain nếu chưa có
        if (e.code === 4902) {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: CHAIN_ID_HEX,
              chainName: "Viction",
              nativeCurrency: { name: "VIC", symbol: "VIC", decimals: 18 },
              rpcUrls: RPCS,
              blockExplorerUrls: ["https://www.vicscan.xyz/"],
            }],
          });
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: CHAIN_ID_HEX }],
          });
        } else {
          throw e;
        }
      }
    }

    walletProvider = new ethers.providers.Web3Provider(window.ethereum, "any");
    signer = walletProvider.getSigner();
    muabanW = muabanR.connect(signer);
    vinW    = vinR.connect(signer);

    bindWalletUI(account);
    await refreshBalances();
    await refreshRegistrationMenu();

    // listeners
    window.ethereum.on("accountsChanged", () => location.reload());
    window.ethereum.on("chainChanged", () => location.reload());
  }

  function bindWalletUI(addr) {
    hide($btnConnect);
    show($walletBox);
    $accountShort.textContent = shortAddr(addr);
    $accountShort.href = `https://www.vicscan.xyz/address/${addr}`;
  }

  async function refreshBalances() {
    try {
      const [vic, vin] = await Promise.all([
        walletProvider.getBalance(account),
        vinR.balanceOf(account)
      ]);
      $vicBal.textContent = "VIC: " + ethers.utils.formatUnits(vic, 18);
      $vinBal.textContent = "VIN: " + ethers.utils.formatUnits(vin, vinDecimals);
    } catch (e) {
      console.warn("Không đọc được số dư", e);
    }
  }

  async function isRegistered(addr) {
    try {
      return await muabanR.registered(addr);
    } catch {
      return false;
    }
  }

  async function refreshRegistrationMenu() {
    try {
      const ok = await isRegistered(account);
      show($menuBox);
      if (ok) {
        hide($btnRegister);
        show($btnCreate);
        show($btnOrdersBuy);
        show($btnOrdersSell);
      } else {
        show($btnRegister);
        hide($btnCreate);
        hide($btnOrdersBuy);
        hide($btnOrdersSell);
      }
    } catch (e) {
      console.warn("refreshRegistrationMenu:", e);
    }
  }

  // -------------------- Giá VIN/VND --------------------
  // Tính vinPerVND = 1e18 / (VIN giá VND)
  async function fetchVinVnd() {
    // Có thể thay bằng API ngoài (Binance/CoinGecko). Ở đây demo lấy từ localStorage hoặc yêu cầu nhập tay nếu thất bại
    const key = "vin_vnd_manual";
    let vinVnd = Number(localStorage.getItem(key) || "0");
    const fmt = (n) => n.toLocaleString("vi-VN");
    if (!vinVnd || !isFinite(vinVnd) || vinVnd <= 0) {
      // hỏi người dùng
      const s = prompt("Nhập tỉ giá: 1 VIN = ? VND (ví dụ 6000)", "6000");
      vinVnd = Number(s || "0");
      if (!vinVnd || !isFinite(vinVnd) || vinVnd <= 0) {
        $vinPrice.textContent = "Không có tỉ giá VIN/VND";
        throw new Error("Không có tỉ giá VIN/VND");
      }
      localStorage.setItem(key, String(vinVnd));
    }
    $vinPrice.textContent = `1 VIN ≈ ${fmt(vinVnd)} VND`;
    const vinPerVND = ethers.BigNumber.from("1" + "0".repeat(18)).div(ethers.BigNumber.from(String(Math.floor(vinVnd))));
    return { vinVnd, vinPerVND };
  }

  // -------------------- Đăng ký (payRegistration) --------------------
  async function handleRegister() {
    try {
      if (!signer) await connectWallet();
      const already = await isRegistered(account);
      if (already) {
        alert("Ví đã đăng ký rồi.");
        return;
      }
      const regFee = await muabanR.REG_FEE();
      const allowance = await vinR.allowance(account, MUABAN_ADDR);
      if (allowance.lt(regFee)) {
        const tx1 = await vinW.approve(MUABAN_ADDR, regFee, await legacyFeeOverrides());
        await tx1.wait();
      }
      // callStatic để bắt lỗi sớm (hiếm khi cần)
      try { await muabanW.callStatic.payRegistration(); } catch (e) {
        throw new Error(parseRevert(e));
      }
      const tx = await muabanW.payRegistration(await legacyFeeOverrides());
      await tx.wait();
      alert("Đăng ký thành công!");
      await refreshBalances();
      await refreshRegistrationMenu();
    } catch (e) {
      alertErr("Đăng ký thất bại.", e);
    }
  }

  // -------------------- Đăng sản phẩm (createProduct) --------------------
  function readCreateForm() {
    const name = el("createName").value.trim();
    const ipfs = el("createIPFS").value.trim();
    const unit = el("createUnit").value.trim();
    const priceVND = Number(el("createPrice").value.trim());
    const payoutWallet = el("createWallet").value.trim();
    const days = Number(el("createDays").value.trim());

    // descriptionCID: nhúng đơn vị tính đơn giản
    const descriptionCID = unit ? `unit:${unit}` : "";

    // imageCID: chấp nhận ipfs://CID hoặc https://ipfs.io/ipfs/CID hoặc link http
    const imageCID = ipfs;

    return { name, descriptionCID, imageCID, priceVND, payoutWallet, days };
  }

  function validateCreateForm(f) {
    if (!f.name || f.name.length > 500) throw new Error("Tên sản phẩm trống hoặc quá 500 ký tự");
    if (!f.imageCID) throw new Error("Thiếu Link IPFS (ảnh/video)");
    if (!f.priceVND || f.priceVND <= 0) throw new Error("Giá bán VNĐ phải > 0");
    if (!isAddress(f.payoutWallet)) throw new Error("Ví nhận thanh toán không hợp lệ");
    if (!f.days || f.days <= 0) throw new Error("Thời gian giao hàng (ngày) phải > 0");
  }

  async function handleCreateProduct() {
    try {
      if (!signer) await connectWallet();
      if (!(await isRegistered(account))) {
        alert("Bạn chưa đăng ký. Vui lòng bấm Đăng ký trước.");
        return;
      }
      const f = readCreateForm();
      validateCreateForm(f);

      // Tham số đúng thứ tự trong ABI: name, descriptionCID, imageCID, priceVND, deliveryDaysMax, payoutWallet, active
      const args = [
        f.name,
        f.descriptionCID,
        f.imageCID,
        ethers.BigNumber.from(String(Math.floor(f.priceVND))), // VND integer
        ethers.BigNumber.from(String(Math.floor(f.days))),     // uint32
        f.payoutWallet,
        true
      ];

      // callStatic để bắt revert reason trước
      try {
        await muabanW.callStatic.createProduct(...args);
      } catch (e) {
        throw new Error(parseRevert(e));
      }

      const tx = await muabanW.createProduct(...args, await legacyFeeOverrides());
      await tx.wait();
      alert("Đăng sản phẩm thành công!");
      hide($formCreate);
      await loadProducts(); // refresh list
    } catch (e) {
      alertErr("Đăng sản phẩm thất bại.", e);
    }
  }

  // -------------------- Mua hàng (placeOrder) --------------------
  let currentBuyProduct = null; // {pid, name, priceVND, unit}
  function openBuyForm(p) {
    currentBuyProduct = p;
    el("buyProductInfo").innerHTML = `
      <div><b>${p.name}</b></div>
      <div>${p.priceVND.toLocaleString("vi-VN")} VND / ${p.unit || "đ.vị"}</div>
    `;
    el("buyQty").value = 1;
    $buyTotalVIN.textContent = "Tổng VIN cần trả: 0";
    show($formBuy);
  }

  function utf8ToB64(str) {
    return window.btoa(unescape(encodeURIComponent(str)));
  }

  async function handleBuySubmit() {
    try {
      if (!signer) await connectWallet();
      if (!(await isRegistered(account))) {
        alert("Bạn chưa đăng ký. Vui lòng bấm Đăng ký trước.");
        return;
      }
      if (!currentBuyProduct) {
        alert("Không xác định sản phẩm.");
        return;
      }
      const name = el("buyName").value.trim();
      const addr = el("buyAddress").value.trim();
      const phone = el("buyPhone").value.trim();
      const note = el("buyNote").value.trim();
      const qty  = Number(el("buyQty").value.trim() || "1");
      if (!name || !addr || !phone) throw new Error("Vui lòng nhập đủ Họ tên / Địa chỉ / SĐT");
      if (!qty || qty <= 0) throw new Error("Số lượng phải > 0");

      const { vinPerVND } = await fetchVinVnd();
      // Tính tổng VND & ước lượng VIN
      const totalVND = ethers.BigNumber.from(String(currentBuyProduct.priceVND)).mul(String(qty));
      const vinEstimate = totalVND.mul(vinPerVND); // (VND * VINwei/VND) = VIN wei (đã làm tròn ceil ở contract)
      // approve nếu thiếu
      const allowance = await vinR.allowance(account, MUABAN_ADDR);
      if (allowance.lt(vinEstimate)) {
        const tx1 = await vinW.approve(MUABAN_ADDR, vinEstimate, await legacyFeeOverrides());
        await tx1.wait();
      }

      const buyerInfo = { name, addr, phone, note };
      const cipher = utf8ToB64(JSON.stringify(buyerInfo)); // ⚠️ chỉ là che giấu nhẹ, KHÔNG bảo mật thực sự

      const args = [
        ethers.BigNumber.from(String(currentBuyProduct.productId)),
        ethers.BigNumber.from(String(qty)),
        vinPerVND,     // uint256 VINwei per 1 VND
        cipher         // string
      ];

      // callStatic để bắt revert (sản phẩm hết hàng, ...)
      try {
        await muabanW.callStatic.placeOrder(...args);
      } catch (e) {
        throw new Error(parseRevert(e));
      }

      const tx = await muabanW.placeOrder(...args, await legacyFeeOverrides());
      await tx.wait();
      alert("Đặt hàng thành công!");
      hide($formBuy);
      await refreshBalances();
      await loadMyOrders(); // làm mới đơn hàng
    } catch (e) {
      alertErr("Đặt hàng thất bại.", e);
    }
  }

  // Hiển thị tổng VIN ước lượng trong form mua
  async function updateBuyTotalVin() {
    try {
      if (!currentBuyProduct) return;
      const qty = Number(el("buyQty").value.trim() || "1");
      if (!qty || qty <= 0) { $buyTotalVIN.textContent = "Tổng VIN cần trả: 0"; return; }
      const { vinPerVND, vinVnd } = await fetchVinVnd();
      const totalVND = currentBuyProduct.priceVND * qty;
      const estVin = (totalVND / vinVnd).toFixed(6);
      $buyTotalVIN.textContent = `Tổng VIN cần trả (ước lượng): ${estVin}`;
    } catch {
      $buyTotalVIN.textContent = "Tổng VIN cần trả: ?";
    }
  }

  // -------------------- Sản phẩm & Đơn hàng (hiển thị) --------------------
  function productCard(p, isMine) {
    const actionBtn = isMine
      ? `<button class="btn" data-act="update" data-pid="${p.productId}">Cập nhật sản phẩm</button>`
      : (p.active ? `<button class="btn primary" data-act="buy" data-pid="${p.productId}">Mua</button>` : `<span class="soldout">Hết hàng</span>`);
    const unit = p.unit || "đ.vị";
    return `<article class="product">
      <img src="${p.imageCID}" alt="${p.name}" onerror="this.src='logo.png'"/>
      <div class="p-body">
        <h3>${p.name}</h3>
        <div class="p-price">${p.priceVND.toLocaleString("vi-VN")} VND / ${unit}</div>
        <div class="p-status">${p.active ? "Còn hàng" : "Hết hàng"}</div>
        <div class="p-actions">${actionBtn}</div>
      </div>
    </article>`;
  }

  // Lấy tất cả pid từ event ProductCreated (trong 200k block gần nhất để nhẹ)
  async function fetchAllProductIds() {
    try {
      const latest = await readProvider.getBlockNumber();
      const step = 10_000;
      const from = Math.max(0, latest - 200_000);
      const filter = muabanR.filters.ProductCreated();
      let ids = new Set();
      for (let start = from; start <= latest; start += step) {
        const end = Math.min(latest, start + step - 1);
        const logs = await muabanR.queryFilter(filter, start, end);
        logs.forEach(l => ids.add(l.args?.productId?.toString()));
      }
      return Array.from(ids).map(s => Number(s)).sort((a,b)=>a-b);
    } catch (e) {
      console.warn("fetchAllProductIds:", e);
      return [];
    }
  }

  async function loadProducts() {
    try {
      const pids = await fetchAllProductIds();
      const me = account;
      const items = [];
      for (const pid of pids) {
        const pr = await muabanR.getProduct(pid);
        // parse unit từ descriptionCID nếu có dạng "unit:..."
        let unit = "";
        const d = pr.descriptionCID || "";
        if (d.startsWith("unit:")) unit = d.slice(5);
        const p = {
          productId: pr.productId.toNumber ? pr.productId.toNumber() : Number(pr.productId),
          seller: pr.seller,
          name: pr.name,
          descriptionCID: pr.descriptionCID,
          imageCID: pr.imageCID,
          priceVND: pr.priceVND.toNumber ? pr.priceVND.toNumber() : Number(pr.priceVND),
          deliveryDaysMax: pr.deliveryDaysMax.toNumber ? pr.deliveryDaysMax.toNumber() : Number(pr.deliveryDaysMax),
          payoutWallet: pr.payoutWallet,
          active: pr.active,
          unit,
        };
        const isMine = me && me.toLowerCase() === p.seller.toLowerCase();
        items.push(productCard(p, isMine));
      }
      $productList.innerHTML = items.join("") || "<p>Chưa có sản phẩm.</p>";
    } catch (e) {
      console.warn("loadProducts:", e);
      $productList.innerHTML = "<p>Không tải được danh sách sản phẩm.</p>";
    }
  }

  // Đơn hàng của tôi (buyer/seller) từ event OrderPlaced
  async function loadMyOrders() {
    try {
      if (!account) return;
      // Buyer
      const fB = muabanR.filters.OrderPlaced(null, null, account);
      const logsB = await muabanR.queryFilter(fB, 0, "latest");
      const buyerOrdersHtml = [];
      for (const lg of logsB) {
        const oid = lg.args?.orderId?.toString();
        const od = await muabanR.getOrder(oid);
        buyerOrdersHtml.push(renderOrderItem(od, "buyer"));
      }
      $ordersBuyList.innerHTML = buyerOrdersHtml.join("") || "<p>Chưa có đơn hàng mua.</p>";

      // Seller
      const fS = muabanR.filters.OrderPlaced(null, null, null); // lọc qua getOrder sau
      const logsS = await muabanR.queryFilter(fS, 0, "latest");
      const sellerOrdersHtml = [];
      for (const lg of logsS) {
        const oid = lg.args?.orderId?.toString();
        const od = await muabanR.getOrder(oid);
        if (od.seller && od.seller.toLowerCase() === account.toLowerCase()) {
          sellerOrdersHtml.push(renderOrderItem(od, "seller"));
        }
      }
      $ordersSellList.innerHTML = sellerOrdersHtml.join("") || "<p>Chưa có đơn hàng bán.</p>";
    } catch (e) {
      console.warn("loadMyOrders:", e);
    }
  }

  function renderOrderItem(od, role) {
    const stMap = ["NONE","PLACED","RELEASED","REFUNDED"];
    const status = stMap[ Number(od.status) ] || String(od.status);
    const dl = new Date(Number(od.deadline) * 1000);
    const line1 = `#${od.orderId} · SP ${od.productId} · SL ${od.quantity} · VIN ${ethers.utils.formatUnits(od.vinAmount, 18)}`;
    const line2 = `Trạng thái: ${status} · Hạn giao: ${dl.toLocaleDateString("vi-VN")}`;
    let actions = "";
    if (role==="buyer" && status==="PLACED") {
      actions = `<button class="btn small" data-act="confirm" data-oid="${od.orderId}">Xác nhận đã nhận</button>
                 <button class="btn small" data-act="refund" data-oid="${od.orderId}">Hoàn tiền (quá hạn)</button>`;
    }
    return `<div class="order-item">
      <div>${line1}</div>
      <div>${line2}</div>
      <div class="actions">${actions}</div>
    </div>`;
  }

  async function handleOrderAction(evt) {
    const t = evt.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.dataset.act === "confirm") {
      const oid = t.dataset.oid;
      try {
        await muabanW.callStatic.confirmReceipt(oid);
      } catch (e) { return alertErr("Xác nhận thất bại.", e); }
      const tx = await muabanW.confirmReceipt(oid, await legacyFeeOverrides());
      await tx.wait();
      alert("Đã xác nhận nhận hàng.");
      await loadMyOrders();
    }
    if (t.dataset.act === "refund") {
      const oid = t.dataset.oid;
      try {
        await muabanW.callStatic.refundIfExpired(oid);
      } catch (e) { return alertErr("Hoàn tiền thất bại.", e); }
      const tx = await muabanW.refundIfExpired(oid, await legacyFeeOverrides());
      await tx.wait();
      alert("Đã hoàn tiền nếu đơn quá hạn.");
      await loadMyOrders();
    }
    if (t.dataset.act === "update") {
      // mở form update, đổ dữ liệu
      const pid = Number(t.dataset.pid);
      el("updatePid").value = String(pid);
      const p = await muabanR.getProduct(pid);
      el("updatePrice").value = p.priceVND.toString();
      el("updateDays").value = p.deliveryDaysMax.toString();
      el("updateWallet").value = p.payoutWallet;
      el("updateActive").checked = !!p.active;
      show($formUpdate);
    }
    if (t.dataset.act === "buy") {
      const pid = Number(t.dataset.pid);
      const p = await muabanR.getProduct(pid);
      let unit = "";
      const d = p.descriptionCID || "";
      if (d.startsWith("unit:")) unit = d.slice(5);
      openBuyForm({
        productId: Number(p.productId),
        name: p.name,
        priceVND: Number(p.priceVND),
        unit,
      });
    }
  }

  async function handleUpdateProduct() {
    try {
      if (!signer) await connectWallet();
      const pid = Number(el("updatePid").value);
      const newPrice = Number(el("updatePrice").value);
      const newDays  = Number(el("updateDays").value);
      const newWallet= el("updateWallet").value.trim();
      const active   = !!el("updateActive").checked;
      if (!pid) throw new Error("Thiếu pid");
      if (!newPrice || newPrice <= 0) throw new Error("Giá phải > 0");
      if (!newDays || newDays <= 0) throw new Error("Ngày phải > 0");
      if (!isAddress(newWallet)) throw new Error("Ví nhận thanh toán không hợp lệ");
      const args = [
        ethers.BigNumber.from(String(pid)),
        ethers.BigNumber.from(String(Math.floor(newPrice))),
        ethers.BigNumber.from(String(Math.floor(newDays))),
        newWallet,
        active
      ];
      try {
        await muabanW.callStatic.updateProduct(...args);
      } catch (e) {
        throw new Error(parseRevert(e));
      }
      const tx = await muabanW.updateProduct(...args, await legacyFeeOverrides());
      await tx.wait();
      alert("Cập nhật sản phẩm thành công!");
      hide($formUpdate);
      await loadProducts();
    } catch (e) {
      alertErr("Cập nhật thất bại.", e);
    }
  }

  // -------------------- Sự kiện UI --------------------
  function bindUI() {
    $btnConnect?.addEventListener("click", connectWallet);
    $btnDisconnect?.addEventListener("click", () => location.reload());
    $btnRegister?.addEventListener("click", handleRegister);
    $btnCreate?.addEventListener("click", () => show($formCreate));
    document.querySelectorAll(".modal .close").forEach(btn => btn.addEventListener("click", (e) => {
      e.target.closest(".modal").classList.add("hidden");
    }));

    $btnSubmitCreate?.addEventListener("click", handleCreateProduct);
    $btnSubmitUpdate?.addEventListener("click", handleUpdateProduct);
    $btnSubmitBuy?.addEventListener("click", handleBuySubmit);
    el("buyQty")?.addEventListener("input", updateBuyTotalVin);

    // click trong danh sách sản phẩm / đơn hàng
    $productList?.addEventListener("click", handleOrderAction);
    $ordersBuyList?.addEventListener("click", handleOrderAction);
    $ordersSellList?.addEventListener("click", handleOrderAction);

    // tìm kiếm đơn giản theo tên (client-side)
    el("btnSearch")?.addEventListener("click", () => {
      const q = (el("searchInput").value || "").trim().toLowerCase();
      document.querySelectorAll(".product").forEach(card => {
        const name = (card.querySelector("h3")?.textContent || "").toLowerCase();
        card.style.display = (!q || name.includes(q)) ? "" : "none";
      });
    });
  }

  // -------------------- Khởi động --------------------
  (async function main() {
    try {
      bindUI();
      await initRead();
      await loadProducts();
      // Gợi ý nhập tỉ giá lần đầu
      try { await fetchVinVnd(); } catch {}
    } catch (e) {
      console.warn("Init lỗi:", e);
    }
  })();
})();

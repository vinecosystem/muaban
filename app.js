/* ============================================================
   app.js — muaban dApp (Viction)
   Hợp đồng: 0xe01e2213A899E9B3b1921673D2d13a227a8df638
   VIN token: 0x941F63807401efCE8afe3C9d88d368bAA287Fac4
   ============================================================ */

(() => {
  // ------- Config -------
  const CFG = window.MUABAN_CONFIG || {};
  const MUABAN_ADDRESS = CFG.MUABAN_ADDRESS || "0xe01e2213A899E9B3b1921673D2d13a227a8df638";
  const VIN_ADDRESS     = CFG.VIN_TOKEN     || "0x941F63807401efCE8afe3C9d88d368bAA287Fac4";
  const VIC_CHAIN_ID_HEX= CFG.VIC_CHAIN_ID_HEX || "0x58"; // Viction Mainnet

  // ------- State -------
  const app = window.app = {
    provider: null,
    signer: null,
    account: null,
    contracts: { muaban: null, vin: null },
    abi: { muaban: null, vin: null },
  };

  // ------- UI -------
  const $ = (id) => document.getElementById(id);
  const ui = {
    btnConnect   : $("btnConnect"),
    walletInfo   : $("walletInfo"),
    accountShort : $("accountShort"),
    accountFull  : $("accountFull"),
    vinBalance   : $("vinBalance"),
    vicBalance   : $("vicBalance"),
    statusLine   : $("statusLine"),
    btnRegister  : $("btnRegister"),
    // Buy panel
    buyPanel     : $("buyPanel"),
    productIdInp : $("productId"),
    qtyInp       : $("quantity"),
    vinPerUSDInp : $("vinPerUSD"),
    shipName     : $("shipName"),
    shipPhone    : $("shipPhone"),
    shipAddr     : $("shipAddr"),
    shipNote     : $("shipNote"),
    btnApproveBuy: $("btnApproveBuy"),
    btnPlaceOrder: $("btnPlaceOrder"),
    // Orders (buyer)
    orderIdInp   : $("orderId"),
    btnConfirm   : $("btnConfirm"),
    btnRefund    : $("btnRefund"),
  };

  // ------- Helpers -------
  const shortAddr = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
  const fmtNum = (v, d = 4) => Number(v).toFixed(d);
  const show = (el) => el && el.classList.remove("hidden");
  const hide = (el) => el && el.classList.add("hidden");
  const parseBn = ethers.BigNumber.from;

  // ------- Load ABIs -------
  async function loadABIs() {
    const [muabanAbi, vinAbi] = await Promise.all([
      fetch(CFG.MUABAN_ABI_PATH || "./Muaban_ABI.json").then((r) => r.json()),
      fetch("./VinToken_ABI.json").then((r) => r.json()),
    ]);
    app.abi.muaban = muabanAbi;
    app.abi.vin = vinAbi;
  }

  // ------- Chain helpers -------
  async function ensureChain() {
    if (!window.ethereum) return;
    const cur = await window.ethereum.request({ method: "eth_chainId" }).catch(() => null);
    if (cur && cur.toLowerCase() === String(VIC_CHAIN_ID_HEX).toLowerCase()) return true;

    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: VIC_CHAIN_ID_HEX }],
      });
      return true;
    } catch (e) {
      console.warn("Switch chain failed:", e);
      return false;
    }
  }

  // ------- Connect / Disconnect -------
  async function connectWallet() {
    if (!window.ethereum) {
      alert("Vui lòng cài ví (MetaMask, Ramper…) để kết nối.");
      return;
    }
    await ensureChain();

    try {
      const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
      app.provider = new ethers.providers.Web3Provider(window.ethereum);
      app.signer = app.provider.getSigner();
      app.account = ethers.utils.getAddress(addr);

      await initContracts();
      await refreshAccountUI();
      show(ui.walletInfo);
      if (ui.btnConnect) ui.btnConnect.textContent = "Đã kết nối";
      ui.btnConnect?.setAttribute("disabled", "disabled");
    } catch (e) {
      console.error(e);
      alert(e?.message || "Không thể kết nối ví.");
    }
  }

  async function initContracts() {
    app.contracts.muaban = new ethers.Contract(MUABAN_ADDRESS, app.abi.muaban, app.signer || app.provider);
    app.contracts.vin = new ethers.Contract(VIN_ADDRESS, app.abi.vin, app.signer || app.provider);
  }

  async function refreshAccountUI() {
    if (!app.provider || !app.contracts.vin) return;

    // address
    ui.accountShort.textContent = shortAddr(app.account);
    ui.accountFull.textContent = app.account;

    // balances
    const [vinBalWei, vicBalWei] = await Promise.all([
      app.contracts.vin.balanceOf(app.account),
      app.provider.getBalance(app.account),
    ]);
    const vinBal = ethers.utils.formatUnits(vinBalWei, 18);
    const vicBal = ethers.utils.formatEther(vicBalWei);
    ui.vinBalance.textContent = fmtNum(vinBal) + " VIN";
    ui.vicBalance.textContent = fmtNum(vicBal) + " VIC";

    // registration
    const reg = await app.contracts.muaban.isRegistered(app.account);
    if (reg) {
      ui.statusLine.textContent = "Ví đã đăng ký.";
      hide(ui.btnRegister);
    } else {
      ui.statusLine.textContent = "Ví chưa đăng ký.";
      show(ui.btnRegister);
    }
  }

  // ------- Allowance helpers -------
  async function getPlatformFeeWei() {
    try {
      // PLATFORM_FEE is view on contract ABI
      const fee = await app.contracts.muaban.PLATFORM_FEE();
      return parseBn(fee);
    } catch {
      // fallback = 0.001 VIN
      return parseBn("1000000000000000"); // 1e15 wei
    }
  }

  async function currentAllowance(owner, spender) {
    return await app.contracts.vin.allowance(owner, spender);
  }

  async function ensureAllowance(requiredWei) {
    const allowance = await currentAllowance(app.account, MUABAN_ADDRESS);
    if (parseBn(allowance).gte(requiredWei)) return;
    // Approve exactly requiredWei for safety (user có thể Approve lớn bằng nút riêng)
    const tx = await app.contracts.vin.approve(MUABAN_ADDRESS, requiredWei);
    await tx.wait(1);
  }

  // ------- Register (0.001 VIN) -------
  async function handleRegister() {
    if (!app.signer) { alert("Kết nối ví trước."); return; }
    try {
      ui.btnRegister.disabled = true;
      ui.btnRegister.textContent = "Đang đăng ký…";

      const fee = await getPlatformFeeWei();
      await ensureAllowance(fee);
      const tx = await app.contracts.muaban.payRegistration();
      await tx.wait(1);

      ui.statusLine.textContent = "Đã đăng ký thành công.";
      hide(ui.btnRegister);
      await refreshAccountUI();
    } catch (e) {
      console.error(e);
      alert(e?.data?.message || e?.message || "Đăng ký thất bại.");
    } finally {
      ui.btnRegister.disabled = false;
      ui.btnRegister.textContent = "Đăng ký (0.001 VIN)";
    }
  }

  // ------- Price math (mirror logic in contract) -------
  // Convert USD-cents → VIN wei, with ceiling per cent to protect seller:
  // wei = ceil(usdCents * vinPerUSD / 100)
  function usdCentsToVinWei(usdCentsBN, vinPerUSDWeiBN) {
    const cents = parseBn(usdCentsBN);
    const vinPerUSD = parseBn(vinPerUSDWeiBN);
    const prod = cents.mul(vinPerUSD);
    const ceil = prod.add(ethers.BigNumber.from(100 - 1)).div(100);
    return ceil;
  }

  async function getProduct(productId) {
    const p = await app.contracts.muaban.products(productId);
    // Support tuple or mapping style indexes
    return {
      seller            : p.seller || p[1],
      name              : p.name || p[2],
      descriptionCID    : p.descriptionCID || p[3],
      imageCID          : p.imageCID || p[4],
      priceUsdCents     : parseBn(p.priceUsdCents || p[5] || 0),
      shippingUsdCents  : parseBn(p.shippingUsdCents || p[6] || 0),
      taxRateBps        : parseBn(p.taxRateBps || p[7] || 0),
      deliveryDaysMax   : parseBn(p.deliveryDaysMax || p[8] || 0),
      stock             : parseBn(p.stock || p[14] || 0),
      active            : Boolean(p.active),
    };
  }

  // Estimate vinTotal (for auto-approve)
  async function quoteVinTotalWei(productId, qty, vinPerUSDWei) {
    const p = await getProduct(productId);
    if (!p.active) throw new Error("Sản phẩm đang ẩn.");
    if (p.stock.lt(qty)) throw new Error("Tồn kho không đủ.");

    const q = parseBn(qty);
    const priceAll = p.priceUsdCents.mul(q);
    const ship = p.shippingUsdCents;

    // taxUsdCents = ceil(priceAll * taxBps / 10000)
    const taxUsd = priceAll.mul(p.taxRateBps).add(ethers.BigNumber.from(10000 - 1)).div(10000);

    const vinRev  = usdCentsToVinWei(priceAll, vinPerUSDWei);
    const vinShip = usdCentsToVinWei(ship, vinPerUSDWei);
    const vinTax  = usdCentsToVinWei(taxUsd, vinPerUSDWei);

    return { vinRev, vinShip, vinTax, vinTotal: vinRev.add(vinShip).add(vinTax) };
  }

  // ------- Shipping payload (plaintext JSON → bytes) -------
  function collectShipping() {
    const name = ui.shipName?.value?.trim();
    const phone = ui.shipPhone?.value?.trim();
    const addr = ui.shipAddr?.value?.trim();
    const note = ui.shipNote?.value?.trim() || "";
    if (!name || !phone || !addr) throw new Error("Điền đủ Tên, SĐT và Địa chỉ giao hàng.");
    const obj = { name, phone, addr, note };
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    return ethers.utils.hexlify(bytes);
  }

  // ------- Approve big (optional convenience) -------
  async function approveBuyLarge() {
    const BIG = parseBn("100000000000000000000000"); // 1e23 wei (~100k VIN)
    try {
      await ensureAllowance(BIG);
      alert("Đã approve VIN cho hợp đồng.");
    } catch (e) {
      console.error(e);
      alert(e?.data?.message || e?.message || "Approve thất bại.");
    }
  }

  // ------- Place order -------
  async function placeOrder() {
    if (!app.signer) { alert("Kết nối ví trước."); return; }

    // Must be registered
    const reg = await app.contracts.muaban.isRegistered(app.account);
    if (!reg) { alert("Ví chưa đăng ký. Vui lòng bấm Đăng ký."); return; }

    const pid = parseInt(ui.productIdInp?.value || "0", 10);
    const qty = Math.max(1, parseInt(ui.qtyInp?.value || "1", 10));
    const vinPerUSDInput = (ui.vinPerUSDInp?.value || "").trim();
    if (!pid || !vinPerUSDInput) { alert("Thiếu Mã SP hoặc vinPerUSD."); return; }

    let vinPerUSDWei;
    try { vinPerUSDWei = ethers.utils.parseUnits(vinPerUSDInput, 18); }
    catch { vinPerUSDWei = parseBn(vinPerUSDInput); }

    try {
      // Auto-approve exact vinTotal needed
      const { vinTotal } = await quoteVinTotalWei(pid, qty, vinPerUSDWei);
      await ensureAllowance(vinTotal);

      const shipBytes = collectShipping();
      ui.btnPlaceOrder.disabled = true;
      ui.btnPlaceOrder.textContent = "Đang đặt…";

      const tx = await app.contracts.muaban.placeOrder(pid, qty, vinPerUSDWei, shipBytes);
      await tx.wait(1);
      alert("Đặt hàng thành công!");
      ui.buyPanel?.classList.add("hidden");
    } catch (e) {
      console.error(e);
      alert(e?.data?.message || e?.message || "Đặt hàng thất bại.");
    } finally {
      ui.btnPlaceOrder.disabled = false;
      ui.btnPlaceOrder.textContent = "Mua (placeOrder)";
    }
  }

  // ------- Buyer actions -------
  async function confirmReceipt() {
    if (!app.signer) { alert("Kết nối ví trước."); return; }
    const oid = parseInt(ui.orderIdInp?.value || "0", 10);
    if (!oid) { alert("Nhập Order ID."); return; }

    try {
      ui.btnConfirm.disabled = true;
      const tx = await app.contracts.muaban.confirmReceipt(oid);
      await tx.wait(1);
      alert("Đã giải ngân escrow cho người bán.");
    } catch (e) {
      console.error(e);
      alert(e?.data?.message || e?.message || "Xác nhận thất bại.");
    } finally {
      ui.btnConfirm.disabled = false;
    }
  }

  async function refundIfExpired() {
    if (!app.signer) { alert("Kết nối ví trước."); return; }
    const oid = parseInt(ui.orderIdInp?.value || "0", 10);
    if (!oid) { alert("Nhập Order ID."); return; }

    try {
      ui.btnRefund.disabled = true;
      const tx = await app.contracts.muaban.refundIfExpired(oid);
      await tx.wait(1);
      alert("Đã hoàn tiền cho đơn quá hạn.");
    } catch (e) {
      console.error(e);
      alert(e?.data?.message || e?.message || "Hoàn tiền thất bại.");
    } finally {
      ui.btnRefund.disabled = false;
    }
  }

  // ------- Wire up -------
  function wireUI() {
    if (ui.btnConnect) ui.btnConnect.addEventListener("click", connectWallet);
    if (ui.btnRegister) ui.btnRegister.addEventListener("click", handleRegister);

    if (ui.btnApproveBuy) ui.btnApproveBuy.addEventListener("click", approveBuyLarge);
    if (ui.btnPlaceOrder) ui.btnPlaceOrder.addEventListener("click", placeOrder);

    if (ui.btnConfirm) ui.btnConfirm.addEventListener("click", confirmReceipt);
    if (ui.btnRefund) ui.btnRefund.addEventListener("click", refundIfExpired);

    if (window.ethereum) {
      window.ethereum.on("accountsChanged", () => location.reload());
      window.ethereum.on("chainChanged", () => location.reload());
    }
  }

  // ------- Init -------
  document.addEventListener("DOMContentLoaded", async () => {
    try {
      await loadABIs();
      // If user has wallet, prepare a read-only provider first
      if (window.ethereum) {
        app.provider = new ethers.providers.Web3Provider(window.ethereum);
      }
    } catch (e) {
      console.warn("ABI load failed:", e);
    } finally {
      wireUI();
    }
  });
})();

/* ===== End of app.js ===== */

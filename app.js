/* ====================================================================
   muaban.vin — app.js (ethers v5)
   Bản full ổn định | Khắc phục triệt để "Internal JSON-RPC error"
   - Simulate trước khi ký: populateTransaction + provider.call({from})
   - Phí gas TỰ NHẬN DIỆN: ưu tiên EIP-1559 nếu node hỗ trợ, fallback legacy
   - Wrapper sendWithFallback: nếu RPC từ chối kiểu tx hiện tại sẽ tự đổi kiểu
   - Đồng bộ chặt chẽ với index.html + Muaban_ABI.json + VinToken_ABI.json
==================================================================== */

/* -------------------- DOM helpers -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show = el=>{ if(!el) return; el.classList.remove("hidden"); };
const hide = el=>{ if(!el) return; el.classList.add("hidden"); };
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`:"";
const toast=(m)=>alert(m);

/* -------------------- Cấu hình mạng/địa chỉ -------------------- */
const CONFIG = {
  CHAIN_ID: 88,
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://www.vicscan.xyz",
  // Cho phép override qua <body data-muaban-addr="0x.." data-vin-addr="0x.." data-vin-vnd="65000">
  DEFAULT_MUABAN: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  DEFAULT_VIN:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",
  REG_FEE_WEI:    "1000000000000000", // 0.001 VIN
  PRICE_SOURCES: {
    COINGECKO_VIC_VND: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=vnd",
    COINGECKO_VIC_USD: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=usd",
    COINGECKO_USD_VND: "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",
    BINANCE_VICUSDT:   "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",
  },
  GAS: {
    LEGACY_GWEI: "80",                    // có thể tăng lên 120/150 nếu mạng bận
    LIMIT_LIGHT: "200000",                // approve/confirm/refund
    LIMIT_MED:   "400000",                // payRegistration/update/placeOrder
    LIMIT_HEAVY: "800000",                // createProduct
  }
};

/* -------------------- Biến trạng thái toàn cục -------------------- */
let providerRead, providerWrite, signer, account;
let MUABAN_ABI, VIN_ABI;
let muabanR, vinR;   // contract ở chế độ đọc
let muaban,  vin;    // contract ở chế độ ghi (với signer)
let isRegistered = false;

let vinVND = 0;                                 // 1 VIN = ? VND (floor)
let vinPerVNDWei = ethers.BigNumber.from(0);    // số VIN (wei) cho 1 VND (ceil)
let productsCache = [];
let ordersBuyer = [];
let ordersSeller = [];

/* -------------------- Tiện ích parse/format -------------------- */
function parseVND(raw){
  const s = String(raw||"").replace(/[^\d]/g,"").trim();
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
function ipfsToHttp(link){
  if (!link) return "";
  if (link.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + link.slice(7);
  return link;
}
function parseUnitFromCID(desc){
  if (!desc) return "";
  const m = /^unit:(.+)$/i.exec(desc.trim());
  return m ? m[1].trim() : "";
}
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;" }[s]||s));
}
function statusText(code){
  const m = {0:"-",1:"Đang xử lý",2:"Đã giải ngân",3:"Đã hoàn tiền"};
  return m[Number(code)] || "-";
}

/* -------------------- Bóc tách lỗi từ RPC (có popup debug) -------------------- */
function parseRevert(err){
  const raw = err?.error?.message || err?.data?.message || err?.reason || err?.message || "";
  const map = {
    NOT_REGISTERED: "Ví này chưa đăng ký. Bấm “Đăng ký” trước.",
    ALREADY_REGISTERED: "Ví đã đăng ký.",
    PRICE_REQUIRED: "Giá bán (VND) phải > 0.",
    DELIVERY_REQUIRED: "Thời gian giao hàng (ngày) phải ≥ 1.",
    PAYOUT_WALLET_ZERO: "Ví nhận thanh toán không được để trống.",
    NOT_SELLER: "Bạn không phải người bán của sản phẩm này.",
    PRODUCT_NOT_ACTIVE: "Sản phẩm đang tắt bán.",
    PRODUCT_NOT_FOUND: "Không tìm thấy sản phẩm.",
    QUANTITY_REQUIRED: "Số lượng phải ≥ 1.",
    VIN_PER_VND_REQUIRED: "Tỷ giá VIN/VND chưa sẵn sàng.",
    VIN_TRANSFER_FAIL: "Chuyển VIN thất bại (kiểm tra số dư/allowance).",
    NOT_PLACED: "Trạng thái đơn không hợp lệ.",
    NOT_BUYER: "Chỉ người mua mới thực hiện được thao tác này.",
    NOT_EXPIRED: "Đơn chưa quá hạn giao hàng."
  };
  for (const k in map) if (raw.includes(k)) return map[k];

  const m = /execution reverted(?: with reason string)?:\s*([^\n]+)/i.exec(raw);
  if (m) return m[1];

  try{
    const data = err?.error?.data || err?.data;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10){
      const iface = new ethers.utils.Interface(["function Error(string)"]);
      const reason = iface.parseError(data)?.args?.[0];
      if (reason) return String(reason);
    }
  }catch(_){}

  return raw || "Giao dịch bị từ chối hoặc dữ liệu không hợp lệ.";
}
function showRpc(err, tag="RPC"){
  try{
    const obj = {
      tag,
      code: err?.code,
      message: err?.message || err?.error?.message,
      data: err?.data || err?.error?.data,
      reason: err?.reason,
    };
    console.error(tag, obj);
    alert(`${tag}\n${JSON.stringify(obj, null, 2)}`);
  }catch(_){
    console.error(tag, err);
    alert(`${tag}: ${String(err)}`);
  }
}

/* -------------------- Nạp ABI & đọc địa chỉ từ <body data-*> -------------------- */
async function loadAbis(){
  MUABAN_ABI = await fetch("Muaban_ABI.json").then(r=>r.json());
  VIN_ABI    = await fetch("VinToken_ABI.json").then(r=>r.json());
}
function getAddresses(){
  const b = document.body;
  const muabanAddr = b?.dataset?.muabanAddr;
  const vinAddr    = b?.dataset?.vinAddr;
  return {
    MUABAN: (muabanAddr && ethers.utils.isAddress(muabanAddr)) ? muabanAddr : CONFIG.DEFAULT_MUABAN,
    VIN:    (vinAddr && ethers.utils.isAddress(vinAddr)) ? vinAddr : CONFIG.DEFAULT_VIN
  };
}
function getVinVndOverride(){
  const v = Number(document.body?.dataset?.vinVnd||0);
  return Number.isFinite(v) && v>0 ? Math.floor(v) : 0;
}

/* -------------------- Khởi tạo Providers & Contracts -------------------- */
function initProviders(){
  providerRead = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
  if (window.ethereum){
    providerWrite = new ethers.providers.Web3Provider(window.ethereum, "any");
  }
}
function initReadContracts(){
  const { MUABAN, VIN } = getAddresses();
  muabanR = new ethers.Contract(MUABAN, MUABAN_ABI, providerRead);
  vinR    = new ethers.Contract(VIN,    VIN_ABI,    providerRead);
}
function initWriteContracts(){
  const { MUABAN, VIN } = getAddresses();
  muaban = new ethers.Contract(MUABAN, MUABAN_ABI, signer);
  vin    = new ethers.Contract(VIN,    VIN_ABI,    signer);
}

/* -------------------- GAS overrides + gửi có Fallback -------------------- */
// Tự nhận diện 1559 hay legacy ở thời điểm gửi
async function buildOverrides(kind="med"){
  const gasLimit =
    (kind==="light") ? ethers.BigNumber.from(CONFIG.GAS.LIMIT_LIGHT) :
    (kind==="heavy") ? ethers.BigNumber.from(CONFIG.GAS.LIMIT_HEAVY) :
                       ethers.BigNumber.from(CONFIG.GAS.LIMIT_MED);

  // Thử 1559
  try{
    const latest = await providerWrite.getBlock("latest");
    if (latest && latest.baseFeePerGas){
      const maxPriority = ethers.utils.parseUnits("1.5","gwei");
      const maxFee = latest.baseFeePerGas.mul(2).add(maxPriority);
      return { type: 2, maxFeePerGas: maxFee, maxPriorityFeePerGas: maxPriority, gasLimit };
    }
  }catch(_){ /* bỏ qua để fallback legacy */ }

  // Legacy
  return {
    type: 0,
    gasPrice: ethers.utils.parseUnits(CONFIG.GAS.LEGACY_GWEI, "gwei"),
    gasLimit
  };
}

// Gửi giao dịch với fallback: nếu kiểu hiện tại bị RPC từ chối → lật kiểu và thử lại
async function sendWithFallback(factory, kind="med", tag="sendTx"){
  try{
    const ov = await buildOverrides(kind);
    const tx = await factory(ov);
    return await tx.wait();
  }catch(e1){
    // Thử lật kiểu
    try{
      const latest = await providerWrite.getBlock("latest");
      const gasLimit =
        (kind==="light") ? ethers.BigNumber.from(CONFIG.GAS.LIMIT_LIGHT) :
        (kind==="heavy") ? ethers.BigNumber.from(CONFIG.GAS.LIMIT_HEAVY) :
                           ethers.BigNumber.from(CONFIG.GAS.LIMIT_MED);

      let ov;
      if (latest && latest.baseFeePerGas){
        // Lần 1 có thể đã dùng legacy → thử 1559
        const maxPriority = ethers.utils.parseUnits("1.5","gwei");
        const maxFee = latest.baseFeePerGas.mul(2).add(maxPriority);
        ov = { type: 2, maxFeePerGas: maxFee, maxPriorityFeePerGas: maxPriority, gasLimit };
      }else{
        // Lần 1 có thể đã dùng 1559 → thử legacy
        ov = { type: 0, gasPrice: ethers.utils.parseUnits(CONFIG.GAS.LEGACY_GWEI, "gwei"), gasLimit };
      }
      const tx2 = await factory(ov);
      return await tx2.wait();
    }catch(e2){
      showRpc(e2, tag);
      throw e2;
    }
  }
}
/* ==================== TỶ GIÁ VIN/VND ==================== */
// Ưu tiên lấy từ <body data-vin-vnd="...">; nếu không có thì tính từ API
async function fetchVinToVND(){
  try{
    const override = getVinVndOverride();
    if (override > 0){
      vinVND = override;
    }else{
      // 1) CoinGecko VIC→VND trực tiếp
      let vicVnd = 0;
      try{
        const r = await fetch(CONFIG.PRICE_SOURCES.COINGECKO_VIC_VND);
        const j = await r.json();
        vicVnd = Number(j?.viction?.vnd||0);
      }catch(_){}

      if (vicVnd > 0){
        vinVND = Math.floor(vicVnd * 100); // 1 VIN = 100 VIC
      }else{
        // 2) VIC→USD × USDT→VND
        try{
          const [vicUsdRes, usdtVndRes] = await Promise.all([
            fetch(CONFIG.PRICE_SOURCES.COINGECKO_VIC_USD),
            fetch(CONFIG.PRICE_SOURCES.COINGECKO_USD_VND)
          ]);
          const vicUsd = Number((await vicUsdRes.json())?.viction?.usd||0);
          const usdtVnd= Number((await usdtVndRes.json())?.tether?.vnd||0);
          if (vicUsd>0 && usdtVnd>0){
            vinVND = Math.floor(vicUsd * 100 * usdtVnd);
          }
        }catch(_){}
      }

      if (!(vinVND>0)){
        // 3) Dự phòng Binance VIC/USDT × USDT/VND
        try{
          const [vicUsdtRes, usdtVndRes] = await Promise.all([
            fetch(CONFIG.PRICE_SOURCES.BINANCE_VICUSDT),
            fetch(CONFIG.PRICE_SOURCES.COINGECKO_USD_VND)
          ]);
          const vicUsdt = Number((await vicUsdtRes.json())?.price||0);
          const usdtVnd = Number((await usdtVndRes.json())?.tether?.vnd||0);
          if (vicUsdt>0 && usdtVnd>0){
            vinVND = Math.floor(vicUsdt * 100 * usdtVnd);
          }
        }catch(_){}
      }
    }

    if (!(vinVND>0)) throw new Error("Không lấy được giá");

    const ONE = ethers.BigNumber.from("1000000000000000000");
    // 1 VND = ? VIN_wei  (ceil để không thiếu VIN)
    vinPerVNDWei = ONE.div(vinVND);
    if (ONE.mod(vinVND).gt(0)) vinPerVNDWei = vinPerVNDWei.add(1);

    document.querySelector("#vinPrice")?.replaceChildren(
      `1 VIN = ${vinVND.toLocaleString("vi-VN")} VND`
    );
  }catch(e){
    console.error("fetchVinToVND:", e);
    if (vinPerVNDWei.isZero()){
      document.querySelector("#vinPrice")?.replaceChildren("Đang tải giá…");
    }
  }
}

/* ==================== KẾT NỐI / NGẮT VÍ ==================== */
async function ensureOnViction(){
  const net = await providerWrite.getNetwork();
  if (Number(net.chainId) === CONFIG.CHAIN_ID) return true;

  // Thử switch mạng sang Viction (0x58)
  try{
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x58" }]
    });
    return true;
  }catch(e1){
    // Thử add mạng nếu chưa có
    try{
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0x58",
          chainName: "Viction",
          nativeCurrency: { name: "VIC", symbol: "VIC", decimals: 18 },
          rpcUrls: [CONFIG.RPC_URL],
          blockExplorerUrls: [CONFIG.EXPLORER]
        }]
      });
      return true;
    }catch(e2){
      showRpc(e2, "switch/add chain");
      return false;
    }
  }
}

async function refreshBalances(){
  try{
    const [vinBal, vicBal] = await Promise.all([
      vinR.balanceOf(account),
      providerWrite.getBalance(account)
    ]);
    const vinTxt = parseFloat(ethers.utils.formatUnits(vinBal,18)).toFixed(4);
    const vicTxt = parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4);
    document.querySelector("#vinBalance").textContent = `VIN: ${vinTxt}`;
    document.querySelector("#vicBalance").textContent = `VIC: ${vicTxt}`;
  }catch(e){
    console.error("refreshBalances:", e);
  }
}

function refreshMenu(){
  const btnReg = document.querySelector("#btnRegister");
  const btnCrt = document.querySelector("#btnCreate");
  const btnOB  = document.querySelector("#btnOrdersBuy");
  const btnOS  = document.querySelector("#btnOrdersSell");
  const menu   = document.querySelector("#menuBox");

  if (!account){
    btnReg?.classList.remove("hidden"); if (btnReg) btnReg.disabled = true;
    btnCrt?.classList.add("hidden");
    btnOB?.classList.add("hidden");
    btnOS?.classList.add("hidden");
    return;
  }
  if (!isRegistered){
    btnReg?.classList.remove("hidden"); if (btnReg) btnReg.disabled = false;
    btnCrt?.classList.add("hidden");
    btnOB?.classList.add("hidden");
    btnOS?.classList.add("hidden");
  }else{
    btnReg?.classList.add("hidden");
    btnCrt?.classList.remove("hidden");
    btnOB?.classList.remove("hidden");
    btnOS?.classList.remove("hidden");
  }
  menu?.classList.remove("hidden");
}

async function connectWallet(){
  try{
    if (!window.ethereum){ toast("Vui lòng cài MetaMask."); return; }
    await providerWrite.send("eth_requestAccounts", []);
    const ok = await ensureOnViction();
    if (!ok){ toast("Chưa chuyển sang mạng Viction."); return; }

    signer  = providerWrite.getSigner();
    account = (await signer.getAddress()).toLowerCase();
    initWriteContracts(); // muaban/vin (ghi)

    // Hiển thị ví + link explorer
    hide(document.querySelector("#btnConnect"));
    show(document.querySelector("#walletBox"));
    const as = document.querySelector("#accountShort");
    if (as){
      as.textContent = short(account);
      as.href = `${CONFIG.EXPLORER}/address/${account}`;
    }

    // Bảo đảm contract đọc đã sẵn sàng
    if (!muabanR || !vinR) initReadContracts();

    // Số dư + trạng thái đăng ký
    await refreshBalances();
    isRegistered = await muabanR.registered(account);
    refreshMenu();

    // Sau khi kết nối, có thể tải danh sách sản phẩm và đơn (đoạn 3/5 & 5/5 sẽ thêm)
  }catch(e){
    showRpc(e, "connectWallet");
  }
}

function disconnectWallet(){
  account = null; signer = null; muaban = null; vin = null;
  show(document.querySelector("#btnConnect"));
  hide(document.querySelector("#walletBox"));
  document.querySelector("#vinBalance").textContent = "VIN: 0";
  document.querySelector("#vicBalance").textContent = "VIC: 0";
  isRegistered = false;
  refreshMenu();
}

/* ==================== BIND NÚT KẾT NỐI ==================== */
document.querySelector("#btnConnect")?.addEventListener("click", connectWallet);
document.querySelector("#btnDisconnect")?.addEventListener("click", disconnectWallet);

// Tự reload khi đổi tài khoản/chuỗi để tránh lệch trạng thái
if (window.ethereum){
  window.ethereum.on("accountsChanged", ()=>location.reload());
  window.ethereum.on("chainChanged",   ()=>location.reload());
}
/* ==================== TẢI DANH SÁCH SẢN PHẨM ==================== */
async function loadAllProducts(muabanR){
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("ProductCreated");

    const { MUABAN } = getAddresses();
    const logs = await providerRead.getLogs({ address: MUABAN, fromBlock: 0, toBlock: "latest", topics: [topic] });

    // Lọc ID sản phẩm từ event ProductCreated
    const pids = new Set();
    logs.forEach(log => {
      const parsed = iface.parseLog(log);
      pids.add(parsed.args.productId.toString());
    });

    productsCache = [];
    for (const pid of Array.from(pids).sort((a,b) => Number(a)-Number(b))){
      const p = await muabanR.getProduct(pid);
      productsCache.push({ pid: Number(pid), data: p });
    }
    renderProducts(productsCache);
  }catch(e){
    console.error("loadAllProducts:", e);
  }
}

function renderProducts(list){
  const wrap = document.querySelector("#productList");
  if (!wrap) return;

  wrap.innerHTML = "";  // Reset danh sách cũ
  if (list.length === 0){
    wrap.innerHTML = `<div class="tag">Chưa có sản phẩm nào.</div>`;
    return;
  }

  list.forEach(({pid, data}) => {
    const unit = parseUnitFromCID(data.descriptionCID);
    const img = ipfsToHttp(data.imageCID);
    const priceVND = Number(data.priceVND);
    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      <img class="product-thumb" src="${img}" onerror="this.src='https://via.placeholder.com/112x90?text=IPFS'"/>
      <div class="product-info">
        <div class="product-top">
          <h3 class="product-title">${escapeHtml(data.name)}</h3>
          <span class="badge mono">#${pid}</span>
        </div>
        <div class="product-meta">
          <span class="price-vnd">${priceVND.toLocaleString('vi-VN')} VND</span>
          <span class="unit">/ ${escapeHtml(unit||"đv")}</span>
        </div>
        <div>
          <span class="stock-badge ${data.active ? "" : "out"}">${data.active ? "Còn hàng" : "Hết hàng"}</span>
          <span class="tag mono" title="${data.payoutWallet}">Người bán: ${short(data.seller)}</span>
          <span class="tag">Giao tối đa ${data.deliveryDaysMax} ngày</span>
        </div>
        <div class="card-actions">
          ${!account ? "" :
            (data.seller?.toLowerCase() === account?.toLowerCase()
              ? `<button class="btn" data-action="update" data-pid="${pid}">Cập nhật sản phẩm</button>`
              : (isRegistered && data.active ? `<button class="btn primary" data-action="buy" data-pid="${pid}">Mua</button>` : "")
            )
          }
        </div>
      </div>`;
    card.querySelector('[data-action="buy"]')?.addEventListener("click", () => openBuyForm(pid, data));
    card.querySelector('[data-action="update"]')?.addEventListener("click", () => openUpdateForm(pid, data));
    wrap.appendChild(card);
  });
}

/* ==================== TÌM KIẾM SẢN PHẨM ==================== */
document.querySelector("#btnSearch")?.addEventListener("click", () => {
  const query = (document.querySelector("#searchInput")?.value || "").trim().toLowerCase();
  if (!query) { renderProducts(productsCache); return; }
  
  const filteredList = productsCache.filter(({data}) => data.name.toLowerCase().includes(query));
  renderProducts(filteredList);
});

/* ==================== OPEN FORM MUA SẢN PHẨM ==================== */
function openBuyForm(pid, p){
  currentBuying = { pid, product: p };
  document.querySelector("#buyProductInfo").innerHTML = `
    <div class="order-row">
      <span class="order-strong">${escapeHtml(p.name)}</span>
      <span class="badge mono">#${pid}</span>
    </div>
    <div class="order-row">
      Giá: <span class="order-strong">${Number(p.priceVND).toLocaleString('vi-VN')} VND</span>
      · Giao tối đa ${p.deliveryDaysMax} ngày
    </div>`;
  
  document.querySelector("#buyName").value = "";
  document.querySelector("#buyAddress").value = "";
  document.querySelector("#buyPhone").value = "";
  document.querySelector("#buyNote").value = "";
  document.querySelector("#buyQty").value = 1;
  
  recalcBuyTotal(); // tính tổng VIN cần trả
  show(document.querySelector("#formBuy"));
}

function recalcBuyTotal(){
  if (!currentBuying) return;
  const qty = Math.max(1, Number(document.querySelector("#buyQty").value || 1));
  const totalVND = ethers.BigNumber.from(String(currentBuying.product.priceVND)).mul(qty);
  const vinAmt = totalVND.mul(vinPerVNDWei);
  const txt = Number(ethers.utils.formatUnits(vinAmt,18)).toLocaleString("en-US", { maximumFractionDigits: 6 });
  document.querySelector("#buyTotalVIN").textContent = `Tổng VIN cần trả: ${txt} VIN`;
}
/* ==================== CẬP NHẬT SẢN PHẨM ==================== */
function openUpdateForm(pid, p){
  document.querySelector("#updatePid").value = String(pid);
  document.querySelector("#updatePrice").value = String(p.priceVND);
  document.querySelector("#updateDays").value = String(p.deliveryDaysMax);
  document.querySelector("#updateWallet").value = String(p.payoutWallet);
  document.querySelector("#updateActive").checked = !!p.active;
  show(document.querySelector("#formUpdate"));
}

document.querySelector("#btnSubmitUpdate")?.addEventListener("click", async () => {
  try{
    const pid = Number(document.querySelector("#updatePid").value);
    const priceInput = parseVND(document.querySelector("#updatePrice").value);
    const days = parseInt((document.querySelector("#updateDays").value || "").trim(), 10);
    const wallet = (document.querySelector("#updateWallet").value || "").trim();
    const active = !!document.querySelector("#updateActive").checked;

    if (!Number.isFinite(priceInput) || priceInput <= 0){ toast("Giá (VND) phải > 0."); return; }
    if (!Number.isInteger(days) || days <= 0){ toast("Số ngày giao ≥ 1."); return; }
    if (!ethers.utils.isAddress(wallet)){ toast("Ví nhận thanh toán không hợp lệ."); return; }

    const priceVND = ethers.BigNumber.from(String(priceInput));

    try{
      const txData = await muaban.populateTransaction.updateProduct(pid, priceVND, days, wallet, active);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){
      toast(parseRevert(simErr)); return;
    }

    try{
      const ov = await buildOverrides("med");
      const tx = await muaban.updateProduct(pid, priceVND, days, wallet, active, ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.updateProduct"); return; }

    hide(document.querySelector("#formUpdate"));
    toast("Cập nhật thành công.");
    const { muabanR } = initContractsForRead();
    await loadAllProducts(muabanR);
  }catch(e){ showRpc(e, "submitUpdate.catch"); }
});

/* ==================== QUẢN LÝ ĐƠN HÀNG ==================== */
document.querySelector("#btnOrdersBuy")?.addEventListener("click", ()=>{
  show(document.querySelector("#ordersBuySection"));
  hide(document.querySelector("#ordersSellSection"));
  window.scrollTo({ top: document.querySelector("#ordersBuySection").offsetTop - 20, behavior: "smooth" });
});

document.querySelector("#btnOrdersSell")?.addEventListener("click", ()=>{
  show(document.querySelector("#ordersSellSection"));
  hide(document.querySelector("#ordersBuySection"));
  window.scrollTo({ top: document.querySelector("#ordersSellSection").offsetTop - 20, behavior: "smooth" });
});

async function loadMyOrders(muabanR){
  if (!account) return;
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("OrderPlaced");
    const { MUABAN } = getAddresses();
    const logs = await providerRead.getLogs({ address: MUABAN, fromBlock: 0, toBlock: "latest", topics: [topic] });

    ordersBuyer = [];
    ordersSeller = [];

    for (const l of logs){
      const parsed = iface.parseLog(l);
      const orderId = parsed.args.orderId.toNumber();
      const buyer = parsed.args.buyer.toLowerCase();
      const productId = parsed.args.productId.toNumber();

      const o = await muabanR.getOrder(orderId);
      const p = await muabanR.getProduct(productId);
      const isBuyer = (buyer === account?.toLowerCase());
      const isSeller = (p.seller?.toLowerCase() === account?.toLowerCase());

      const item = { order: o, product: p, orderId, productId };
      if (isBuyer) ordersBuyer.push(item);
      if (isSeller) ordersSeller.push(item);
    }
    renderOrders();
  }catch(e){ console.error("loadMyOrders:", e); }
}

function renderOrders(){
  const bWrap = document.querySelector("#ordersBuyList");
  if (bWrap){
    bWrap.innerHTML = "";
    if (!ordersBuyer.length){
      bWrap.innerHTML = `<div class="tag">Chưa có đơn mua.</div>`;
    }else{
      ordersBuyer.sort((a,b) => b.orderId - a.orderId).forEach(({order, product, orderId, productId})=>{
        const canConfirm = Number(order.status) === 1 && order.buyer.toLowerCase() === account.toLowerCase();
        const canRefund = canConfirm && (Number(order.deadline) * 1000 < Date.now());
        const card = document.createElement("div");
        card.className = "order-card";
        card.innerHTML = `
          <div class="order-row"><span class="order-strong">${escapeHtml(product.name)}</span> <span class="badge mono">#${productId}</span></div>
          <div class="order-row">Mã đơn: <span class="order-strong mono">#${orderId}</span> · Số lượng: ${order.quantity} · VIN escrow: ${ethers.utils.formatUnits(order.vinAmount,18)}</div>
          <div class="order-row">Hạn giao: ${new Date(Number(order.deadline) * 1000).toLocaleString("vi-VN")}</div>
          <div class="order-row">Trạng thái: ${statusText(order.status)}</div>
          <div class="card-actions">
            ${canConfirm ? `<button class="btn primary" data-action="confirm" data-oid="${orderId}">Xác nhận đã nhận</button>` : ""}
            ${canRefund ? `<button class="btn" data-action="refund" data-oid="${orderId}">Hoàn tiền (quá hạn)</button>` : ""}
          </div>`;
        card.querySelector('[data-action="confirm"]')?.addEventListener("click", () => confirmReceipt(orderId));
        card.querySelector('[data-action="refund"]')?.addEventListener("click", () => refundExpired(orderId));
        bWrap.appendChild(card);
      });
    }
  }

  const sWrap = document.querySelector("#ordersSellList");
  if (sWrap){
    sWrap.innerHTML = "";
    if (!ordersSeller.length){
      sWrap.innerHTML = `<div class="tag">Chưa có đơn bán.</div>`;
    }else{
      ordersSeller.sort((a,b) => b.orderId - a.orderId).forEach(({order, product, orderId, productId})=>{
        const card = document.createElement("div");
        card.className = "order-card";
        card.innerHTML = `
          <div class="order-row"><span class="order-strong">${escapeHtml(product.name)}</span> <span class="badge mono">#${productId}</span></div>
          <div class="order-row">Mã đơn: <span class="order-strong mono">#${orderId}</span> · Buyer: ${short(order.buyer)}</div>
          <div class="order-row">Số lượng: ${order.quantity} · VIN escrow: ${ethers.utils.formatUnits(order.vinAmount,18)}</div>
          <div class="order-row">Hạn giao: ${new Date(Number(order.deadline) * 1000).toLocaleString("vi-VN")}</div>
          <div class="order-row">Trạng thái: ${statusText(order.status)}</div>`;
        sWrap.appendChild(card);
      });
    }
  }
}
/* ==================== ĐĂNG KÝ VÍ ==================== */
document.querySelector("#btnRegister")?.addEventListener("click", onRegisterClick);

async function onRegisterClick(){
  if (!account){ toast("Hãy kết nối ví trước."); return; }
  try{
    const need = ethers.BigNumber.from(CONFIG.REG_FEE_WEI);
    const { MUABAN } = getAddresses();

    // 1) Approve VIN nếu thiếu
    const allow = await vin.allowance(account, MUABAN);
    if (allow.lt(need)){
      try{
        await sendWithFallback(
          (ov)=> vin.approve(MUABAN, need, ov),
          "light",
          "approve.payRegistration"
        );
      }catch(e){ return; }
    }

    // 2) Preflight payRegistration
    try{
      const txData = await muaban.populateTransaction.payRegistration();
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // 3) Gửi giao dịch
    try{
      await sendWithFallback(
        (ov)=> muaban.payRegistration(ov),
        "med",
        "send.payRegistration"
      );
    }catch(e){ return; }

    isRegistered = true;
    toast("Đăng ký thành công.");
    refreshMenu();
  }catch(e){ showRpc(e, "btnRegister.catch"); }
}

/* ==================== TẠO SẢN PHẨM ==================== */
document.querySelector("#btnCreate")?.addEventListener("click", openCreateForm);
document.querySelector("#btnSubmitCreate")?.addEventListener("click", submitCreate);
document.querySelector('.modal#formCreate .close')?.addEventListener("click", ()=>hide(document.querySelector("#formCreate")));

function openCreateForm(){
  if (!account){ toast("Hãy kết nối ví."); return; }
  if (!isRegistered){ toast("Ví chưa đăng ký. Bấm ‘Đăng ký’ trước."); return; }
  document.querySelector("#createName").value  = "";
  document.querySelector("#createIPFS").value  = "";
  document.querySelector("#createUnit").value  = "";
  document.querySelector("#createPrice").value = "";
  document.querySelector("#createWallet").value= account||"";
  document.querySelector("#createDays").value  = "3";
  show(document.querySelector("#formCreate"));
}

async function submitCreate(){
  try{
    let name   = (document.querySelector("#createName").value||"").trim();
    const ipfs   = (document.querySelector("#createIPFS").value||"").trim();
    const unit   = (document.querySelector("#createUnit").value||"").trim();
    const wallet = (document.querySelector("#createWallet").value||"").trim();
    const days   = parseInt((document.querySelector("#createDays").value||"").trim(),10);
    const priceVNDNum = parseVND(document.querySelector("#createPrice").value);

    if (name.length>500) name = name.slice(0,500);
    if (!name || !ipfs || !unit || !wallet){ toast("Điền đủ thông tin."); return; }
    if (!ethers.utils.isAddress(wallet)){ toast("Ví nhận thanh toán không hợp lệ."); return; }
    if (!Number.isInteger(days)||days<=0){ toast("Số ngày giao ≥ 1."); return; }
    if (!Number.isFinite(priceVNDNum)||priceVNDNum<=0){ toast("Giá (VND) phải > 0."); return; }

    const descriptionCID = `unit:${unit}`;
    const imageCID = ipfs;
    const priceVND = ethers.BigNumber.from(String(priceVNDNum));

    // Preflight
    try{
      const txData = await muaban.populateTransaction.createProduct(
        name, descriptionCID, imageCID, priceVND, days, wallet, true
      );
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // Gửi có fallback
    try{
      await sendWithFallback(
        (ov)=> muaban.createProduct(name, descriptionCID, imageCID, priceVND, days, wallet, true, ov),
        "heavy",
        "send.createProduct"
      );
    }catch(e){ return; }

    hide(document.querySelector("#formCreate"));
    toast("Đăng sản phẩm thành công.");
    const { muabanR } = initContractsForRead();
    await loadAllProducts(muabanR);
  }catch(e){ showRpc(e, "submitCreate.catch"); }
}

/* ==================== MUA HÀNG ==================== */
document.querySelector("#btnSubmitBuy")?.addEventListener("click", submitBuy);
document.querySelector('.modal#formBuy .close')?.addEventListener("click", ()=>hide(document.querySelector("#formBuy")));
document.querySelector("#buyQty")?.addEventListener("input", recalcBuyTotal);

async function submitBuy(){
  if (!account){ toast("Hãy kết nối ví."); return; }
  if (!isRegistered){ toast("Ví chưa đăng ký. Bấm ‘Đăng ký’."); return; }
  if (!window.currentBuying){ toast("Thiếu thông tin sản phẩm."); return; }
  try{
    const qty = Math.max(1, Number(document.querySelector("#buyQty").value||1));
    const info = {
      name:  (document.querySelector("#buyName").value||"").trim(),
      addr:  (document.querySelector("#buyAddress").value||"").trim(),
      phone: (document.querySelector("#buyPhone").value||"").trim(),
      note:  (document.querySelector("#buyNote").value||"").trim(),
    };
    if (!info.name || !info.addr || !info.phone){ toast("Nhập đủ họ tên, địa chỉ, SĐT."); return; }
    if (vinPerVNDWei.isZero()){ toast("Tỷ giá VIN/VND chưa sẵn sàng."); return; }

    const pid = window.currentBuying.pid;
    const priceVND = ethers.BigNumber.from(String(window.currentBuying.product.priceVND));
    const totalVND = priceVND.mul(qty);
    const vinAmount = totalVND.mul(vinPerVNDWei);

    const { MUABAN } = getAddresses();

    // 1) Approve VIN nếu thiếu
    const allow = await vin.allowance(account, MUABAN);
    if (allow.lt(vinAmount)){
      try{
        await sendWithFallback(
          (ov)=> vin.approve(MUABAN, vinAmount, ov),
          "light",
          "approve.placeOrder"
        );
      }catch(e){ return; }
    }

    // 2) Encode info (base64)
    const cipher = btoa(unescape(encodeURIComponent(JSON.stringify(info))));

    // 3) Preflight placeOrder
    try{
      const txData = await muaban.populateTransaction.placeOrder(pid, qty, vinPerVNDWei, cipher);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // 4) Gửi có fallback
    try{
      await sendWithFallback(
        (ov)=> muaban.placeOrder(pid, qty, vinPerVNDWei, cipher, ov),
        "med",
        "send.placeOrder"
      );
    }catch(e){ return; }

    hide(document.querySelector("#formBuy"));
    toast("Đặt mua thành công.");
    const { muabanR } = initContractsForRead();
    await loadMyOrders(muabanR);
  }catch(e){ showRpc(e, "submitBuy.catch"); }
}

/* ==================== XÁC NHẬN & HOÀN TIỀN ==================== */
async function confirmReceipt(orderId){
  try{
    // Preflight
    try{
      const txData = await muaban.populateTransaction.confirmReceipt(orderId);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // Send
    try{
      await sendWithFallback(
        (ov)=> muaban.confirmReceipt(orderId, ov),
        "light",
        "send.confirmReceipt"
      );
    }catch(e){ return; }

    toast("Đã xác nhận nhận hàng. VIN đã giải ngân cho người bán.");
    const { muabanR } = initContractsForRead();
    await loadMyOrders(muabanR);
  }catch(e){ showRpc(e, "confirmReceipt.catch"); }
}

async function refundExpired(orderId){
  try{
    // Preflight
    try{
      const txData = await muaban.populateTransaction.refundIfExpired(orderId);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // Send
    try{
      await sendWithFallback(
        (ov)=> muaban.refundIfExpired(orderId, ov),
        "light",
        "send.refundIfExpired"
      );
    }catch(e){ return; }

    toast("Đã hoàn tiền về ví (đơn quá hạn).");
    const { muabanR } = initContractsForRead();
    await loadMyOrders(muabanR);
  }catch(e){ showRpc(e, "refundExpired.catch"); }
}

/* ==================== KHỞI ĐỘNG CHÍNH ==================== */
(async function main(){
  try{
    await loadAbis();
    initProviders();
    initReadContracts();

    // tỷ giá ban đầu + auto refresh mỗi 60s
    await fetchVinToVND();
    setInterval(fetchVinToVND, 60_000);

    // load danh sách sản phẩm (không cần ví)
    await loadAllProducts(muabanR);

    // Cho phép click ra ngoài modal để đóng
    document.querySelectorAll(".modal").forEach(m=>{
      m.addEventListener("click", (e)=>{ if (e.target.classList.contains("modal")) hide(m); });
    });
  }catch(e){
    showRpc(e, "main");
  }
})();

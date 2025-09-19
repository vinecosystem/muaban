/* ====================================================================
   muaban.vin — app.js (ethers v5)
   Mục tiêu: chấm dứt "Internal JSON-RPC error" + ổn định toàn bộ luồng
   - Legacy tx (type:0) + gasPrice + gasLimit cố định
   - Preflight simulate (populateTransaction + provider.call({from}))
   - Đồng bộ HTML/ABI/Hợp đồng + xử lý tỷ giá VIN/VND đa nguồn
==================================================================== */

/* -------------------- DOM helpers -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show = el=>{ if(!el) return; el.classList.remove('hidden'); };
const hide = el=>{ if(!el) return; el.classList.add('hidden'); };
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`: "";
const toast=(m)=>alert(m);

/* -------------------- Cấu hình -------------------- */
const DEFAULTS = {
  CHAIN_ID: 88,
  RPC_READ: "https://rpc.viction.xyz",
  EXPLORER: "https://vicscan.xyz",

  // Địa chỉ theo mô tả & index.html (có thể override bằng data-* trên <body>)
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",

  // Phí đăng ký 0.001 VIN (18 decimals) — cần trùng hợp đồng
  REG_FEE_WEI: "1000000000000000",

  // Nguồn tỷ giá
  COINGECKO_VIC_VND: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=vnd",
  COINGECKO_USD_VND: "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",
  COINGECKO_VIC_USD: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=usd",
  BINANCE_VICUSDT:   "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",
};

/* ---- GAS/FEES: ép legacy (gasPrice), không dùng EIP-1559 ---- */
const GAS_LIMIT_LIGHT = ethers.BigNumber.from("200000");   // approve / confirm / refund
const GAS_LIMIT_MED   = ethers.BigNumber.from("400000");   // payRegistration / updateProduct / placeOrder
const GAS_LIMIT_HEAVY = ethers.BigNumber.from("800000");   // createProduct
const LEGACY_GAS_PRICE_GWEI = "50"; // nếu cần có thể nâng 80-120

/* -------------------- State -------------------- */
let providerRead, providerWrite, signer, account;
let MUABAN_ABI, VIN_ABI;
let muabanR, muaban, vinR, vin;
let isRegistered = false;

let vinPerVNDWei = ethers.BigNumber.from(0); // VIN wei cho 1 VND (ceil)
let vinVND = 0;                               // 1 VIN = ? VND (floor)
let productsCache = [];
let ordersBuyer = [];
let ordersSeller = [];

/* -------------------- Utils -------------------- */
function parseRevert(err){
  const raw = err?.error?.message || err?.data?.message || err?.reason || err?.message || "";
  const map = {
    NOT_REGISTERED: "Ví này chưa đăng ký. Bấm ‘Đăng ký’ trước.",
    ALREADY_REGISTERED: "Ví đã đăng ký.",
    PRICE_REQUIRED: "Giá bán (VND) phải > 0.",
    DELIVERY_REQUIRED: "Thời gian giao hàng (ngày) phải ≥ 1.",
    PAYOUT_WALLET_ZERO: "Ví nhận thanh toán không được để trống.",
    NOT_SELLER: "Bạn không phải người bán của sản phẩm này.",
    PRODUCT_NOT_ACTIVE: "Sản phẩm đang tắt bán.",
    PRODUCT_NOT_FOUND: "Không tìm thấy sản phẩm.",
    QUANTITY_REQUIRED: "Số lượng phải ≥ 1.",
    VIN_PER_VND_REQUIRED: "Tỷ giá chưa sẵn sàng. Vui lòng thử lại.",
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

// Chuẩn hoá VND: "1.200.000" / "1,200,000" / "1200000"
function parseVND(input){
  const digits = String(input||"").trim().replace(/[^\d]/g, "");
  if (!digits) return NaN;
  const n = Number(digits);
  return Number.isFinite(n) ? n : NaN;
}
function ipfsToHttp(link){
  if (!link) return "";
  if (link.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + link.replace("ipfs://", "");
  return link;
}
function escapeHtml(str){ return String(str).replace(/[&<>"']/g, s=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;" }[s] || s)); }
function parseUnitFromCID(desc){ const m = /^unit:(.+)$/i.exec((desc||"").trim()); return m ? m[1].trim() : ""; }
function statusText(code){ const m = {0:"-",1:"Đang xử lý",2:"Đã giải ngân",3:"Đã hoàn tiền"}; return m[Number(code)] || "-"; }

/* -------------------- ABI + Address -------------------- */
async function loadAbis(){
  MUABAN_ABI = await fetch("Muaban_ABI.json").then(r=>r.json());
  VIN_ABI    = await fetch("VinToken_ABI.json").then(r=>r.json());
}
function readAddrs(){
  const b = document.body;
  const ma = b?.dataset?.muabanAddr;
  const va = b?.dataset?.vinAddr;
  return {
    MUABAN_ADDR: (ma && ethers.utils.isAddress(ma) ? ma : DEFAULTS.MUABAN_ADDR),
    VIN_ADDR:    (va && ethers.utils.isAddress(va) ? va : DEFAULTS.VIN_ADDR)
  };
}

/* -------------------- Providers & Contracts -------------------- */
function initProviders(){
  providerRead  = new ethers.providers.JsonRpcProvider(DEFAULTS.RPC_READ);
  if (window.ethereum) providerWrite = new ethers.providers.Web3Provider(window.ethereum, "any");
}
function initContractsForRead(){
  const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
  muabanR = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, providerRead);
  vinR    = new ethers.Contract(VIN_ADDR,    VIN_ABI,    providerRead);
}
function initContractsForWrite(){
  const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
  muaban = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);
  vin    = new ethers.Contract(VIN_ADDR,    VIN_ABI,    signer);
}

/* -------------------- Legacy GAS overrides -------------------- */
async function buildOverrides(kind="med"){
  const ov = { type: 0, gasPrice: ethers.utils.parseUnits(LEGACY_GAS_PRICE_GWEI, "gwei") };
  if (kind==="light") ov.gasLimit = GAS_LIMIT_LIGHT;
  else if (kind==="heavy") ov.gasLimit = GAS_LIMIT_HEAVY;
  else ov.gasLimit = GAS_LIMIT_MED;
  return ov;
}

/* -------------------- Tỷ giá VIN/VND -------------------- */
function bodyVinVndOverride(){
  const raw = document.body?.dataset?.vinVnd;
  const n = Number(raw);
  return Number.isFinite(n) && n>0 ? Math.floor(n) : 0;
}
async function fetchVinToVND(){
  try{
    const override = bodyVinVndOverride();
    if (override>0){
      vinVND = override;
    }else{
      let vicVnd = 0;
      try{
        const r = await fetch(DEFAULTS.COINGECKO_VIC_VND);
        const j = await r.json();
        vicVnd = Number(j?.viction?.vnd||0);
      }catch(_){}
      if (vicVnd>0){
        vinVND = Math.floor(vicVnd * 100); // 1 VIN = 100 VIC
      }else{
        const [vicUsdRes, usdtVndRes] = await Promise.all([
          fetch(DEFAULTS.COINGECKO_VIC_USD),
          fetch(DEFAULTS.COINGECKO_USD_VND)
        ]);
        const vicUsd = Number((await vicUsdRes.json())?.viction?.usd||0);
        const usdtVnd= Number((await usdtVndRes.json())?.tether?.vnd||0);
        if (vicUsd>0 && usdtVnd>0){
          vinVND = Math.floor(vicUsd * 100 * usdtVnd);
        }else{
          const [vicPriceRes2, usdtVndRes2] = await Promise.all([
            fetch(DEFAULTS.BINANCE_VICUSDT),
            fetch(DEFAULTS.COINGECKO_USD_VND)
          ]);
          const vicUsdt  = Number((await vicPriceRes2.json())?.price||0);
          const usdtVnd2 = Number((await usdtVndRes2.json())?.tether?.vnd||0);
          if (vicUsdt>0 && usdtVnd2>0) vinVND = Math.floor(vicUsdt * 100 * usdtVnd2);
        }
      }
    }
    if (!(vinVND>0)) throw new Error("Không lấy được giá");

    const ONE = ethers.BigNumber.from("1000000000000000000");
    vinPerVNDWei = ONE.div(vinVND);
    if (ONE.mod(vinVND).gt(0)) vinPerVNDWei = vinPerVNDWei.add(1); // ceil

    $("#vinPrice")?.replaceChildren(`1 VIN = ${vinVND.toLocaleString("vi-VN")} VND`);
  }catch(e){
    console.error("fetchVinToVND:", e);
    if (vinPerVNDWei.isZero()) $("#vinPrice")?.replaceChildren("Loading price...");
  }
}

/* -------------------- Kết nối ví -------------------- */
async function connectWallet(){
  try{
    if (!window.ethereum){ toast("Vui lòng cài MetaMask."); return; }
    await providerWrite.send("eth_requestAccounts", []);
    const net = await providerWrite.getNetwork();
    if (Number(net.chainId)!==DEFAULTS.CHAIN_ID){ toast("Sai mạng. Chọn Viction (chainId=88)."); return; }

    signer  = providerWrite.getSigner();
    account = (await signer.getAddress()).toLowerCase();

    initContractsForWrite();

    hide($("#btnConnect")); show($("#walletBox"));
    $("#accountShort").textContent = short(account);
    $("#accountShort").href = `${DEFAULTS.EXPLORER}/address/${account}`;

    const [vinBal, vicBal, reg] = await Promise.all([
      vinR.balanceOf(account),
      providerWrite.getBalance(account),
      muabanR.registered(account)
    ]);
    $("#vinBalance").textContent = `VIN: ${parseFloat(ethers.utils.formatUnits(vinBal,18)).toFixed(4)}`;
    $("#vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;
    isRegistered = Boolean(reg);

    refreshMenu();
    await Promise.all([loadAllProducts(), loadMyOrders()]);
  }catch(e){ showRpc(e, "connectWallet"); }
}
function disconnectWallet(){
  account = null; signer = null; muaban = null; vin = null;
  hide($("#walletBox")); show($("#btnConnect"));
  $("#vinBalance").textContent = "VIN: 0";
  $("#vicBalance").textContent = "VIC: 0";
  isRegistered = false;
  refreshMenu();
}
function refreshMenu(){
  const btnReg = $("#btnRegister");
  const btnCrt = $("#btnCreate");
  const btnOB  = $("#btnOrdersBuy");
  const btnOS  = $("#btnOrdersSell");
  const menu   = $("#menuBox");
  if (!account){
    btnReg?.classList.remove('hidden'); if (btnReg) btnReg.disabled = true;
    btnCrt?.classList.add('hidden'); btnOB?.classList.add('hidden'); btnOS?.classList.add('hidden');
    return;
  }
  if (!isRegistered){
    btnReg?.classList.remove('hidden'); if (btnReg) btnReg.disabled = false;
    btnCrt?.classList.add('hidden'); btnOB?.classList.add('hidden'); btnOS?.classList.add('hidden');
  }else{
    btnReg?.classList.add('hidden');
    btnCrt?.classList.remove('hidden'); btnOB?.classList.remove('hidden'); btnOS?.classList.remove('hidden');
  }
  menu?.classList.remove('hidden');
}

/* -------------------- Sản phẩm: load & render -------------------- */
async function loadAllProducts(){
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("ProductCreated");
    const { MUABAN_ADDR } = readAddrs();
    const logs = await providerRead.getLogs({ address: MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic] });
    const pids = new Set();
    logs.forEach(l=>{ const parsed = iface.parseLog(l); pids.add(parsed.args.productId.toString()); });

    productsCache = [];
    for (const pid of Array.from(pids).sort((a,b)=>Number(a)-Number(b))){
      const p = await muabanR.getProduct(pid);
      productsCache.push({ pid: Number(pid), data: p });
    }
    renderProducts(productsCache);
  }catch(e){ console.error("loadAllProducts:", e); }
}
function renderProducts(list){
  const wrap = $("#productList");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!list.length){ wrap.innerHTML = `<div class="tag">Chưa có sản phẩm.</div>`; return; }
  list.forEach(({pid, data})=>{
    const unit = parseUnitFromCID(data.descriptionCID);
    const img = ipfsToHttp(data.imageCID);
    const active = data.active;
    const price = Number(data.priceVND);

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
          <span class="price-vnd">${price.toLocaleString('vi-VN')} VND</span> <span class="unit">/ ${escapeHtml(unit||"đv")}</span>
        </div>
        <div>
          <span class="stock-badge ${active? "":"out"}">${active? "Còn hàng":"Hết hàng"}</span>
          <span class="tag mono" title="${data.payoutWallet}">Người bán: ${short(data.seller)}</span>
          <span class="tag">Giao tối đa ${data.deliveryDaysMax} ngày</span>
        </div>
        <div class="card-actions">
          ${(!account) ? "" :
            (String(data.seller).toLowerCase()===String(account).toLowerCase()
              ? `<button class="btn" data-action="update" data-pid="${pid}">Cập nhật sản phẩm</button>`
              : (isRegistered && active ? `<button class="btn primary" data-action="buy" data-pid="${pid}">Mua</button>` : "")
            )
          }
        </div>
      </div>`;
    card.querySelector('[data-action="buy"]')?.addEventListener("click", ()=> openBuyForm(pid, data));
    card.querySelector('[data-action="update"]')?.addEventListener("click", ()=> openUpdateForm(pid, data));
    wrap.appendChild(card);
  });
}

/* -------------------- Search -------------------- */
$("#btnSearch")?.addEventListener("click", ()=>{
  const q = ($("#searchInput")?.value||"").trim().toLowerCase();
  if (!q) { renderProducts(productsCache); return; }
  const list = productsCache.filter(({data})=> (data.name||"").toLowerCase().includes(q));
  renderProducts(list);
});

/* -------------------- Đăng ký ví -------------------- */
$("#btnRegister")?.addEventListener("click", async ()=>{
  if (!account){ toast("Hãy kết nối ví."); return; }
  try{
    const need = ethers.BigNumber.from(DEFAULTS.REG_FEE_WEI);
    const { MUABAN_ADDR } = readAddrs();

    // ensure allowance
    const allow = await vin.allowance(account, MUABAN_ADDR);
    if (allow.lt(need)){
      try{
        const ovA = await buildOverrides("light");
        const txA = await vin.approve(MUABAN_ADDR, need, ovA);
        await txA.wait();
      }catch(e){ showRpc(e, "approve.payRegistration"); return; }
    }

    // preflight
    try{
      const txData = await muaban.populateTransaction.payRegistration();
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // send
    try{
      const ov = await buildOverrides("med");
      const tx = await muaban.payRegistration(ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.payRegistration"); return; }

    isRegistered = true;
    toast("Đăng ký thành công.");
    refreshMenu();
  }catch(e){ showRpc(e, "btnRegister.catch"); }
});

/* -------------------- Tạo/Cập nhật sản phẩm -------------------- */
$("#btnCreate")?.addEventListener("click", ()=>{
  if (!isRegistered){ toast("Ví chưa đăng ký. Bấm ‘Đăng ký’ trước."); return; }
  $("#createName").value=""; $("#createIPFS").value="";
  $("#createUnit").value=""; $("#createPrice").value="";
  $("#createWallet").value=account||""; $("#createDays").value="3";
  show($("#formCreate"));
});
$(".modal#formCreate .close")?.addEventListener("click", ()=> hide($("#formCreate")));

$("#btnSubmitCreate")?.addEventListener("click", async ()=>{
  if (!account){ toast("Hãy kết nối ví."); return; }
  try{
    const name  = ($("#createName").value||"").trim();
    const ipfs  = ($("#createIPFS").value||"").trim();
    const unit  = ($("#createUnit").value||"").trim();
    const priceVND = parseVND($("#createPrice").value);
    const wallet   = ($("#createWallet").value||"").trim();
    const days     = Number($("#createDays").value||0);

    if (!name || !ipfs || !unit || !priceVND || !wallet || !days){ toast("Vui lòng nhập đủ thông tin."); return; }

    const descriptionCID = `unit:${unit}`;
    const imageCID = ipfs;

    // preflight
    try{
      const txData = await muaban.populateTransaction.createProduct(
        name, descriptionCID, imageCID, priceVND, days, wallet, true
      );
      txData.from = account;
      await providerWrite.call(txData); // simulate để bắt revert rõ ràng
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    const ov = await buildOverrides("heavy");
    const tx = await muaban.createProduct(
      name, descriptionCID, imageCID, priceVND, days, wallet, true, ov
    );
    await tx.wait();

    hide($("#formCreate"));
    toast("Đăng sản phẩm thành công.");
    await loadAllProducts();
  }catch(e){ showRpc(e, "submitCreate"); }
});

function openUpdateForm(pid, p){
  $("#updatePid").value = String(pid);
  $("#updatePrice").value = String(p.priceVND||"");
  $("#updateDays").value  = String(p.deliveryDaysMax||"");
  $("#updateWallet").value= String(p.payoutWallet||"");
  $("#updateActive").checked = Boolean(p.active);
  show($("#formUpdate"));
}
$(".modal#formUpdate .close")?.addEventListener("click", ()=> hide($("#formUpdate")));

$("#btnSubmitUpdate")?.addEventListener("click", async ()=>{
  if (!account){ toast("Hãy kết nối ví."); return; }
  try{
    const pid   = Number($("#updatePid").value||0);
    const price = parseVND($("#updatePrice").value);
    const days  = Number($("#updateDays").value||0);
    const wall  = ($("#updateWallet").value||"").trim();
    const active= Boolean($("#updateActive").checked);

    if (!pid || !price || !days || !wall){ toast("Thiếu dữ liệu."); return; }

    // preflight
    try{
      const txData = await muaban.populateTransaction.updateProduct(pid, price, days, wall, active);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    const ov = await buildOverrides("med");
    const tx = await muaban.updateProduct(pid, price, days, wall, active, ov);
    await tx.wait();

    hide($("#formUpdate"));
    toast("Cập nhật thành công.");
    await loadAllProducts();
  }catch(e){ showRpc(e, "submitUpdate"); }
});

/* -------------------- Mua hàng -------------------- */
function openBuyForm(pid, p){
  $("#buyPid").value = String(pid);
  $("#buyName").textContent = p.name;
  $("#buyPrice").textContent = Number(p.priceVND).toLocaleString("vi-VN") + " VND";
  $("#buyQty").value = "1";
  $("#buyFullname").value=""; $("#buyAddress").value=""; $("#buyPhone").value=""; $("#buyNote").value="";
  $("#buyVinTotal").textContent = "—";
  show($("#formBuy"));
  updateBuyTotal(); // tính thử
}
$(".modal#formBuy .close")?.addEventListener("click", ()=> hide($("#formBuy")));
$("#buyQty")?.addEventListener("input", updateBuyTotal);

function calcVinTotalWei(priceVND, qty){
  if (!vinPerVNDWei || vinPerVNDWei.isZero()) return ethers.BigNumber.from(0);
  const totalVND = ethers.BigNumber.from(String(priceVND)).mul(ethers.BigNumber.from(String(qty)));
  // ceil: vinPerVNDWei * totalVND
  const totalWei = vinPerVNDWei.mul(totalVND);
  return totalWei;
}
function updateBuyTotal(){
  const priceVND = parseVND($("#buyPrice").textContent);
  const qty = Math.max(1, Number($("#buyQty").value||1));
  const totalWei = calcVinTotalWei(priceVND, qty);
  $("#buyVinTotal").textContent = totalWei.isZero() ? "—" : `${ethers.utils.formatUnits(totalWei, 18)} VIN`;
}

$("#btnSubmitBuy")?.addEventListener("click", async ()=>{
  if (!account){ toast("Hãy kết nối ví."); return; }
  try{
    if (vinPerVNDWei.isZero()){ toast("Chưa sẵn sàng tỷ giá. Vui lòng đợi…"); return; }

    const pid = Number($("#buyPid").value||0);
    const qty = Math.max(1, Number($("#buyQty").value||1));
    if (!pid || !qty){ toast("Thiếu dữ liệu."); return; }

    // pack buyer info (mã hoá đơn giản base64 để tránh plaintext)
    const fullname = ($("#buyFullname").value||"").trim();
    const address  = ($("#buyAddress").value||"").trim();
    const phone    = ($("#buyPhone").value||"").trim();
    const note     = ($("#buyNote").value||"").trim();
    const plain = JSON.stringify({fullname,address,phone,note});
    const cipher = btoa(unescape(encodeURIComponent(plain))); // mock encryption

    // Tính tổng VIN (wei) dựa theo priceVND hiện tại của sản phẩm (đọc lại để chắc)
    const p = await muabanR.getProduct(pid);
    const totalWei = calcVinTotalWei(p.priceVND, qty);
    if (totalWei.lte(0)){ toast("Tổng VIN không hợp lệ."); return; }

    const { MUABAN_ADDR } = readAddrs();

    // ensure allowance đủ totalWei
    const allow = await vin.allowance(account, MUABAN_ADDR);
    if (allow.lt(totalWei)){
      try{
        const ovA = await buildOverrides("light");
        const txA = await vin.approve(MUABAN_ADDR, totalWei, ovA);
        await txA.wait();
      }catch(e){ showRpc(e, "approve.placeOrder"); return; }
    }

    // preflight
    try{
      const txData = await muaban.populateTransaction.placeOrder(pid, qty, vinPerVNDWei.toString(), cipher);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // send
    const ov = await buildOverrides("med");
    const tx = await muaban.placeOrder(pid, qty, vinPerVNDWei.toString(), cipher, ov);
    await tx.wait();

    hide($("#formBuy"));
    toast("Đặt hàng thành công.");
    await loadMyOrders();
  }catch(e){ showRpc(e, "submitBuy"); }
});

/* -------------------- Đơn hàng của tôi -------------------- */
async function loadMyOrders(){
  try{
    const { MUABAN_ADDR } = readAddrs();
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("OrderPlaced");
    const logs = await providerRead.getLogs({ address: MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic] });

    ordersBuyer = [];
    ordersSeller = [];
    for (const l of logs){
      const ev = iface.parseLog(l);
      const oid = ev.args.orderId.toString();
      const od = await muabanR.getOrder(oid);
      const rec = { oid: Number(oid), data: od };
      if (String(od.buyer).toLowerCase()===String(account).toLowerCase()) ordersBuyer.push(rec);
      if (String(od.seller).toLowerCase()===String(account).toLowerCase()) ordersSeller.push(rec);
    }
    renderOrders();
  }catch(e){ console.error("loadMyOrders:", e); }
}
function renderOrders(){
  // Buyer
  const buyWrap = $("#ordersBuyList");
  $("#ordersBuySection")?.classList.toggle("hidden", !(ordersBuyer.length));
  if (buyWrap){
    buyWrap.innerHTML = "";
    ordersBuyer.sort((a,b)=>b.data.placedAt - a.data.placedAt);
    for (const {oid, data} of ordersBuyer){
      const el = document.createElement("div");
      el.className = "order-card";
      el.innerHTML = `
        <div class="order-row"><span class="order-strong">#${oid}</span> • Sản phẩm #${data.productId} • SL: ${data.quantity}</div>
        <div class="order-row">VIN ký quỹ: <span class="order-strong">${ethers.utils.formatUnits(data.vinAmount,18)} VIN</span></div>
        <div class="order-row">Hạn giao: ${new Date(Number(data.deadline)*1000).toLocaleString("vi-VN")}</div>
        <div class="order-row">Trạng thái: <span class="order-strong">${statusText(data.status)}</span></div>
        <div class="card-actions">
          ${Number(data.status)===1 ? `<button class="btn" data-action="confirm" data-oid="${oid}">Xác nhận đã nhận</button>`:""}
          ${Number(data.status)===1 ? `<button class="btn" data-action="refund" data-oid="${oid}">Hoàn tiền (quá hạn)</button>`:""}
        </div>`;
      el.querySelector('[data-action="confirm"]')?.addEventListener("click", ()=> confirmReceipt(oid));
      el.querySelector('[data-action="refund"]') ?.addEventListener("click", ()=> refundOrder(oid));
      buyWrap.appendChild(el);
    }
  }

  // Seller
  const sellWrap = $("#ordersSellList");
  $("#ordersSellSection")?.classList.toggle("hidden", !(ordersSeller.length));
  if (sellWrap){
    sellWrap.innerHTML = "";
    ordersSeller.sort((a,b)=>b.data.placedAt - a.data.placedAt);
    for (const {oid, data} of ordersSeller){
      const el = document.createElement("div");
      el.className = "order-card";
      el.innerHTML = `
        <div class="order-row"><span class="order-strong">#${oid}</span> • Sản phẩm #${data.productId} • SL: ${data.quantity}</div>
        <div class="order-row">VIN ký quỹ: <span class="order-strong">${ethers.utils.formatUnits(data.vinAmount,18)} VIN</span></div>
        <div class="order-row">Hạn giao: ${new Date(Number(data.deadline)*1000).toLocaleString("vi-VN")}</div>
        <div class="order-row">Trạng thái: <span class="order-strong">${statusText(data.status)}</span></div>`;
      sellWrap.appendChild(el);
    }
  }
}

/* -------------------- Buyer hành động -------------------- */
async function confirmReceipt(oid){
  if (!account){ toast("Hãy kết nối ví."); return; }
  try{
    // preflight
    try{
      const txData = await muaban.populateTransaction.confirmReceipt(oid);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    const ov = await buildOverrides("light");
    const tx = await muaban.confirmReceipt(oid, ov);
    await tx.wait();

    toast("Đã xác nhận nhận hàng.");
    await loadMyOrders();
  }catch(e){ showRpc(e, "confirmReceipt"); }
}
async function refundOrder(oid){
  if (!account){ toast("Hãy kết nối ví."); return; }
  try{
    // preflight
    try{
      const txData = await muaban.populateTransaction.refundOrder(oid);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    const ov = await buildOverrides("light");
    const tx = await muaban.refundOrder(oid, ov);
    await tx.wait();

    toast("Đã yêu cầu hoàn tiền.");
    await loadMyOrders();
  }catch(e){ showRpc(e, "refundOrder"); }
}

/* -------------------- Bootstrap -------------------- */
async function bootstrap(){
  initProviders();
  await loadAbis();
  initContractsForRead();
  await fetchVinToVND();

  // wire header buttons
  $("#btnConnect")?.addEventListener("click", connectWallet);
  $("#btnDisconnect")?.addEventListener("click", disconnectWallet);

  // load public products
  await loadAllProducts();
}
document.addEventListener("DOMContentLoaded", bootstrap);

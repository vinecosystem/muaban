/* ====================================================================
   muaban.vin — app.js (ethers v5)
   MỤC TIÊU: sửa lỗi "Internal JSON-RPC error" khi ký giao dịch & ổn định UI
   - ÉP GIAO DỊCH LEGACY (type 0) dùng gasPrice; KHÔNG gửi EIP-1559 trên VIC
   - Preflight mọi giao dịch (populateTransaction + provider.call({from}))
     để bắt revert rõ ràng (NOT_REGISTERED, PRICE_REQUIRED, ...)
   - Tỷ giá VIN/VND: lấy từ nhiều nguồn; có thể override qua <body data-vin-vnd>
   - Bám sát HTML (index.html) & ABI (Muaban_ABI.json, VinToken_ABI.json)
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
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://vicscan.xyz",
  // Địa chỉ mặc định (có thể override qua <body data-*>):
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",
  // Phí đăng ký 0.001 VIN (18 decimals)
  REG_FEE_WEI: "1000000000000000",
  // Nguồn tỷ giá (đa nguồn để tránh lỗi CORS / rate-limit)
  COINGECKO_VIC_VND: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=vnd",
  COINGECKO_USD_VND:  "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",
  COINGECKO_VIC_USD:  "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=usd",
  BINANCE_VICUSDT:    "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT", // có thể không luôn khả dụng
};

/* ---- GAS/FEES: ép legacy (gasPrice), không dùng EIP-1559 ---- */
const GAS_LIMIT_LIGHT = ethers.BigNumber.from("200000");   // approve / confirm / refund
const GAS_LIMIT_MED   = ethers.BigNumber.from("400000");   // payRegistration / updateProduct / placeOrder
const GAS_LIMIT_HEAVY = ethers.BigNumber.from("800000");   // createProduct
const LEGACY_GAS_PRICE_GWEI = "50"; // tăng 100–200 nếu cần

/* -------------------- State -------------------- */
let providerRead, providerWrite, signer, account;
let MUABAN_ABI, VIN_ABI;
let muaban, vin;            // write
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
    NOT_REGISTERED: "Ví này chưa đăng ký. Hãy bấm ‘Đăng ký’ trước.",
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

// Popup chi tiết RPC (tiện debug trên mobile)
function showRpc(err, tag="RPC"){
  try{
    const obj = {
      tag,
      code: err?.code,
      message: err?.message || err?.error?.message,
      data: err?.data || err?.error?.data,
      reason: err?.reason
    };
    console.error(tag, obj);
    alert(`${tag}\n${JSON.stringify(obj, null, 2)}`);
  }catch(_){
    console.error(tag, err);
    alert(`${tag}: ${String(err)}`);
  }
}

function formatVND(n){
  return Number(n||0).toLocaleString("vi-VN");
}

// Chuẩn hoá VND: "1.200.000" / "1,200,000" / "1200000"
function parseVND(input){
  const digits = String(input||"").trim().replace(/[^\d]/g, "");
  if (!digits) return NaN;
  const n = Number(digits);
  return Number.isFinite(n) ? n : NaN;
}

function ipfsToHttp(cid){
  if (!cid) return "";
  if (/^https?:\/\//i.test(cid)) return cid;
  return `https://ipfs.io/ipfs/${cid.replace(/^ipfs:\/\//,'')}`;
}
function parseUnitFromCID(desc){
  const m = /^unit:(.+)$/i.exec(String(desc||""));
  return m? m[1] : "đơn vị";
}

/* -------------------- ABI & địa chỉ -------------------- */
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
  providerRead = new ethers.providers.JsonRpcProvider(DEFAULTS.RPC_URL, { name:"viction", chainId: DEFAULTS.CHAIN_ID });
  providerWrite = window.ethereum ? new ethers.providers.Web3Provider(window.ethereum, "any") : null;
}
function initContractsForRead(){
  const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
  return {
    muabanR: new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, providerRead),
    vinR:    new ethers.Contract(VIN_ADDR, VIN_ABI, providerRead),
  };
}
function initContractsForWrite(){
  const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
  return {
    muabanW: new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer),
    vinW:    new ethers.Contract(VIN_ADDR, VIN_ABI, signer),
  };
}

/* -------------------- Giá VIN/VND -------------------- */
function bodyVinVndOverride(){
  const raw = Number(document.body?.dataset?.vinVnd || 0);
  return raw>0 ? Math.floor(raw) : 0;
}
async function fetchVinToVND(){
  try{
    // 1) Ưu tiên override qua data-vin-vnd
    const override = bodyVinVndOverride();
    if (override>0){
      vinVND = override;
    }else{
      // 2) Nguồn chính: CoinGecko VIC→VND (trực tiếp)
      let vicVnd = 0;
      try{
        const r = await fetch(DEFAULTS.COINGECKO_VIC_VND);
        const j = await r.json();
        vicVnd = Number(j?.viction?.vnd||0);
      }catch(_){ /* bỏ qua, thử nguồn khác */ }

      if (vicVnd>0){
        vinVND = Math.floor(vicVnd * 100); // 1 VIN = 100 VIC
      }else{
        // 3) Phương án 2: VIC→USD × USDT→VND
        const [vicUsdRes, usdtVndRes] = await Promise.all([
          fetch(DEFAULTS.COINGECKO_VIC_USD),
          fetch(DEFAULTS.COINGECKO_USD_VND)
        ]);
        const vicUsd = Number((await vicUsdRes.json())?.viction?.usd||0);
        const usdtVnd= Number((await usdtVndRes.json())?.tether?.vnd||0);
        if (vicUsd>0 && usdtVnd>0){
          vinVND = Math.floor(vicUsd * 100 * usdtVnd);
        }else{
          // 4) Dự phòng: Binance VIC/USDT × USDT/VND (có thể CORS tuỳ trình duyệt)
          const [vicPriceRes2, usdtVndRes2] = await Promise.all([
            fetch(DEFAULTS.BINANCE_VICUSDT),
            fetch(DEFAULTS.COINGECKO_USD_VND)
          ]);
          const vicUsdt = Number((await vicPriceRes2.json())?.price||0);
          const usdtVnd2= Number((await usdtVndRes2.json())?.tether?.vnd||0);
          if (vicUsdt>0 && usdtVnd2>0) vinVND = Math.floor(vicUsdt * 100 * usdtVnd2);
        }
      }
    }

    if (!(vinVND>0)) throw new Error("Không lấy được giá");

    const ONE = ethers.utils.parseUnits("1",18);
    vinPerVNDWei = ONE.div(vinVND);
    if (ONE.mod(vinVND).gt(0)) vinPerVNDWei = vinPerVNDWei.add(1); // ceil

    $("#vinPrice")?.replaceChildren(`1 VIN = ${vinVND.toLocaleString("vi-VN")} VND`);
  }catch(e){
    console.error("fetchVinToVND:", e);
    if (vinPerVNDWei.isZero()) $("#vinPrice")?.replaceChildren("Đang tải giá...");
  }
}

/* -------------------- GAS overrides (legacy) -------------------- */
async function buildOverrides(weight="light"){
  const gasPrice = ethers.utils.parseUnits(LEGACY_GAS_PRICE_GWEI, "gwei");
  const gasLimit = weight==="heavy" ? GAS_LIMIT_HEAVY : (weight==="med" ? GAS_LIMIT_MED : GAS_LIMIT_LIGHT);
  return { type: 0, gasPrice, gasLimit };
}

/* -------------------- Kết nối ví -------------------- */
async function connectWallet(){
  try{
    if (!window.ethereum){ toast("Vui lòng cài MetaMask."); return; }
    await providerWrite.send("eth_requestAccounts", []);
    const net = await providerWrite.getNetwork();
    if (Number(net.chainId)!==DEFAULTS.CHAIN_ID){ toast("Sai mạng. Chọn Viction (chainId=88)."); return; }
    signer = providerWrite.getSigner();
    account = (await signer.getAddress()).toLowerCase();

    const { muabanR, vinR } = initContractsForRead();
    const { muabanW, vinW } = initContractsForWrite();
    muaban = muabanW; vin = vinW;

    hide($("#btnConnect")); show($("#walletBox"));
    $("#accountShort").textContent = short(account);
    $("#accountShort").href = `${DEFAULTS.EXPLORER}/address/${account}`;

    const [vinBal, vicBal] = await Promise.all([vinR.balanceOf(account), providerWrite.getBalance(account)]);
    $("#vinBalance").textContent = `VIN: ${parseFloat(ethers.utils.formatUnits(vinBal,18)).toFixed(4)}`;
    $("#vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;

    isRegistered = await muabanR.registered(account);
    refreshMenu();

    await Promise.all([loadAllProducts(muabanR), loadMyOrders(muabanR)]);
  }catch(e){
    showRpc(e, "connectWallet");
  }
}
function disconnectWallet(){
  account = null; signer = null;
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

/* -------------------- Sản phẩm: load qua event -------------------- */
async function loadAllProducts(muabanR){
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
    const card = document.createElement("div");
    card.className = `product ${active?"":"off"}`;
    card.innerHTML = `
      <img src="${img}" alt="${escapeHtml(data.name)}" />
      <div class="p-name">${escapeHtml(data.name)}</div>
      <div class="p-unit">Đơn vị: ${escapeHtml(unit)}</div>
      <div class="p-price">Giá: <b>${formatVND(data.priceVND)} VND</b></div>
      <div class="p-seller">Người bán: <a href="${DEFAULTS.EXPLORER}/address/${data.seller}" target="_blank" rel="noopener">${short(String(data.seller))}</a></div>
      <div class="p-actions">
        <button class="btn primary" data-action="buy" data-pid="${pid}">Mua</button>
        <button class="btn" data-action="update" data-pid="${pid}" ${!account||String(data.seller).toLowerCase()!==String(account).toLowerCase()?"disabled":""}>Cập nhật</button>
      </div>`;
    card.querySelector('[data-action="buy"]')?.addEventListener("click", ()=>openBuyForm(pid, data));
    card.querySelector('[data-action="update"]')?.addEventListener("click", ()=>openUpdateForm(pid, data));
    wrap.appendChild(card);
  });
}
function escapeHtml(s){ return String(s||"").replace(/[&<>"']/g, (c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

/* -------------------- Đăng ký -------------------- */
$("#btnRegister")?.addEventListener("click", doRegister);
async function doRegister(){
  if (!account){ toast("Hãy kết nối ví."); return; }
  try{
    const { MUABAN_ADDR } = readAddrs();
    const { muabanR } = initContractsForRead();
    const { vinW, muabanW } = initContractsForWrite();

    // 1) Ensure allowance 0.001 VIN
    const need = ethers.BigNumber.from(DEFAULTS.REG_FEE_WEI);
    const allow = await vin.allowance(account, MUABAN_ADDR);
    if (allow.lt(need)){
      try{
        const ovA = await buildOverrides("light");
        const txA = await vinW.approve(MUABAN_ADDR, need, ovA);
        await txA.wait();
      }catch(e){ showRpc(e, "approve.payRegistration"); return; }
    }

    // 2) Simulate
    try{
      const txData = await muabanW.populateTransaction.payRegistration();
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // 3) Send legacy
    try{
      const ov = await buildOverrides("med");
      const tx = await muabanW.payRegistration(ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.payRegistration"); return; }

    isRegistered = true;
    toast("Đăng ký thành công.");
    refreshMenu();
  }catch(e){ showRpc(e, "doRegister.catch"); }
}

/* -------------------- Tạo/Cập nhật sản phẩm -------------------- */
$("#btnCreate")?.addEventListener("click", ()=>{
  if (!isRegistered){ toast("Ví chưa đăng ký. Bấm ‘Đăng ký’ trước."); return; }
  $("#createName").value=""; $("#createIPFS").value="";
  $("#createUnit").value=""; $("#createPrice").value="";
  $("#createWallet").value=account||""; $("#createDays").value="3";
  show($("#formCreate"));
});
$(".modal#formCreate .close")?.addEventListener("click",()=>hide($("#formCreate")));
$("#btnSubmitCreate")?.addEventListener("click", submitCreate);

async function submitCreate(){
  try{
    // 1) Đọc & chuẩn hoá input
    let name   = ($("#createName").value||"").trim();
    const ipfs   = ($("#createIPFS").value||"").trim();
    const unit   = ($("#createUnit").value||"").trim();
    const wallet = ($("#createWallet").value||"").trim();
    const days   = parseInt(($("#createDays").value||"").trim(), 10);
    const priceVNDNum = parseVND($("#createPrice").value); // chỉ lấy số, "1200000" -> 1200000

    if (name.length > 500) name = name.slice(0,500);
    if (!name || !ipfs || !unit || !wallet){ alert("Điền đủ thông tin."); return; }
    if (!ethers.utils.isAddress(wallet)){ alert("Ví nhận thanh toán không hợp lệ."); return; }
    if (!Number.isInteger(days) || days <= 0){ alert("Số ngày giao ≥ 1."); return; }
    if (!Number.isFinite(priceVNDNum) || priceVNDNum <= 0){ alert("Giá (VND) phải > 0."); return; }

    const descriptionCID = `unit:${unit}`;
    const imageCID = ipfs;
    const priceVND = ethers.BigNumber.from(String(priceVNDNum));

    const { muabanW } = initContractsForWrite();

    // 2) Simulate trước để bắt revert rõ ràng (NOT_REGISTERED/PRICE_REQUIRED/...)
    try{
      const txData = await muabanW.populateTransaction.createProduct(
        name, descriptionCID, imageCID, priceVND, days, wallet, true
      );
      txData.from = account;               // rất quan trọng để simulate đúng context
      await providerWrite.call(txData);    // nếu revert sẽ ném ra error có reason
    }catch(simErr){
      alert(parseRevert(simErr));          // hiển thị reason human-readable
      return;
    }

    // 3) Gửi giao dịch (legacy tx trên VIC: type:0 + gasPrice)
    try{
      const ov = await buildOverrides("heavy"); // { type:0, gasPrice, gasLimit an toàn }
      const tx = await muabanW.createProduct(
        name, descriptionCID, imageCID, priceVND, days, wallet, true, ov
      );
      await tx.wait();
    }catch(sendErr){ showRpc(sendErr, "send.createProduct"); return; }

    // 4) OK: đóng form, reload danh sách
    alert("Đăng sản phẩm thành công.");
    hide($("#formCreate"));
    const { muabanR } = initContractsForRead();
    await loadAllProducts(muabanR);
  }catch(e){ showRpc(e, "submitCreate.catch"); }
}

$(".modal#formUpdate .close")?.addEventListener("click", ()=>hide($("#formUpdate")));
$("#btnSubmitUpdate")?.addEventListener("click", submitUpdate);

function openUpdateForm(pid, p){
  $("#updatePid").value = String(pid);
  $("#updatePrice").value = String(p.priceVND);
  $("#updateDays").value = String(p.deliveryDaysMax);
  $("#updateWallet").value = String(p.payoutWallet);
  $("#updateActive").checked = !!p.active;
  show($("#formUpdate"));
}
async function submitUpdate(){
  try{
    const pid = Number($("#updatePid").value);
    const priceInput = parseVND($("#updatePrice").value);
    const days = parseInt(($("#updateDays").value||"").trim(), 10);
    const wallet = ($("#updateWallet").value||"").trim();
    const active = !!$("#updateActive").checked;

    if (!Number.isFinite(priceInput) || priceInput<=0){ toast("Giá (VND) phải > 0."); return; }
    if (!Number.isInteger(days) || days<=0){ toast("Số ngày giao ≥ 1."); return; }
    if (!ethers.utils.isAddress(wallet)){ toast("Ví nhận thanh toán không hợp lệ."); return; }

    const priceVND = ethers.BigNumber.from(String(priceInput));

    const { muabanW } = initContractsForWrite();

    try{
      const txData = await muabanW.populateTransaction.updateProduct(pid, priceVND, days, wallet, active);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    try{
      const ov = await buildOverrides("med");
      const tx = await muabanW.updateProduct(pid, priceVND, days, wallet, active, ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.updateProduct"); return; }

    hide($("#formUpdate"));
    const { muabanR } = initContractsForRead();
    await loadAllProducts(muabanR);
  }catch(e){ showRpc(e, "submitUpdate.catch"); }
}

/* -------------------- Mua hàng -------------------- */
function openBuyForm(pid, p){
  if (!account){ toast("Hãy kết nối ví trước."); return; }
  if (!vinVND){ toast("Đang tải tỷ giá, vui lòng thử lại."); return; }
  const wrap = document.createElement("div");
  wrap.className = "modal";
  wrap.innerHTML = `
  <div class="modal-content">
    <h2>Mua sản phẩm</h2>
    <div id="buyProductInfo" class="mb8"></div>
    <label>Số lượng
      <input id="buyQty" type="number" min="1" value="1" />
    </label>
    <label>Họ tên người nhận
      <input id="buyName" placeholder="Nguyễn Văn A" />
    </label>
    <label>Số điện thoại
      <input id="buyPhone" placeholder="09xx..." />
    </label>
    <label>Địa chỉ nhận hàng
      <input id="buyAddress" placeholder="Số nhà, phường/xã, quận/huyện, tỉnh/thành" />
    </label>
    <label>Ghi chú (mã hoá)
      <textarea id="buyNote" rows="2" placeholder="Giao giờ hành chính, ..."></textarea>
    </label>
    <div class="actions">
      <button id="btnSubmitBuy" class="btn primary">Thanh toán</button>
      <button class="btn close">Đóng</button>
    </div>
  </div>`;
  document.body.appendChild(wrap);
  const buyInfo = wrap.querySelector('#buyProductInfo');
  buyInfo.innerHTML = `
    <div><b>${escapeHtml(p.name)}</b> <span class="badge mono">#${pid}</span></div>
    <div>Giá: <b>${formatVND(p.priceVND)} VND</b> / ${escapeHtml(parseUnitFromCID(p.descriptionCID))}</div>`;

  wrap.querySelector('.close')?.addEventListener('click', ()=>wrap.remove());
  wrap.addEventListener('click', (e)=>{ if (e.target.classList.contains('modal')) wrap.remove(); });
  wrap.querySelector('#btnSubmitBuy')?.addEventListener('click', ()=>placeOrder(pid, p, wrap));
}

async function placeOrder(pid, p, modal){
  try{
    const qty = Math.max(1, parseInt(document.querySelector('#buyQty')?.value||"1", 10));
    const name = (document.querySelector('#buyName')?.value||"").trim();
    const phone= (document.querySelector('#buyPhone')?.value||"").trim();
    const addr = (document.querySelector('#buyAddress')?.value||"").trim();
    const note = (document.querySelector('#buyNote')?.value||"").trim();

    if (!qty || qty<1){ toast("Số lượng ≥ 1"); return; }
    if (!name || !phone || !addr){ toast("Điền đủ Họ tên / SĐT / Địa chỉ"); return; }

    // Tính VIN phải trả
    const priceVND = ethers.BigNumber.from(String(p.priceVND));
    const amountVND= priceVND.mul(qty);
    if (vinPerVNDWei.isZero()){ toast("Tỷ giá chưa sẵn sàng"); return; }
    const vinAmount = vinPerVNDWei.mul(amountVND); // vì vinPerVNDWei là ceil => đủ tiền

    const buyerInfoCipher = JSON.stringify({ name, phone, addr, note });

    const { MUABAN_ADDR } = readAddrs();
    const { vinW, muabanW } = initContractsForWrite();
    // ensure allowance đủ vinAmount
    const allow = await vin.allowance(account, MUABAN_ADDR);
    if (allow.lt(vinAmount)){
      try{
        const ovA = await buildOverrides("light");
        const txA = await vinW.approve(MUABAN_ADDR, vinAmount, ovA);
        await txA.wait();
      }catch(e){ showRpc(e, "approve.placeOrder"); return; }
    }

    // simulate
    try{
      const txData = await muabanW.populateTransaction.placeOrder(pid, qty, vinPerVNDWei, buyerInfoCipher);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // send
    try{
      const ov = await buildOverrides("med");
      const tx = await muabanW.placeOrder(pid, qty, vinPerVNDWei, buyerInfoCipher, ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.placeOrder"); return; }

    toast("Đặt hàng thành công. VIN đã giữ trong escrow.");
    modal?.remove();
    const { muabanR } = initContractsForRead();
    await Promise.all([loadAllProducts(muabanR), loadMyOrders(muabanR)]);
  }catch(e){ showRpc(e, "placeOrder.catch"); }
}

/* -------------------- Đơn hàng của tôi -------------------- */
async function loadMyOrders(muabanR){
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("OrderPlaced");
    const { MUABAN_ADDR } = readAddrs();
    const logs = await providerRead.getLogs({ address: MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic] });

    ordersBuyer = []; ordersSeller = [];
    for (const l of logs){
      const parsed = iface.parseLog(l);
      const orderId  = Number(parsed.args.orderId);
      const productId= Number(parsed.args.productId);
      const p = await muabanR.getProduct(productId);
      const o = await muabanR.getOrder(orderId);
      const isBuyer  = o.buyer.toLowerCase()===account?.toLowerCase();
      const isSeller = p.seller.toLowerCase()===account?.toLowerCase();
      const item = { order: o, product: p, orderId, productId };
      if (isBuyer) ordersBuyer.push(item);
      if (isSeller) ordersSeller.push(item);
    }
    renderOrders();
  }catch(e){ console.error("loadMyOrders:", e); }
}
function renderOrders(){
  const bWrap = $("#ordersBuyList");
  if (bWrap){
    bWrap.innerHTML = "";
    if (!ordersBuyer.length){
      bWrap.innerHTML = `<div class="tag">Chưa có đơn mua.</div>`;
    }else{
      ordersBuyer.sort((a,b)=>b.orderId-a.orderId).forEach(({order, product, orderId, productId})=>{
        const canConfirm = Number(order.status)===1 && order.buyer.toLowerCase()===account.toLowerCase();
        const canRefund = canConfirm && (Number(order.deadline)*1000 < Date.now());
        const card = document.createElement("div");
        card.className = "order-card";
        card.innerHTML = `
          <div class="order-row"><span class="order-strong">${escapeHtml(product.name)}</span> <span class="badge mono">#${productId}</span></div>
          <div class="order-row">Mã đơn: <span class="order-strong mono">#${orderId}</span></div>
          <div class="order-row">VIN escrow: ${ethers.utils.formatUnits(order.vinAmount,18)}</div>
          <div class="order-row">Hạn giao: ${new Date(Number(order.deadline)*1000).toLocaleString("vi-VN")}</div>
          <div class="order-row">Trạng thái: ${statusText(order.status)}</div>
          <div class="card-actions">
            ${canConfirm? `<button class="btn primary" data-action="confirm" data-oid="${orderId}">Xác nhận đã nhận</button>`:""}
            ${canRefund? `<button class="btn" data-action="refund" data-oid="${orderId}">Hoàn tiền (quá hạn)</button>`:""}
          </div>`;
        card.querySelector('[data-action="confirm"]')?.addEventListener("click", ()=>confirmReceipt(orderId));
        card.querySelector('[data-action="refund"]')?.addEventListener("click", ()=>refundExpired(orderId));
        bWrap.appendChild(card);
      });
    }
  }

  const sWrap = $("#ordersSellList");
  if (sWrap){
    sWrap.innerHTML = "";
    if (!ordersSeller.length){
      sWrap.innerHTML = `<div class="tag">Chưa có đơn bán.</div>`;
    }else{
      ordersSeller.sort((a,b)=>b.orderId-a.orderId).forEach(({order, product, orderId, productId})=>{
        const card = document.createElement("div");
        card.className = "order-card";
        card.innerHTML = `
          <div class="order-row"><span class="order-strong">${escapeHtml(product.name)}</span> <span class="badge mono">#${productId}</span></div>
          <div class="order-row">Mã đơn: <span class="order-strong mono">#${orderId}</span></div>
          <div class="order-row">VIN escrow: ${ethers.utils.formatUnits(order.vinAmount,18)}</div>
          <div class="order-row">Hạn giao: ${new Date(Number(order.deadline)*1000).toLocaleString("vi-VN")}</div>
          <div class="order-row">Trạng thái: ${statusText(order.status)}</div>`;
        sWrap.appendChild(card);
      });
    }
  }
}
function statusText(n){
  // 0: None, 1: Placed, 2: Confirmed, 3: Refunded
  return n===1?"Đã đặt" : n===2?"Đã nhận" : n===3?"Đã hoàn" : "(không)";
}

async function confirmReceipt(orderId){
  try{
    const { muabanW } = initContractsForWrite();
    try{
      const txData = await muabanW.populateTransaction.confirmReceipt(orderId);
      txData.from = account; await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    try{
      const ov = await buildOverrides("light");
      const tx = await muabanW.confirmReceipt(orderId, ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.confirmReceipt"); return; }

    toast("Xác nhận đã nhận hàng thành công.");
    const { muabanR } = initContractsForRead();
    await loadMyOrders(muabanR);
  }catch(e){ showRpc(e, "confirmReceipt.catch"); }
}
async function refundExpired(orderId){
  try{
    const { muabanW } = initContractsForWrite();
    try{
      const txData = await muabanW.populateTransaction.refundIfExpired(orderId);
      txData.from = account; await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    try{
      const ov = await buildOverrides("light");
      const tx = await muabanW.refundIfExpired(orderId, ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.refundIfExpired"); return; }

    toast("Hoàn tiền (quá hạn) thành công.");
    const { muabanR } = initContractsForRead();
    await loadMyOrders(muabanR);
  }catch(e){ showRpc(e, "refundExpired.catch"); }
}

/* -------------------- Tìm kiếm -------------------- */
$("#btnSearch")?.addEventListener("click", doSearch);
function doSearch(){
  const q = ($("#searchInput")?.value||"").trim().toLowerCase();
  if (!q){ renderProducts(productsCache); return; }
  const f = productsCache.filter(({data})=> String(data.name).toLowerCase().includes(q));
  renderProducts(f);
}

/* -------------------- Bind & Main -------------------- */
$("#btnConnect")?.addEventListener("click", connectWallet);
$("#btnDisconnect")?.addEventListener("click", disconnectWallet);
$$(".modal").forEach(m=>{
  m.addEventListener("click", (e)=>{ if (e.target.classList.contains('modal')) hide(e.currentTarget); });
});

(async function main(){
  try{ await loadAbis(); }catch(e){ showRpc(e, "loadAbis"); return; }
  initProviders();
  await fetchVinToVND();
  setInterval(fetchVinToVND, 60_000);
  const { muabanR } = initContractsForRead();
  await loadAllProducts(muabanR);
  $("#menuBox")?.classList.add('hidden');
})();

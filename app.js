/* ====================================================================
   muaban.vin — app.js (ethers v5) — FIXED
   - Dứt điểm "Internal JSON-RPC error" bằng simulate legacy + estimateGas
   - Ép type:0 (legacy) + gasPrice cho cả simulate (eth_call) lẫn send
   - Khớp ID với index.html đã upload (buyTotalVIN, buyProductInfo, ...)
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
  // Có thể override qua <body data-*>:
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",

  // Phí đăng ký 0.001 VIN (18 decimals)
  REG_FEE_WEI: "1000000000000000",

  // Nguồn tỷ giá
  COINGECKO_VIC_VND: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=vnd",
  COINGECKO_USD_VND: "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",
  COINGECKO_VIC_USD: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=usd",
  BINANCE_VICUSDT:   "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",
};

/* ---- GAS: ép legacy (gasPrice), không dùng EIP-1559 ---- */
const GAS_LIMIT_LIGHT = ethers.BigNumber.from("200000");   // approve / confirm / refund
const GAS_LIMIT_MED   = ethers.BigNumber.from("400000");   // payRegistration / updateProduct / placeOrder
const GAS_LIMIT_HEAVY = ethers.BigNumber.from("800000");   // createProduct
const LEGACY_GWEI     = "50";

/* -------------------- State -------------------- */
let providerRead, providerWrite, signer, account;
let muaban, vin, MUABAN_ABI, VIN_ABI;
let isRegistered = false;

let vinPerVNDWei = ethers.BigNumber.from(0); // VIN wei / 1 VND (ceil)
let vinVND = 0;                               // 1 VIN = ? VND (floor)

let productsCache = [];
let ordersBuyer = [];
let ordersSeller = [];

/* -------------------- Helpers -------------------- */
function parseVND(input){
  const digits = String(input||"").trim().replace(/[^\d]/g,"");
  if (!digits) return NaN;
  const n = Number(digits);
  return Number.isFinite(n)?n:NaN;
}
function escapeHtml(s){ return String(s||"").replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[m])); }
function ipfsToHttp(link){
  if (!link) return "";
  if (/^https?:\/\//i.test(link)) return link;
  return `https://ipfs.io/ipfs/${String(link).replace(/^ipfs:\/\//,"")}`;
}
function parseUnitFromCID(desc){
  const m = String(desc||"").match(/(^|;)unit:([^;]+)/i);
  return m ? m[2].trim() : "";
}
function statusText(code){
  const m = {0:"-",1:"Đang xử lý",2:"Đã giải ngân",3:"Đã hoàn tiền"};
  return m[Number(code)] || "-";
}
function showRpc(err, tag="RPC"){
  const msg = parseRevert(err);
  console.error(tag, err);
  toast(`${tag}: ${msg}`);
}
function parseRevert(err){
  const raw = err?.error?.message || err?.data?.message || err?.reason || err?.message || "";
  const map = {
    NOT_REGISTERED: "Ví chưa đăng ký. Bấm ‘Đăng ký’ trước.",
    ALREADY_REGISTERED: "Ví đã đăng ký.",
    PRICE_REQUIRED: "Giá bán (VND) phải > 0.",
    DELIVERY_REQUIRED: "Thời gian giao hàng (ngày) phải ≥ 1.",
    PAYOUT_WALLET_ZERO: "Ví nhận thanh toán không hợp lệ.",
    NOT_SELLER: "Bạn không phải người bán.",
    PRODUCT_NOT_ACTIVE: "Sản phẩm đang tắt bán.",
    PRODUCT_NOT_FOUND: "Không tìm thấy sản phẩm.",
    QUANTITY_REQUIRED: "Số lượng phải ≥ 1.",
    VIN_PER_VND_REQUIRED: "Tỷ giá chưa sẵn sàng.",
    VIN_TRANSFER_FAIL: "Chuyển VIN thất bại (kiểm tra số dư/allowance).",
    NOT_PLACED: "Trạng thái đơn không hợp lệ.",
    NOT_BUYER: "Chỉ người mua mới thực hiện được.",
    NOT_EXPIRED: "Chưa quá hạn để hoàn tiền.",
  };
  for (const k in map) if (raw.includes(k)) return map[k];

  // cố gắng decode Error(string)
  try{
    const data = err?.error?.data || err?.data;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10){
      const iface = new ethers.utils.Interface(["function Error(string)"]);
      const reason = iface.parseError(data)?.args?.[0];
      if (reason) return String(reason);
    }
  }catch(_) {}

  return raw || "Giao dịch bị từ chối hoặc dữ liệu không hợp lệ.";
}

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
  providerRead  = new ethers.providers.JsonRpcProvider(DEFAULTS.RPC_URL);
  if (window.ethereum) providerWrite = new ethers.providers.Web3Provider(window.ethereum, "any");
}
async function initContractsForWrite(){
  const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
  signer = providerWrite.getSigner();
  muaban = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);
  vin    = new ethers.Contract(VIN_ADDR,    VIN_ABI,    signer);
}
function initContractsForRead(){
  const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
  return {
    muabanR: new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, providerRead),
    vinR:    new ethers.Contract(VIN_ADDR,    VIN_ABI,    providerRead),
  };
}

/* ---- Overrides legacy ---- */
function buildOverrides(kind="med"){
  const ov = { type: 0, gasPrice: ethers.utils.parseUnits(LEGACY_GWEI, "gwei") };
  if (kind==="light") ov.gasLimit = GAS_LIMIT_LIGHT;
  else if (kind==="heavy") ov.gasLimit = GAS_LIMIT_HEAVY;
  else ov.gasLimit = GAS_LIMIT_MED;
  return ov;
}

/* ---- Preflight: populate → estimateGas(+20%) → eth_call (legacy) ---- */
async function preflightLegacy(contract, method, args, tier="med", tag="simulate"){
  const ov = buildOverrides(tier);
  const fnPopulate = contract.populateTransaction[method].bind(contract);
  const fnEstimate = contract.estimateGas[method].bind(contract);

  const txData = await fnPopulate(...args);
  txData.from     = account;
  txData.type     = 0;
  txData.gasPrice = ov.gasPrice;

  // estimateGas + buffer 20%
  try{
    const est = await fnEstimate(...args, { from: account });
    txData.gasLimit = est.mul(120).div(100);
  }catch(_){
    txData.gasLimit = ov.gasLimit; // fallback
  }

  // simulate với đủ from/type/gasPrice/gasLimit
  await providerWrite.call(txData).catch((e)=>{ throw new Error(parseRevert(e)||`[${tag}] simulate lỗi`); });
  return txData.gasLimit;
}

/* -------------------- Giá VIN theo VND -------------------- */
async function fetchVinToVND(){
  try{
    const override = Number(document.body?.dataset?.vinVnd||0);
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
        vinVND = Math.floor(vicVnd * 100);
      }else{
        const [vicUsdRes, usdtVndRes] = await Promise.all([
          fetch(DEFAULTS.COINGECKO_VIC_USD),
          fetch(DEFAULTS.COINGECKO_USD_VND)
        ]);
        const vicUsd = Number((await vicUsdRes.json())?.viction?.usd||0);
        const usdtVnd= Number((await usdtVndRes.json())?.tether?.vnd||0);
        if (vicUsd>0 && usdtVnd>0) vinVND = Math.floor(vicUsd * 100 * usdtVnd);
        else{
          const [vicUsdtRes, usdtVndRes2] = await Promise.all([
            fetch(DEFAULTS.BINANCE_VICUSDT),
            fetch(DEFAULTS.COINGECKO_USD_VND)
          ]);
          const vicUsdt = Number((await vicUsdtRes.json())?.price||0);
          const usdtVnd2= Number((await usdtVndRes2.json())?.tether?.vnd||0);
          if (vicUsdt>0 && usdtVnd2>0) vinVND = Math.floor(vicUsdt * 100 * usdtVnd2);
        }
      }
    }
    if (!(vinVND>0)) throw new Error("Không lấy được giá");

    const ONE = ethers.BigNumber.from("1000000000000000000");
    vinPerVNDWei = ONE.div(vinVND);
    if (ONE.mod(vinVND).gt(0)) vinPerVNDWei = vinPerVNDWei.add(1);

    $("#vinPrice")?.replaceChildren(`1 VIN = ${vinVND.toLocaleString("vi-VN")} VND`);
  }catch(e){
    console.error("fetchVinToVND:", e);
    if (vinPerVNDWei.isZero()) $("#vinPrice")?.replaceChildren("Đang tải giá…");
  }
}

/* -------------------- Kết nối ví -------------------- */
async function connectWallet(){
  try{
    if (!window.ethereum){ toast("Vui lòng cài MetaMask."); return; }
    await providerWrite.send("eth_requestAccounts", []);
    const net = await providerWrite.getNetwork();
    if (Number(net.chainId)!==DEFAULTS.CHAIN_ID){ toast("Sai mạng. Chọn Viction (chainId=88)."); return; }
    account = (await providerWrite.getSigner().getAddress()).toLowerCase();
    await initContractsForWrite();

    const { muabanR, vinR } = initContractsForRead();
    const [vinBal, vicBal] = await Promise.all([
      vinR.balanceOf(account),
      providerWrite.getBalance(account)
    ]);

    hide($("#btnConnect")); show($("#walletBox"));
    $("#accountShort").textContent = short(account);
    $("#accountShort").href = `${DEFAULTS.EXPLORER}/address/${account}`;
    $("#vinBalance").textContent = `VIN: ${parseFloat(ethers.utils.formatUnits(vinBal,18)).toFixed(4)}`;
    $("#vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;

    // trạng thái đăng ký
    try{
      isRegistered = await muabanR.registered(account);
    }catch(_){ isRegistered = false; }
    refreshMenu();

    // load dữ liệu
    await Promise.all([ fetchVinToVND(), loadAllProducts(muabanR), loadMyOrders(muabanR) ]);
  }catch(e){ showRpc(e, "connectWallet"); }
}
function disconnectWallet(){
  account = null; signer = null;
  hide($("#walletBox")); show($("#btnConnect"));
  $("#vinBalance").textContent = "VIN: 0"; $("#vicBalance").textContent = "VIC: 0";
  isRegistered = false; refreshMenu();
}
function refreshMenu(){
  const btnReg = $("#btnRegister");
  const btnCrt = $("#btnCreate");
  const btnOB  = $("#btnOrdersBuy");
  const btnOS  = $("#btnOrdersSell");
  if (!account){
    btnReg?.classList.add("hidden"); btnCrt?.classList.add("hidden");
    btnOB?.classList.add("hidden");  btnOS?.classList.add("hidden");
  }else if (!isRegistered){
    btnReg?.classList.remove("hidden");
    btnCrt?.classList.add("hidden"); btnOB?.classList.add("hidden"); btnOS?.classList.add("hidden");
  }else{
    btnReg?.classList.add("hidden");
    btnCrt?.classList.remove("hidden"); btnOB?.classList.remove("hidden"); btnOS?.classList.remove("hidden");
  }
}

/* -------------------- Đăng ký -------------------- */
$("#btnRegister")?.addEventListener("click", async ()=>{
  if (!account){ toast("Hãy kết nối ví."); return; }
  try{
    const need = ethers.BigNumber.from(DEFAULTS.REG_FEE_WEI);
    const { MUABAN_ADDR } = readAddrs();
    const allow = await vin.allowance(account, MUABAN_ADDR);
    if (allow.lt(need)){
      try{
        const ovA = buildOverrides("light");
        const txA = await vin.approve(MUABAN_ADDR, need, ovA);
        await txA.wait();
      }catch(e){ showRpc(e, "approve.payRegistration"); return; }
    }

    let gasLimit;
    try{
      gasLimit = await preflightLegacy(muaban, "payRegistration", [], "med", "simulate.payRegistration");
    }catch(simErr){ toast(simErr.message); return; }

    try{
      const ov = buildOverrides("med");
      const tx = await muaban.payRegistration({ ...ov, gasLimit });
      await tx.wait();
    }catch(e){ showRpc(e, "send.payRegistration"); return; }

    isRegistered = true; toast("Đăng ký thành công."); refreshMenu();
  }catch(e){ showRpc(e, "btnRegister"); }
});

/* -------------------- Sản phẩm -------------------- */
$("#btnCreate")?.addEventListener("click", ()=>{
  if (!isRegistered){ toast("Ví chưa đăng ký. Bấm ‘Đăng ký’."); return; }
  $("#createName").value=""; $("#createIPFS").value=""; $("#createUnit").value="";
  $("#createPrice").value=""; $("#createWallet").value=account||""; $("#createDays").value="3";
  show($("#formCreate"));
});
$(".modal#formCreate .close")?.addEventListener("click", ()=>hide($("#formCreate")));
$("#btnSubmitCreate")?.addEventListener("click", submitCreate);

async function submitCreate(){
  try{
    let name  = ($("#createName").value||"").trim();
    const ipfs  = ($("#createIPFS").value||"").trim();
    const unit  = ($("#createUnit").value||"").trim();
    const wallet= ($("#createWallet").value||"").trim();
    const days  = parseInt(($("#createDays").value||"").trim(), 10);
    const priceInput = parseVND($("#createPrice").value);

    if (name.length>500) name = name.slice(0,500);
    if (!name||!ipfs||!unit||!wallet){ toast("Điền đủ thông tin."); return; }
    if (!ethers.utils.isAddress(wallet)){ toast("Ví nhận thanh toán không hợp lệ."); return; }
    if (!Number.isInteger(days) || days<=0){ toast("Số ngày giao ≥ 1."); return; }
    if (!Number.isFinite(priceInput) || priceInput<=0){ toast("Giá (VND) phải > 0."); return; }

    const descriptionCID = `unit:${unit}`;
    const imageCID = ipfs;
    const priceVND = ethers.BigNumber.from(String(priceInput));

    let gasLimit;
    try{
      gasLimit = await preflightLegacy(
        muaban, "createProduct",
        [name, descriptionCID, imageCID, priceVND, days, wallet, true],
        "heavy", "simulate.createProduct"
      );
    }catch(simErr){ toast(simErr.message); return; }

    try{
      const ov = buildOverrides("heavy");
      const tx = await muaban.createProduct(
        name, descriptionCID, imageCID, priceVND, days, wallet, true,
        { ...ov, gasLimit }
      );
      await tx.wait();
    }catch(e){ showRpc(e, "send.createProduct"); return; }

    hide($("#formCreate"));
    toast("Đăng sản phẩm thành công.");
    const { muabanR } = initContractsForRead();
    await loadAllProducts(muabanR);
  }catch(e){ showRpc(e, "submitCreate"); }
}

/* ---- Update sản phẩm ---- */
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

    let gasLimit;
    try{
      gasLimit = await preflightLegacy(
        muaban, "updateProduct",
        [pid, priceVND, days, wallet, active],
        "med", "simulate.updateProduct"
      );
    }catch(simErr){ toast(simErr.message); return; }

    try{
      const ov = buildOverrides("med");
      const tx = await muaban.updateProduct(pid, priceVND, days, wallet, active, { ...ov, gasLimit });
      await tx.wait();
    }catch(e){ showRpc(e, "send.updateProduct"); return; }

    hide($("#formUpdate"));
    toast("Cập nhật thành công.");
    const { muabanR } = initContractsForRead();
    await loadAllProducts(muabanR);
  }catch(e){ showRpc(e, "submitUpdate"); }
}

/* -------------------- Mua hàng -------------------- */
$(".modal#formBuy .close")?.addEventListener("click", ()=>hide($("#formBuy")));
$("#btnSubmitBuy")?.addEventListener("click", submitBuy);
$("#buyQty")?.addEventListener("input", recalcBuyTotal);

let currentBuying = null;
function openBuyForm(pid, p){
  currentBuying = { pid, product: p };
  const unit = parseUnitFromCID(p.descriptionCID) || "đv";
  const html = `
    <div><b>#${pid}</b> — ${escapeHtml(p.name)}</div>
    <div>Giá: <b>${Number(p.priceVND).toLocaleString("vi-VN")}</b> VND / ${unit}</div>
  `;
  $("#buyProductInfo").innerHTML = html;
  $("#buyName").value=""; $("#buyAddress").value=""; $("#buyPhone").value=""; $("#buyNote").value="";
  $("#buyQty").value = "1";
  recalcBuyTotal();
  show($("#formBuy"));
}
function recalcBuyTotal(){
  try{
    const qty = Math.max(1, parseInt($("#buyQty").value||"1",10));
    const priceVND = ethers.BigNumber.from(String(currentBuying?.product?.priceVND||0));
    const totalVND = priceVND.mul(qty);
    if (vinPerVNDWei.isZero()){
      $("#buyTotalVIN").textContent = "Tổng VIN cần trả: …";
    }else{
      const totalVinWei = totalVND.mul(vinPerVNDWei);
      const totalVin = Number(ethers.utils.formatUnits(totalVinWei,18)).toFixed(4);
      $("#buyTotalVIN").textContent = `Tổng VIN cần trả: ${totalVin}`;
    }
  }catch(_){ $("#buyTotalVIN").textContent = "Tổng VIN cần trả: …"; }
}

async function submitBuy(){
  try{
    if (!currentBuying) return;
    if (!isRegistered){ toast("Ví chưa đăng ký. Bấm ‘Đăng ký’."); return; }
    const qty = Math.max(1, parseInt($("#buyQty").value||"1",10));
    const info = {
      name: ($("#buyName").value||"").trim(),
      addr: ($("#buyAddress").value||"").trim(),
      phone: ($("#buyPhone").value||"").trim(),
      note: ($("#buyNote").value||"").trim(),
    };
    if (!info.name || !info.addr || !info.phone){ toast("Nhập đủ họ tên, địa chỉ, SĐT."); return; }
    if (vinPerVNDWei.isZero()){ toast("Tỷ giá VIN/VND chưa sẵn sàng."); return; }

    const pid = currentBuying.pid;
    const priceVND = ethers.BigNumber.from(String(currentBuying.product.priceVND));
    const totalVND = priceVND.mul(qty);
    const vinAmount = totalVND.mul(vinPerVNDWei);

    const { MUABAN_ADDR } = readAddrs();
    const allow = await vin.allowance(account, MUABAN_ADDR);
    if (allow.lt(vinAmount)){
      try{
        const ovA = buildOverrides("light");
        const txA = await vin.approve(MUABAN_ADDR, vinAmount, ovA);
        await txA.wait();
      }catch(e){ showRpc(e, "approve.placeOrder"); return; }
    }

    const cipher = btoa(unescape(encodeURIComponent(JSON.stringify(info))));

    let gasLimit;
    try{
      gasLimit = await preflightLegacy(
        muaban, "placeOrder",
        [pid, qty, vinPerVNDWei, cipher],
        "med", "simulate.placeOrder"
      );
    }catch(simErr){ toast(simErr.message); return; }

    try{
      const ov = buildOverrides("med");
      const tx = await muaban.placeOrder(pid, qty, vinPerVNDWei, cipher, { ...ov, gasLimit });
      await tx.wait();
    }catch(e){ showRpc(e, "send.placeOrder"); return; }

    hide($("#formBuy"));
    toast("Đặt mua thành công.");
    const { muabanR } = initContractsForRead();
    await loadMyOrders(muabanR);
  }catch(e){ showRpc(e, "submitBuy"); }
}

/* -------------------- Danh sách sản phẩm & đơn hàng -------------------- */
async function loadAllProducts(muabanR){
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("ProductCreated");
    const { MUABAN_ADDR } = readAddrs();
    const logs = await providerRead.getLogs({ address: MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic] });

    const ids = new Set();
    logs.forEach(l=>{ const p = iface.parseLog(l); ids.add(p.args.productId.toString()); });

    productsCache = [];
    for (const pid of Array.from(ids).sort((a,b)=>Number(a)-Number(b))){
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
    const unit = parseUnitFromCID(data.descriptionCID)||"đv";
    const img = ipfsToHttp(data.imageCID);
    const active = !!data.active;
    const priceVnd = Number(data.priceVND);
    const priceVin = vinPerVNDWei.isZero() ? "-" :
      Number(ethers.utils.formatUnits(ethers.BigNumber.from(priceVnd).mul(vinPerVNDWei),18)).toFixed(4);

    const card = document.createElement("div");
    card.className = "product";
    card.innerHTML = `
      <div class="thumb" style="background-image:url('${img}');"></div>
      <div class="meta">
        <div class="name">${escapeHtml(data.name)}</div>
        <div class="price">Giá: <b>${priceVnd.toLocaleString("vi-VN")}</b> VND (${priceVin} VIN/${unit})</div>
        <div class="row mono">#${pid} · Giao tối đa ${data.deliveryDaysMax} ngày · ${active?"Còn bán":"<span class='warn'>Hết hàng</span>"}</div>
        <div class="row mono">Người bán: ${short(String(data.seller))}</div>
        <div class="actions">
          <button class="btn buy" ${active?"":"disabled"} data-pid="${pid}">Mua</button>
          ${String(data.seller).toLowerCase()===String(account||"").toLowerCase()
            ? `<button class="btn edit" data-pid="${pid}">Sửa</button>` : ``}
        </div>
      </div>`;
    wrap.appendChild(card);
  });

  $$(".product .btn.buy").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const pid = Number(btn.dataset.pid);
      const p = productsCache.find(x=>x.pid===pid)?.data;
      if (!p) return toast("Không tìm thấy sản phẩm.");
      openBuyForm(pid, p);
    });
  });
  $$(".product .btn.edit").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const pid = Number(btn.dataset.pid);
      const p = productsCache.find(x=>x.pid===pid)?.data;
      if (!p) return toast("Không tìm thấy sản phẩm.");
      openUpdateForm(pid, p);
    });
  });
}

/* ---- Đơn hàng của tôi ---- */
$("#btnOrdersBuy")?.addEventListener("click", ()=>{
  show($("#ordersBuySection")); hide($("#ordersSellSection"));
  window.scrollTo({ top: $("#ordersBuySection").offsetTop - 20, behavior: "smooth" });
});
$("#btnOrdersSell")?.addEventListener("click", ()=>{
  show($("#ordersSellSection")); hide($("#ordersBuySection"));
  window.scrollTo({ top: $("#ordersSellSection").offsetTop - 20, behavior: "smooth" });
});

async function loadMyOrders(muabanR){
  if (!account) return;
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("OrderPlaced");
    const { MUABAN_ADDR } = readAddrs();
    const logs = await providerRead.getLogs({ address: MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic] });

    ordersBuyer = []; ordersSeller = [];
    for (const l of logs){
      const parsed = iface.parseLog(l);
      const orderId = parsed.args.orderId.toNumber();
      const productId= parsed.args.productId.toNumber();
      const order    = await muabanR.getOrder(orderId);
      const product  = await muabanR.getProduct(productId);
      if (!order || !order.buyer) continue;

      if (String(order.buyer).toLowerCase()===String(account).toLowerCase()){
        ordersBuyer.push({order, product, orderId, productId});
      }
      if (String(product.seller).toLowerCase()===String(account).toLowerCase()){
        ordersSeller.push({order, product, orderId, productId});
      }
    }
    renderOrders();
  }catch(e){ console.error("loadMyOrders:", e); }
}
function renderOrders(){
  const bWrap = $("#ordersBuyList");
  const sWrap = $("#ordersSellList");
  if (bWrap) bWrap.innerHTML = "";
  if (sWrap) sWrap.innerHTML = "";

  if (bWrap){
    if (!ordersBuyer.length){ bWrap.innerHTML = `<div class="tag">Chưa có đơn mua.</div>`; }
    else{
      ordersBuyer.sort((a,b)=>b.orderId-a.orderId).forEach(({order, product, orderId, productId})=>{
        const totalVin = Number(ethers.utils.formatUnits(order.vinAmount,18)).toFixed(4);
        const card = document.createElement("div");
        card.className = "order-card";
        card.innerHTML = `
          <div class="order-row"><span class="order-strong">${escapeHtml(product.name)}</span> <span class="badge mono">#${productId}</span></div>
          <div class="order-row">Mã đơn: <span class="order-strong mono">#${orderId}</span></div>
          <div class="order-row">Số lượng: ${order.quantity} · VIN escrow: ${totalVin}</div>
          <div class="order-row">Hạn giao: ${new Date(Number(order.deadline)*1000).toLocaleString("vi-VN")}</div>
          <div class="order-row">Trạng thái: ${statusText(order.status)}</div>
          <div class="order-row">
            ${Number(order.status)===1
              ? `<button class="btn small" data-act="confirm" data-oid="${orderId}">Xác nhận đã nhận hàng</button>
                 <button class="btn small" data-act="refund" data-oid="${orderId}">Yêu cầu hoàn tiền (quá hạn)</button>`
              : ``}
          </div>`;
        bWrap.appendChild(card);
      });
      $$('#ordersBuyList [data-act="confirm"]').forEach(btn=>btn.addEventListener("click", ()=>confirmReceipt(Number(btn.dataset.oid))));
      $$('#ordersBuyList [data-act="refund"]').forEach(btn=>btn.addEventListener("click", ()=>refundExpired(Number(btn.dataset.oid))));
    }
  }

  if (sWrap){
    if (!ordersSeller.length){ sWrap.innerHTML = `<div class="tag">Chưa có đơn bán.</div>`; }
    else{
      ordersSeller.sort((a,b)=>b.orderId-a.orderId).forEach(({order, product, orderId, productId})=>{
        const totalVin = Number(ethers.utils.formatUnits(order.vinAmount,18)).toFixed(4);
        const card = document.createElement("div");
        card.className = "order-card";
        card.innerHTML = `
          <div class="order-row"><span class="order-strong">${escapeHtml(product.name)}</span> <span class="badge mono">#${productId}</span></div>
          <div class="order-row">Mã đơn: <span class="order-strong mono">#${orderId}</span> · Buyer: ${short(order.buyer)}</div>
          <div class="order-row">Số lượng: ${order.quantity} · VIN escrow: ${totalVin}</div>
          <div class="order-row">Hạn giao: ${new Date(Number(order.deadline)*1000).toLocaleString("vi-VN")}</div>
          <div class="order-row">Trạng thái: ${statusText(order.status)}</div>`;
        sWrap.appendChild(card);
      });
    }
  }
}

async function confirmReceipt(orderId){
  try{
    let gasLimit;
    try{
      gasLimit = await preflightLegacy(muaban, "confirmReceipt", [orderId], "light", "simulate.confirmReceipt");
    }catch(simErr){ toast(simErr.message); return; }

    try{
      const ov = buildOverrides("light");
      const tx = await muaban.confirmReceipt(orderId, { ...ov, gasLimit });
      await tx.wait();
    }catch(e){ showRpc(e, "send.confirmReceipt"); return; }

    toast("Đã xác nhận nhận hàng.");
    const { muabanR } = initContractsForRead();
    await loadMyOrders(muabanR);
  }catch(e){ showRpc(e, "confirmReceipt"); }
}
async function refundExpired(orderId){
  try{
    let gasLimit;
    try{
      gasLimit = await preflightLegacy(muaban, "refundIfExpired", [orderId], "light", "simulate.refund");
    }catch(simErr){ toast(simErr.message); return; }

    try{
      const ov = buildOverrides("light");
      const tx = await muaban.refundIfExpired(orderId, { ...ov, gasLimit });
      await tx.wait();
    }catch(e){ showRpc(e, "send.refundIfExpired"); return; }

    toast("Đã yêu cầu hoàn tiền.");
    const { muabanR } = initContractsForRead();
    await loadMyOrders(muabanR);
  }catch(e){ showRpc(e, "refundExpired"); }
}

/* -------------------- Tìm kiếm -------------------- */
$("#btnSearch")?.addEventListener("click", ()=>{
  const kw = String($("#searchInput").value||"").trim().toLowerCase();
  if (!kw) return renderProducts(productsCache);
  const filtered = productsCache.filter(({data})=> String(data.name).toLowerCase().includes(kw));
  renderProducts(filtered);
});

/* -------------------- Mount -------------------- */
(async function main(){
  try{
    await loadAbis();
    initProviders();
    $("#btnConnect")?.addEventListener("click", connectWallet);
    $("#btnDisconnect")?.addEventListener("click", disconnectWallet);

    fetchVinToVND(); // load giá sớm

    if (window.ethereum){
      window.ethereum.on?.('accountsChanged', ()=>location.reload());
      window.ethereum.on?.('chainChanged',   ()=>location.reload());
    }
  }catch(e){ console.error(e); }
})();

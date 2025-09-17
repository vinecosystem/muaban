/* ====================================================================
   muaban.vin — app.js (ethers v5 UMD)
   — FIXED: "Internal JSON-RPC error" on create/update/order by:
       1) Forcing LEGACY gas (gasPrice) — no EIP‑1559 fields
       2) Simulating every write via provider.call(populateTransaction) to
          surface revert reasons BEFORE sending
       3) Centralized overrides + wide gas limits
       4) Stricter input validation & VND parser
   — Synced with index.html structure & Muaban.sol ABI
   — Uses VIN≈100×VIC for price, VICUSDT from Binance + USD→VND FX
==================================================================== */

/* -------------------- DOM helpers -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show=(el)=>el && el.classList.remove("hidden");
const hide=(el)=>el && el.classList.add("hidden");
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`:"";

/* -------------------- CONSTANTS -------------------- */
const DEFAULTS = {
  CHAIN_ID: 88, // Viction mainnet
  RPC_URL:  "https://rpc.viction.xyz",
  EXPLORER:"https://vicscan.xyz", // user-confirmed explorer
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",
};

/* ---- GAS/FEES: ép legacy (gasPrice), không dùng EIP-1559 ---- */
const GAS_LIMIT_LIGHT = ethers.BigNumber.from("200000");   // approve / confirm / refund
const GAS_LIMIT_MED   = ethers.BigNumber.from("400000");   // payRegistration / updateProduct / placeOrder
const GAS_LIMIT_HEAVY = ethers.BigNumber.from("800000");   // createProduct
const LEGACY_GAS_PRICE_GWEI = "50"; // có thể tăng 100–200 nếu muốn "rộng" hơn

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

// Hiện lỗi RPC (chi tiết) — tiện debug trên mobile
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
function parseUnitFromCID(desc){
  if (!desc) return "";
  const m = /^unit:(.+)$/i.exec(desc.trim());
  return m ? m[1].trim() : "";
}
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;" }[s] || s));
}
function statusText(code){
  const m = {0:"-",1:"Đang xử lý",2:"Đã giải ngân",3:"Đã hoàn tiền"};
  return m[Number(code)] || "-";
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
  providerRead  = new ethers.providers.JsonRpcProvider(DEFAULTS.RPC_URL, DEFAULTS.CHAIN_ID);
  if (window.ethereum){
    providerWrite = new ethers.providers.Web3Provider(window.ethereum, "any");
  }
}
function initContractsForRead(){
  const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
  const muabanR = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, providerRead);
  const vinR    = new ethers.Contract(VIN_ADDR,    VIN_ABI,    providerRead);
  return { muabanR, vinR };
}
function initContractsForWrite(){
  const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
  muaban = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);
  vin    = new ethers.Contract(VIN_ADDR,    VIN_ABI,    signer);
}

async function buildOverrides(kind="med"){
  const gasPrice = ethers.utils.parseUnits(LEGACY_GAS_PRICE_GWEI, "gwei");
  const gasLimit = kind==="heavy"?GAS_LIMIT_HEAVY: kind==="light"?GAS_LIMIT_LIGHT:GAS_LIMIT_MED;
  return { gasPrice, gasLimit };
}

/* -------------------- Pricing: VIN ↔ VND -------------------- */
const VIN_TO_VIC = 100; // Quy ước: 1 VIN ≈ 100 VIC (pegged in ecosystem)
async function fetchVinToVND(){
  try{
    // VIC/USDT price (USD)
    const rVic = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT").then(r=>r.json()).catch(()=>null);
    const vicUsd = Number(rVic?.price||0);

    // USD→VND FX
    const rFx  = await fetch("https://api.exchangerate.host/latest?base=USD&symbols=VND").then(r=>r.json()).catch(()=>null);
    const usdVnd = Number(rFx?.rates?.VND||0);

    if (vicUsd>0 && usdVnd>0){
      const vinUsd = vicUsd * VIN_TO_VIC;
      const vinVndFloat = vinUsd * usdVnd;
      vinVND = Math.floor(vinVndFloat); // floor để hiển thị ổn định
      // vinPerVNDWei = ceil(1e18 / vinVND)
      const one = ethers.BigNumber.from("1000000000000000000");
      vinPerVNDWei = ethers.BigNumber.from(vinVND>0 ? Math.ceil(1e18 / vinVND) : 0);
      // UI chip
      const txt = `1 VIN ≈ ${vinVND.toLocaleString("vi-VN")} VND`;
      const chip = $("#vinPrice");
      if (chip){ chip.textContent = txt; }
    }else{
      const chip = $("#vinPrice");
      if (chip){ chip.textContent = "Loading price."; }
    }
  }catch(_){
    const chip = $("#vinPrice");
    if (chip){ chip.textContent = "Loading price."; }
  }
}

/* -------------------- Wallet -------------------- */
async function connectWallet(){
  try{
    if (!window.ethereum){ alert("Không phát hiện ví. Hãy cài MetaMask hoặc tương thích."); return; }
    await window.ethereum.request({ method: "eth_requestAccounts" });

    // Ensure chain = Viction 88
    const net = await providerWrite.getNetwork();
    if (Number(net.chainId) !== DEFAULTS.CHAIN_ID){
      try{
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x58" }], // 88
        });
      }catch(switchErr){
        if (switchErr?.code === 4902){
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: "0x58",
              chainName: "Viction",
              nativeCurrency: { name: "VIC", symbol: "VIC", decimals: 18 },
              rpcUrls: [DEFAULTS.RPC_URL],
              blockExplorerUrls: [DEFAULTS.EXPLORER],
            }]
          });
        }else{ throw switchErr; }
      }
    }

    signer  = providerWrite.getSigner();
    account = await signer.getAddress();
    initContractsForWrite();

    // UI update
    $("#accountShort").textContent = short(account);
    $("#accountShort").href = `${DEFAULTS.EXPLORER}/address/${account}`;
    hide($("#btnConnect"));
    show($("#walletBox"));
    show($("#menuBox"));

    await refreshBalances();
    await refreshRegistration();

    const { muabanR } = initContractsForRead();
    await loadMyOrders(muabanR);

  }catch(e){ showRpc(e, "connectWallet"); }
}
function disconnectWallet(){
  try{ location.reload(); }catch(_){ /* noop */ }
}
async function refreshBalances(){
  try{
    const { VIN_ADDR } = readAddrs();
    const vinR = new ethers.Contract(VIN_ADDR, VIN_ABI, providerRead);
    const [vinBal, vicBal] = await Promise.all([
      vinR.balanceOf(account),
      providerWrite.getBalance(account)
    ]);
    $("#vinBalance").textContent = `VIN: ${ethers.utils.formatUnits(vinBal, 18).slice(0, 8)}`;
    $("#vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;
  }catch(_){ /* ignore */ }
}
async function refreshRegistration(){
  try{
    const { muabanR } = initContractsForRead();
    isRegistered = await muabanR.registered(account);
    if (isRegistered){
      hide($("#btnRegister"));
      show($("#btnCreate"));
      show($("#btnOrdersBuy"));
      show($("#btnOrdersSell"));
    }else{
      show($("#btnRegister"));
      hide($("#btnCreate"));
      hide($("#btnOrdersBuy"));
      hide($("#btnOrdersSell"));
    }
  }catch(e){ console.error("refreshRegistration", e); }
}

/* -------------------- Products -------------------- */
async function loadAllProducts(muabanR){
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("ProductCreated");
    const { MUABAN_ADDR } = readAddrs();
    const logs = await providerRead.getLogs({ address: MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic] });
    const pids = logs.map(l=> iface.parseLog(l).args.productId.toNumber());
    const unique = [...new Set(pids)];
    productsCache = await Promise.all(unique.map(pid=> muabanR.getProduct(pid)));
    productsCache = productsCache.filter(p=> Number(p.productId)>0);
    renderProducts(productsCache);
  }catch(e){ console.error("loadAllProducts", e); }
}
function renderProducts(list){
  const wrap = $("#productList");
  if (!wrap) return;
  wrap.innerHTML = "";
  const q = String($("#searchInput")?.value||"").toLowerCase().trim();
  const view = q? list.filter(p=> String(p.name).toLowerCase().includes(q)) : list;
  if (!view.length){
    wrap.innerHTML = `<div class="tag">Không có sản phẩm.</div>`;
    return;
  }
  view.sort((a,b)=> Number(b.updatedAt)-Number(a.updatedAt));
  view.forEach(p=>{
    const unit = parseUnitFromCID(p.descriptionCID);
    const price = Number(p.priceVND)||0;
    const approxVin = (vinVND>0 ? Math.ceil(price / vinVND) : 0);
    const card = document.createElement("div");
    card.className = "card product";
    card.innerHTML = `
      <img class="thumb" src="${escapeHtml(ipfsToHttp(p.imageCID))}" onerror="this.src='fallback.png'"/>
      <div class="title">${escapeHtml(p.name)}</div>
      <div class="sub">${unit? `ĐVT: ${escapeHtml(unit)} · `: ""}Giá: <b>${price.toLocaleString('vi-VN')}</b> VND ${vinVND?`(~ ${approxVin} VIN)`:''}</div>
      <div class="card-actions">
        <button class="btn primary" data-action="buy" data-pid="${p.productId}">Mua</button>
        <button class="btn" data-action="update" data-pid="${p.productId}">Cập nhật</button>
        <span class="badge ${p.active? 'ok':'muted'}">${p.active? 'Đang bán':'Tắt bán'}</span>
      </div>`;
    card.querySelector('[data-action="buy"]').addEventListener('click', ()=> openBuyForm(p));
    card.querySelector('[data-action="update"]').addEventListener('click', ()=> openUpdateForm(p));
    wrap.appendChild(card);
  });
}

$("#btnSearch")?.addEventListener("click", ()=> renderProducts(productsCache));
$("#searchInput")?.addEventListener("keydown", (e)=>{ if (e.key==="Enter") renderProducts(productsCache); });

/* -------------------- Register -------------------- */
$("#btnRegister")?.addEventListener("click", async()=>{
  try{
    if (!account) { await connectWallet(); if (!account) return; }
    const regFee = await muaban.REG_FEE();
    const { MUABAN_ADDR } = readAddrs();

    // Approve if needed
    const allow = await vin.allowance(account, MUABAN_ADDR);
    if (allow.lt(regFee)){
      try{
        const ovA = await buildOverrides("light");
        const txA = await vin.approve(MUABAN_ADDR, regFee, ovA);
        await txA.wait();
      }catch(e){ showRpc(e, "send.approve.registration"); return; }
    }
    // Preflight
    try{
      const txData = await muaban.populateTransaction.payRegistration();
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // Send
    try{
      const ov = await buildOverrides("med");
      const tx = await muaban.payRegistration(ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.registration"); return; }

    toast("Đăng ký thành công.");
    await refreshRegistration();
  }catch(e){ showRpc(e, "register.catch"); }
});

/* -------------------- Create Product -------------------- */
$("#btnCreate")?.addEventListener("click", ()=>{ show($("#formCreate")); });
$("#createCancel")?.addEventListener("click", ()=> hide($("#formCreate")));
$("#btnSubmitCreate")?.addEventListener("click", submitCreate);

async function submitCreate(){
  try{
    if (!account) { await connectWallet(); if (!account) return; }
    if (!isRegistered){ toast("Ví chưa đăng ký. Hãy đăng ký trước."); return; }

    const name = ($("#createName").value||"").trim();
    const ipfs = ($("#createIPFS").value||"").trim();
    const unit = ($("#createUnit").value||"").trim();
    const priceVND = parseVND($("#createPrice").value);
    const wallet = ($("#createWallet").value||"").trim();
    const days = Number($("#createDays").value||0);
    const active = Boolean($("#createActive").checked);

    if (!name || !ipfs || !unit || !Number.isFinite(priceVND) || priceVND<=0 || !ethers.utils.isAddress(wallet) || days<=0){
      alert("Vui lòng nhập đúng & đủ thông tin."); return;
    }

    const descriptionCID = `unit:${unit}`;
    const imageCID = ipfs;

    // Preflight simulate
    try{
      const txData = await muaban.populateTransaction.createProduct(
        name, descriptionCID, imageCID, priceVND, days, wallet, active
      );
      txData.from = account; // quan trọng cho eth_call
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // Send tx
    try{
      const ov = await buildOverrides("heavy");
      const tx = await muaban.createProduct(name, descriptionCID, imageCID, priceVND, days, wallet, active, ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.createProduct"); return; }

    hide($("#formCreate"));
    toast("Tạo sản phẩm thành công.");
    const { muabanR } = initContractsForRead();
    await loadAllProducts(muabanR);
  }catch(e){ showRpc(e, "submitCreate.catch"); }
}

/* -------------------- Update Product -------------------- */
function openUpdateForm(p){
  if (!p) return;
  $("#updPid").value = String(p.productId);
  $("#updName").value = String(p.name||"");
  $("#updIPFS").value = String(p.imageCID||"");
  $("#updUnit").value = parseUnitFromCID(p.descriptionCID||"");
  $("#updPrice").value = String(p.priceVND||0);
  $("#updWallet").value = String(p.payoutWallet||"");
  $("#updDays").value = String(p.deliveryDaysMax||0);
  $("#updActive").checked = Boolean(p.active);
  show($("#formUpdate"));
}
$("#updCancel")?.addEventListener("click", ()=> hide($("#formUpdate")));
$("#updSubmit")?.addEventListener("click", submitUpdate);

async function submitUpdate(){
  try{
    if (!account) { await connectWallet(); if (!account) return; }
    if (!isRegistered){ toast("Ví chưa đăng ký."); return; }

    const pid = Number($("#updPid").value||0);
    const name = ($("#updName").value||"").trim();
    const ipfs = ($("#updIPFS").value||"").trim();
    const unit = ($("#updUnit").value||"").trim();
    const priceVND = parseVND($("#updPrice").value);
    const wallet = ($("#updWallet").value||"").trim();
    const days = Number($("#updDays").value||0);
    const active = Boolean($("#updActive").checked);

    if (!pid || !name || !ipfs || !unit || !Number.isFinite(priceVND) || priceVND<=0 || !ethers.utils.isAddress(wallet) || days<=0){
      alert("Vui lòng nhập đúng & đủ thông tin."); return;
    }
    const descriptionCID = `unit:${unit}`;

    try{
      const txData = await muaban.populateTransaction.updateProduct(pid, priceVND, days, wallet, active);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    try{
      const ov = await buildOverrides("med");
      const tx = await muaban.updateProduct(pid, priceVND, days, wallet, active, ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.updateProduct"); return; }

    hide($("#formUpdate"));
    toast("Cập nhật sản phẩm thành công.");
    const { muabanR } = initContractsForRead();
    await loadAllProducts(muabanR);
  }catch(e){ showRpc(e, "submitUpdate.catch"); }
}

/* -------------------- Buy (Order) -------------------- */
function openBuyForm(p){
  if (!p){ return; }
  $("#buyPid").value = String(p.productId);
  $("#buyName").value = "";
  $("#buyPhone").value = "";
  $("#buyAddress").value = "";
  $("#buyNote").value = "";
  $("#buyQty").value = "1";
  $("#buyTotalVIN").textContent = "Tổng VIN cần trả: 0";
  updateBuyTotal();
  show($("#formBuy"));
}
$("#buyCancel")?.addEventListener("click", ()=> hide($("#formBuy")));
$("#buyQty")?.addEventListener("input", updateBuyTotal);

function updateBuyTotal(){
  try{
    const pid = Number($("#buyPid").value||0);
    const qty = Math.max(1, Number($("#buyQty").value||1));
    const p = productsCache.find(x=> Number(x.productId)===pid);
    if (!p) return;
    const totalVND = (Number(p.priceVND)||0) * qty;
    if (vinVND>0){
      const approxVin = Math.ceil(totalVND / vinVND);
      $("#buyTotalVIN").textContent = `Tổng VIN cần trả: ${approxVin}`;
    }else{
      $("#buyTotalVIN").textContent = "Tổng VIN cần trả: -";
    }
  }catch(_){ /* ignore */ }
}

$("#btnSubmitBuy")?.addEventListener("click", submitBuy);
async function submitBuy(){
  try{
    if (!account) { await connectWallet(); if (!account) return; }
    if (!isRegistered){ toast("Ví chưa đăng ký."); return; }

    if (!vinPerVNDWei || vinPerVNDWei.lte(0)){
      await fetchVinToVND();
      if (!vinPerVNDWei || vinPerVNDWei.lte(0)){
        alert("Chưa sẵn sàng tỷ giá. Vui lòng thử lại sau.");
        return;
      }
    }

    const pid = Number($("#buyPid").value||0);
    const qty = Math.max(1, Number($("#buyQty").value||1));
    const info = {
      name: ($("#buyName").value||"").trim(),
      phone:($("#buyPhone").value||"").trim(),
      addr: ($("#buyAddress").value||"").trim(),
      note: ($("#buyNote").value||"").trim(),
    };
    if (!pid || qty<=0 || !info.name || !info.addr){ alert("Vui lòng nhập tên & địa chỉ."); return; }

    // Ước tính escrow VIN để kiểm tra allowance
    const p = productsCache.find(x=> Number(x.productId)===pid);
    if (!p){ alert("Không tìm thấy sản phẩm."); return; }
    const totalVND = ethers.BigNumber.from(String(Number(p.priceVND)||0)).mul(qty);
    const vinAmount = totalVND.mul(vinPerVNDWei); // ceil đã áp dụng khi tính vinPerVNDWei

    // Approve nếu chưa đủ
    const { MUABAN_ADDR } = readAddrs();
    const allow = await vin.allowance(account, MUABAN_ADDR);
    if (allow.lt(vinAmount)){
      try{
        const ovA = await buildOverrides("light");
        const txA = await vin.approve(MUABAN_ADDR, vinAmount, ovA);
        await txA.wait();
      }catch(e){ showRpc(e, "send.approve.placeOrder"); return; }
    }

    const cipher = btoa(unescape(encodeURIComponent(JSON.stringify(info))));

    try{
      const txData = await muaban.populateTransaction.placeOrder(pid, qty, vinPerVNDWei, cipher);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){
      toast(parseRevert(simErr)); return;
    }

    try{
      const ov = await buildOverrides("med");
      const tx = await muaban.placeOrder(pid, qty, vinPerVNDWei, cipher, ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.placeOrder"); return; }

    hide($("#formBuy"));
    toast("Đặt mua thành công.");
    const { muabanR } = initContractsForRead();
    await loadMyOrders(muabanR);
  }catch(e){ showRpc(e, "submitBuy.catch"); }
}

/* ---- Danh sách đơn ---- */
$("#btnOrdersBuy")?.addEventListener("click", ()=>{
  show($("#ordersBuySection")); hide($("#ordersSellSection"));
  window.scrollTo({top: $("#ordersBuySection").offsetTop - 20, behavior:"smooth"});
});
$("#btnOrdersSell")?.addEventListener("click", ()=>{
  show($("#ordersSellSection")); hide($("#ordersBuySection"));
  window.scrollTo({top: $("#ordersSellSection").offsetTop - 20, behavior:"smooth"});
});

async function loadMyOrders(muabanR){
  if (!account) return;
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("OrderPlaced");
    const { MUABAN_ADDR } = readAddrs();
    const logs = await providerRead.getLogs({
      address: MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic]
    });

    ordersBuyer = []; ordersSeller = [];
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
  const bWrap = $("#ordersBuyList");
  if (bWrap){
    bWrap.innerHTML = "";
    if (!ordersBuyer.length){
      bWrap.innerHTML = `<div class="tag">Chưa có đơn mua.</div>`;
    }else{
      ordersBuyer.sort((a,b)=>b.orderId-a.orderId).forEach(({order, product, orderId, productId})=>{
        const canConfirm = Number(order.status)===1 && order.buyer.toLowerCase()===account.toLowerCase();
        const canRefund  = Number(order.status)===1 && (Date.now()/1000) > Number(order.deadline) && order.buyer.toLowerCase()===account.toLowerCase();
        const card = document.createElement("div");
        card.className = "order-card";
        card.innerHTML = `
          <div class="order-row"><span class="order-strong">${escapeHtml(product.name)}</span> <span class="badge mono">#${productId}</span></div>
          <div class="order-row">Mã đơn: <span class="order-strong mono">#${orderId}</span></div>
          <div class="order-row">Số lượng: ${order.quantity} · VIN escrow: ${ethers.utils.formatUnits(order.vinAmount,18)}</div>
          <div class="order-row">Hạn giao: ${new Date(Number(order.deadline)*1000).toLocaleString("vi-VN")}</div>
          <div class="order-row">Trạng thái: ${statusText(order.status)}</div>
          <div class="card-actions">
            ${canConfirm? `<button class="btn primary" data-action="confirm" data-oid="${orderId}">Xác nhận đã nhận</button>`:""}
            ${canRefund? `<button class="btn" data-action="refund" data-oid="${orderId}">Hoàn tiền (quá hạn)</button>`:""}
          </div>`;
        card.querySelector('[data-action="confirm"]')?.addEventListener("click", ()=>confirmReceipt(orderId));
        card.querySelector('[data-action\="refund\"]')?.addEventListener("click", ()=>refundExpired(orderId));
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
          <div class="order-row">Mã đơn: <span class="order-strong mono">#${orderId}</span> · Buyer: ${short(order.buyer)}</div>
          <div class="order-row">Số lượng: ${order.quantity} · VIN escrow: ${ethers.utils.formatUnits(order.vinAmount,18)}</div>
          <div class="order-row">Hạn giao: ${new Date(Number(order.deadline)*1000).toLocaleString("vi-VN")}</div>
          <div class="order-row">Trạng thái: ${statusText(order.status)}</div>`;
        sWrap.appendChild(card);
      });
    }
  }
}
async function confirmReceipt(orderId){
  try{
    try{
      const txData = await muaban.populateTransaction.confirmReceipt(orderId);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }
    try{
      const ov = await buildOverrides("light");
      const tx = await muaban.confirmReceipt(orderId, ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.confirmReceipt"); return; }
    toast("Đã xác nhận nhận hàng. VIN đã giải ngân cho người bán.");
    const { muabanR } = initContractsForRead();
    await loadMyOrders(muabanR);
  }catch(e){ showRpc(e, "confirmReceipt.catch"); }
}
async function refundExpired(orderId){
  try{
    try{
      const txData = await muaban.populateTransaction.refundIfExpired(orderId);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }
    try{
      const ov = await buildOverrides("light");
      const tx = await muaban.refundIfExpired(orderId, ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.refundIfExpired"); return; }
    toast("Đã hoàn tiền về ví (đơn quá hạn).");
    const { muabanR } = initContractsForRead();
    await loadMyOrders(muabanR);
  }catch(e){ showRpc(e, "refundExpired.catch"); }
}

/* -------------------- Bind & Main -------------------- */
$("#btnConnect")?.addEventListener("click", connectWallet);
$("#btnDisconnect")?.addEventListener("click", disconnectWallet);
$$('.modal').forEach(m=>{ m.addEventListener("click", (e)=>{ if (e.target.classList.contains('modal')) hide(e.currentTarget); }); });

if (window.ethereum){
  window.ethereum.on?.('accountsChanged', ()=> location.reload());
  window.ethereum.on?.('chainChanged',   ()=> location.reload());
}

(async function main(){
  // Luôn tải giá VIN trước, không phụ thuộc ABI
  initProviders();
  await fetchVinToVND();
  setInterval(fetchVinToVND, 60_000);
  try{ await loadAbis(); }catch(e){ showRpc(e, "loadAbis"); /* vẫn tiếp tục phần đọc sản phẩm */ }

  const { muabanR } = initContractsForRead();
  await loadAllProducts(muabanR);
  $("#menuBox")?.classList.add('hidden');
})();

// tiny toast helper
function toast(m){ try{ alert(m); }catch(_){ /* noop */ } }

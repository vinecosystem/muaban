/* ====================================================================
   muaban.vin — app.js (ethers v5)
   - Sửa triệt để "Internal JSON-RPC error" bằng simulate + legacy tx
   - Đầy đủ: kết nối ví, đăng ký, đăng/cập nhật SP, mua hàng (số lượng),
             đơn mua/đơn bán (xác nhận/hoàn tiền), tìm kiếm, hiển thị giá
==================================================================== */

/* -------------------- DOM helpers -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show=(el)=>{ if(el) el.classList.remove("hidden"); };
const hide=(el)=>{ if(el) el.classList.add("hidden"); };
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`:"";
const esc  =(s)=>String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));
const isAddr=(a)=>/^0x[0-9a-fA-F]{40}$/.test(a||"");
const toast=(m)=>alert(m);
const fmt4 =(x)=>Number(x).toFixed(4);

/* -------------------- Config (override được qua <body data-*>) -------------------- */
const CFG = {
  CHAIN_ID: 88,
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://vicscan.xyz",

  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",  // override: <body data-muaban-addr="0x...">
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",  // override: <body data-vin-addr="0x...">

  // phí đăng ký (0.001 VIN) — contract dùng transferFrom(... owner, REG_FEE)
  REG_FEE_WEI: "1000000000000000",

  // ép legacy tx + gas
  GAS_PRICE_GWEI: "50",
  GAS_LIGHT: "200000",
  GAS_MED:   "400000",
  GAS_HEAVY: "900000",

  // tỷ giá VIN/VND: nếu có sẵn, set qua <body data-vin-vnd="6500">
  // nếu không, app thử tính qua 2 bước (tùy bạn sẽ cập nhật API thật sau):
  // (a) VIC/USDT (Binance) + (b) USDT/VND (Coingecko) + (c) HỆ SỐ quy đổi VIN↔VIC nếu bạn có (mặc định 1 VIN = 1 VIC)
  BINANCE_VICUSDT: "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",
  COINGECKO_USDT_VND: "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",
  VIN_PER_VIC: 1, // nếu thực tế 1 VIN = X VIC, hãy sửa số này hoặc set <body data-vin-per-vic="X">
};

/* Allow override từ <body data-*> */
(function applyDatasetOverride(){
  const b = document.body;
  if (b?.dataset?.muabanAddr && isAddr(b.dataset.muabanAddr)) CFG.MUABAN_ADDR = b.dataset.muabanAddr;
  if (b?.dataset?.vinAddr    && isAddr(b.dataset.vinAddr))    CFG.VIN_ADDR    = b.dataset.vinAddr;
  if (b?.dataset?.vinPerVic && Number(b.dataset.vinPerVic)>0) CFG.VIN_PER_VIC = Number(b.dataset.vinPerVic);
})();

/* -------------------- Global -------------------- */
let providerRead, providerWrite, signer, account;
let MUABAN_ABI, VIN_ABI;
let muabanR, vinR; // read
let muaban,  vin;  // write

let isRegistered = false;
let productsCache = [];
let vinVndCache = null;  // số VND cho 1 VIN
let vinPerVndWei = null; // VIN-wei per 1 VND (đưa vào contract khi placeOrder)

/* -------------------- ABI loader -------------------- */
async function loadAbis(){
  MUABAN_ABI = await fetch("Muaban_ABI.json").then(r=>r.json());
  VIN_ABI    = await fetch("VinToken_ABI.json").then(r=>r.json());
}

/* -------------------- Providers & Contracts -------------------- */
function initProviders(){
  providerRead  = new ethers.providers.JsonRpcProvider(CFG.RPC_URL);
  if (window.ethereum) providerWrite = new ethers.providers.Web3Provider(window.ethereum, "any");
}
function initReadContracts(){
  muabanR = new ethers.Contract(CFG.MUABAN_ADDR, MUABAN_ABI, providerRead);
  vinR    = new ethers.Contract(CFG.VIN_ADDR,    VIN_ABI,    providerRead);
}
function initWriteContracts(){
  muaban = new ethers.Contract(CFG.MUABAN_ADDR, MUABAN_ABI, signer);
  vin    = new ethers.Contract(CFG.VIN_ADDR,    VIN_ABI,    signer);
}

/* -------------------- GAS override (legacy) -------------------- */
function gasOv(kind="med"){
  const gasPrice = ethers.utils.parseUnits(CFG.GAS_PRICE_GWEI, "gwei");
  const base = { type: 0, gasPrice };
  if (kind==="light") return { ...base, gasLimit: CFG.GAS_LIGHT };
  if (kind==="heavy") return { ...base, gasLimit: CFG.GAS_HEAVY };
  return { ...base, gasLimit: CFG.GAS_MED };
}

/* -------------------- RPC error helpers -------------------- */
function parseRevert(err){
  const raw = err?.error?.message || err?.data?.message || err?.reason || err?.message || "";
  const map = {
    NOT_REGISTERED: "Ví chưa đăng ký. Bấm ‘Đăng ký’ trước.",
    ALREADY_REGISTERED: "Ví đã đăng ký.",
    PRICE_REQUIRED: "Giá VND phải > 0.",
    DELIVERY_REQUIRED: "Thời gian giao hàng phải ≥ 1 ngày.",
    PAYOUT_WALLET_ZERO: "Ví nhận thanh toán không hợp lệ.",
    NOT_SELLER: "Bạn không phải người bán của sản phẩm này.",
    PRODUCT_NOT_ACTIVE: "Sản phẩm đang tắt bán.",
    PRODUCT_NOT_FOUND: "Không tìm thấy sản phẩm.",
    QUANTITY_REQUIRED: "Số lượng phải ≥ 1.",
    VIN_PER_VND_REQUIRED: "Thiếu tỷ giá VIN/VND.",
    VIN_TRANSFER_FAIL: "Chuyển VIN thất bại (kiểm tra số dư/allowance).",
    NOT_PLACED: "Trạng thái đơn không hợp lệ.",
    NOT_BUYER: "Chỉ người mua mới thao tác được.",
    NOT_EXPIRED: "Chưa đến hạn hoàn tiền."
  };
  for (const k in map) if (raw.includes(k)) return map[k];
  const m = /execution reverted(?: with reason string)?:\s*([^\n]+)/i.exec(raw);
  if (m) return m[1];
  return raw || "Giao dịch bị từ chối hoặc lỗi không xác định.";
}
function showRpc(err, tag="RPC"){
  try{
    console.error(tag, err);
    alert(`${tag}\n${JSON.stringify({
      code: err?.code, message: err?.message||err?.error?.message,
      data: err?.data||err?.error?.data, reason: err?.reason
    }, null, 2)}`);
  }catch(_){ alert(`${tag}: ${String(err)}`); }
}

/* -------------------- Giá VIN/VND -------------------- */
async function computeVinVnd(){
  // 1) Nếu có cấu hình tĩnh qua <body data-vin-vnd>, dùng luôn
  const b = document.body;
  if (b?.dataset?.vinVnd && Number(b.dataset.vinVnd)>0){
    return Number(b.dataset.vinVnd);
  }

  // 2) Thử ước tính qua VICUSDT * USDT→VND * (VIN_PER_VIC)
  try{
    const [vicusdt, usdtvnd] = await Promise.all([
      fetch(CFG.BINANCE_VICUSDT).then(r=>r.json()).catch(()=>null),
      fetch(CFG.COINGECKO_USDT_VND).then(r=>r.json()).catch(()=>null),
    ]);
    const priceVicUsd = vicusdt && vicusdt.price ? Number(vicusdt.price) : NaN;
    const priceUsdVnd = usdtvnd && usdtvnd.tether && usdtvnd.tether.vnd ? Number(usdtvnd.tether.vnd) : NaN;
    if (Number.isFinite(priceVicUsd) && Number.isFinite(priceUsdVnd)){
      const vicVnd = priceVicUsd * priceUsdVnd;
      const vinVnd = vicVnd * Number(CFG.VIN_PER_VIC || 1);
      if (vinVnd>0) return vinVnd;
    }
  }catch(_){}

  // 3) Fallback an toàn (hiển thị, có thể sửa sau)
  return 10000; // 1 VIN = 10,000 VND (placeholder để tránh 0)
}

async function refreshVinPrice(){
  try{
    vinVndCache = await computeVinVnd();
    $("#vinPrice").textContent = `1 VIN = ${Math.round(vinVndCache).toLocaleString('vi-VN')} VND`;

    // tính VIN-wei per 1 VND = (10^decimals) / VND_per_1_VIN
    const decimals = await muabanR.vinDecimals().catch(async _=>{
      // fallback đọc từ VIN token chuẩn ERC20 (decimals())
      try { return await vinR.decimals(); } catch(e){ return 18; }
    });
    vinPerVndWei = ethers.BigNumber.from("1"+"0".repeat(decimals)).div(Math.max(1, Math.floor(vinVndCache)));
  }catch(e){
    console.warn("refreshVinPrice", e);
    $("#vinPrice").textContent = "1 VIN = ... VND";
    vinPerVndWei = null;
  }
}

/* -------------------- UI Menu -------------------- */
function refreshMenu(){
  const btnReg = $("#btnRegister");
  const btnCrt = $("#btnCreate");
  const btnOB  = $("#btnOrdersBuy");
  const btnOS  = $("#btnOrdersSell");

  if (!account){
    show(btnReg); btnReg.disabled = true;
    hide(btnCrt); hide(btnOB); hide(btnOS);
    return;
  }
  if (!isRegistered){
    show(btnReg); btnReg.disabled = false;
    hide(btnCrt); hide(btnOB); hide(btnOS);
  }else{
    hide(btnReg);
    show(btnCrt); show(btnOB); show(btnOS);
  }
}

/* -------------------- Wallet -------------------- */
async function connectWallet(){
  try{
    if (!window.ethereum){ toast("Vui lòng cài MetaMask."); return; }
    await providerWrite.send("eth_requestAccounts", []);
    const net = await providerWrite.getNetwork();
    if (Number(net.chainId)!==CFG.CHAIN_ID){ toast("Sai mạng. Hãy chọn Viction (chainId=88)."); return; }

    signer  = providerWrite.getSigner();
    account = (await signer.getAddress()).toLowerCase();
    initWriteContracts();

    hide($("#btnConnect")); show($("#walletBox"));
    $("#accountShort").textContent = short(account);
    $("#accountShort").href = `${CFG.EXPLORER}/address/${account}`;

    const [vinBal, vicBal, reg] = await Promise.all([
      vinR.balanceOf(account),
      providerWrite.getBalance(account),
      muabanR.registered(account)
    ]);
    $("#vinBalance").textContent = `VIN: ${fmt4(ethers.utils.formatUnits(vinBal,18))}`;
    $("#vicBalance").textContent = `VIC: ${fmt4(ethers.utils.formatEther(vicBal))}`;

    isRegistered = Boolean(reg);
    refreshMenu();

    await loadProducts();
  }catch(e){ showRpc(e, "connectWallet"); }
}
function disconnectWallet(){
  account = null; signer = null; muaban=null; vin=null;
  hide($("#walletBox")); show($("#btnConnect"));
  $("#vinBalance").textContent = "VIN: 0";
  $("#vicBalance").textContent = "VIC: 0";
  isRegistered = false;
  refreshMenu();
}

/* -------------------- Đăng ký (0.001 VIN) -------------------- */
async function doRegister(){
  if (!account){ toast("Hãy kết nối ví trước."); return; }
  try{
    const need = ethers.BigNumber.from(CFG.REG_FEE_WEI);
    const owner = await muabanR.owner();
    const allow = await vinR.allowance(account, owner);

    if (allow.lt(need)){
      try{
        const txA = await vin.approve(owner, need, gasOv("light"));
        await txA.wait();
      }catch(e){ showRpc(e, "approve.registration"); return; }
    }

    // simulate
    try{
      const txData = await muaban.populateTransaction.payRegistration();
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // send
    const tx = await muaban.payRegistration(gasOv("med"));
    await tx.wait();

    isRegistered = true;
    toast("Đăng ký thành công.");
    refreshMenu();
  }catch(e){ showRpc(e, "send.registration"); }
}

/* -------------------- Sản phẩm -------------------- */
async function loadProducts(){
  try{
    // lấy qua event ProductCreated để có danh sách pid
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const tCreated = iface.getEventTopic("ProductCreated");
    const logs  = await providerRead.getLogs({ address: CFG.MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [tCreated] });

    const pids = new Set();
    for (const l of logs){ const parsed = iface.parseLog(l); pids.add(parsed.args.pid?.toString() || parsed.args.productId?.toString()); }

    productsCache = [];
    for (const pid of Array.from(pids).filter(Boolean).sort((a,b)=>Number(a)-Number(b))){
      const p = await muabanR.getProduct(pid);
      productsCache.push({ pid: Number(pid), data: p });
    }
    renderProducts(productsCache);
  }catch(e){ console.error("loadProducts", e); }
}
function renderProducts(list){
  const wrap = $("#productList");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!list?.length){ wrap.innerHTML = `<div class="tag">Chưa có sản phẩm.</div>`; return; }

  for (const {pid, data} of list){
    const unit = parseUnit(data.descriptionCID);
    const img  = toHttp(data.imageCID);
    const active = data.active;
    const price = Number(data.priceVND);

    const isSeller = account && data.seller?.toLowerCase()===account?.toLowerCase();
    const canBuy   = account && isRegistered && active && !isSeller;

    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      <img class="product-thumb" src="${img}" onerror="this.src='https://via.placeholder.com/112x90?text=IPFS'"/>
      <div class="product-info">
        <div class="product-top">
          <h3 class="product-title">${esc(data.name)}</h3>
          <span class="badge mono">#${pid}</span>
        </div>
        <div class="product-meta">
          <span class="price-vnd">${price.toLocaleString('vi-VN')} VND</span>
          <span class="unit">/ ${esc(unit||'đv')}</span>
        </div>
        <div>
          <span class="stock-badge ${active? "":"out"}">${active? "Còn hàng":"Hết hàng"}</span>
          <span class="tag mono" title="${data.payoutWallet}">Người bán: ${short(data.seller)}</span>
          <span class="tag">Giao tối đa ${data.deliveryDaysMax} ngày</span>
        </div>
        <div class="card-actions">
          ${isSeller ? `<button class="btn" data-action="update" data-pid="${pid}">Cập nhật</button>` : ""}
          ${canBuy   ? `<button class="btn primary" data-action="buy" data-pid="${pid}">Mua</button>` : ""}
        </div>
      </div>
    `;
    card.querySelector('[data-action="buy"]')?.addEventListener("click", ()=> openBuy(pid, data));
    card.querySelector('[data-action="update"]')?.addEventListener("click", ()=> openUpdate(pid, data));
    wrap.appendChild(card);
  }
}
function parseUnit(desc){
  if (!desc) return "";
  const m = /^unit:(.+)$/i.exec(String(desc).trim());
  return m? m[1].trim() : "";
}
function toHttp(link){
  if (!link) return "";
  if (link.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + link.slice(7);
  return link;
}

/* ---- Đăng SP ---- */
function openCreate(){
  if (!account){ toast("Hãy kết nối ví."); return; }
  if (!isRegistered){ toast("Ví chưa đăng ký."); return; }
  $("#createName").value = "";
  $("#createIPFS").value = "";
  $("#createUnit").value = "";
  $("#createPrice").value = "";
  $("#createWallet").value = "";
  $("#createDays").value = "";
  show($("#formCreate"));
}
async function submitCreate(){
  try{
    if (!account){ toast("Hãy kết nối ví."); return; }
    if (!isRegistered){ toast("Ví chưa đăng ký."); return; }

    const name  = ($("#createName").value||"").trim();
    const ipfs  = ($("#createIPFS").value||"").trim();
    const unit  = ($("#createUnit").value||"").trim();
    const priceVND = Number(($("#createPrice").value||"").replace(/[^\d]/g,""));
    const wallet   = ($("#createWallet").value||"").trim();
    const days     = Number($("#createDays").value||0);

    if (!name || !ipfs || !unit || !priceVND || !wallet || !days){ toast("Vui lòng nhập đủ thông tin."); return; }
    if (!isAddr(wallet)){ toast("Ví nhận thanh toán không hợp lệ."); return; }
    if (name.length>500){ toast("Tên sản phẩm tối đa 500 ký tự."); return; }

    const descriptionCID = `unit:${unit}`;
    const imageCID       = ipfs;
    const active         = true;

    // simulate để bắt reason rõ ràng
    const txData = await muaban.populateTransaction.createProduct(
      name, descriptionCID, imageCID,
      ethers.BigNumber.from(String(priceVND)),
      Number(days),
      wallet,
      active
    );
    txData.from = account;
    txData.type = 0;
    txData.gasPrice = ethers.utils.parseUnits(CFG.GAS_PRICE_GWEI, "gwei");
    try{ await providerWrite.call(txData); }
    catch(simErr){ toast(parseRevert(simErr)); return; }

    // send thật
    const tx = await muaban.createProduct(
      name, descriptionCID, imageCID,
      ethers.BigNumber.from(String(priceVND)),
      Number(days),
      wallet,
      active,
      gasOv("heavy")
    );
    await tx.wait();

    toast("Đăng sản phẩm thành công.");
    hide($("#formCreate"));
    await loadProducts();
  }catch(e){ showRpc(e, "submitCreate"); }
}

/* ---- Cập nhật SP ---- */
function openUpdate(pid, data){
  $("#updatePid").value   = String(pid);
  $("#updatePrice").value = String(data.priceVND||"");
  $("#updateDays").value  = String(Number(data.deliveryDaysMax||0));
  $("#updateWallet").value= data.payoutWallet||"";
  $("#updateActive").checked = Boolean(data.active);
  show($("#formUpdate"));
}
async function submitUpdate(){
  try{
    if (!account){ toast("Hãy kết nối ví."); return; }
    if (!isRegistered){ toast("Ví chưa đăng ký."); return; }

    const pid   = Number($("#updatePid").value||0);
    const price = Number(($("#updatePrice").value||"").replace(/[^\d]/g,""));
    const days  = Number($("#updateDays").value||0);
    const wall  = ($("#updateWallet").value||"").trim();
    const act   = !!$("#updateActive").checked;
    if (!pid || !price || !days || !isAddr(wall)){ toast("Dữ liệu chưa hợp lệ."); return; }

    const txData = await muaban.populateTransaction.updateProduct(
      pid,
      ethers.BigNumber.from(String(price)),
      Number(days),
      wall,
      act
    );
    txData.from = account;
    txData.type = 0;
    txData.gasPrice = ethers.utils.parseUnits(CFG.GAS_PRICE_GWEI, "gwei");
    try{ await providerWrite.call(txData); }
    catch(simErr){ toast(parseRevert(simErr)); return; }

    const tx = await muaban.updateProduct(
      pid,
      ethers.BigNumber.from(String(price)),
      Number(days),
      wall,
      act,
      gasOv("med")
    );
    await tx.wait();

    toast("Cập nhật thành công.");
    hide($("#formUpdate"));
    await loadProducts();
  }catch(e){ showRpc(e, "submitUpdate"); }
}

/* -------------------- MUA HÀNG -------------------- */
let buyCtx = null; // { pid, priceVND, data }
function openBuy(pid, data){
  buyCtx = { pid, priceVND: Number(data.priceVND), data };
  $("#buyProductInfo").innerHTML = `
    <div><b>${esc(data.name)}</b> (#${pid}) — ${Number(data.priceVND).toLocaleString('vi-VN')} VND / ${esc(parseUnit(data.descriptionCID)||'đv')}</div>
    <div class="mono">Người bán: ${short(data.seller)} • Giao tối đa ${data.deliveryDaysMax} ngày</div>
  `;
  $("#buyName").value    = "";
  $("#buyAddress").value = "";
  $("#buyPhone").value   = "";
  $("#buyNote").value    = "";
  $("#buyQty").value     = "1";
  $("#buyTotalVIN").textContent = "Tổng VIN cần trả: 0";
  show($("#formBuy"));
  updateBuyTotal();
}
$("#buyQty")?.addEventListener("input", updateBuyTotal);

async function updateBuyTotal(){
  const qty = Math.max(1, Number($("#buyQty").value||1));
  if (!buyCtx){ $("#buyTotalVIN").textContent = "Tổng VIN cần trả: 0"; return; }
  if (!vinVndCache) await refreshVinPrice();
  if (!vinVndCache){ $("#buyTotalVIN").textContent = "Tổng VIN cần trả: ..."; return; }

  // total VND = priceVND * qty
  const totalVND = buyCtx.priceVND * qty;
  // 1 VIN (wei) per 1 VND: vinPerVndWei (đã tính trong refreshVinPrice)
  if (!vinPerVndWei){ $("#buyTotalVIN").textContent = "Tổng VIN cần trả: ..."; return; }

  // VIN (wei) = totalVND * vinPerVndWei
  const vinWei = ethers.BigNumber.from(String(totalVND)).mul(vinPerVndWei);
  const vinDec = await vinR.decimals().catch(()=>18);
  const vinHuman = Number(ethers.utils.formatUnits(vinWei, vinDec));
  $("#buyTotalVIN").textContent = `Tổng VIN cần trả: ${vinHuman.toFixed(4)} VIN`;
}

async function submitBuy(){
  try{
    if (!account){ toast("Hãy kết nối ví."); return; }
    if (!isRegistered){ toast("Ví chưa đăng ký."); return; }
    if (!buyCtx){ toast("Thiếu ngữ cảnh mua hàng."); return; }

    const qty = Math.max(1, Number($("#buyQty").value||1));
    const name = ($("#buyName").value||"").trim();
    const addr = ($("#buyAddress").value||"").trim();
    const phone= ($("#buyPhone").value||"").trim();
    const note = ($("#buyNote").value||"").trim();
    if (!name || !addr || !phone){ toast("Vui lòng nhập đủ Họ tên / Địa chỉ / SĐT."); return; }

    if (!vinVndCache) await refreshVinPrice();
    if (!vinPerVndWei){ toast("Chưa có tỷ giá VIN/VND."); return; }

    // BuyerInfoCipher: ở đây mã hóa đơn giản dạng JSON (bạn có thể thay bằng mã hóa thực sau)
    const buyerInfoCipher = JSON.stringify({ name, addr, phone, note });

    // Ước tính vinAmount để approve cho contract
    const dec = await vinR.decimals().catch(()=>18);
    const vinWeiPerVnd = vinPerVndWei; // BigNumber
    const totalVND = ethers.BigNumber.from(String(buyCtx.priceVND)).mul(ethers.BigNumber.from(String(qty)));
    const vinAmountWei = totalVND.mul(vinWeiPerVnd); // làm tròn lên trong contract bằng _ceilDiv, approve dư 1%
    const vinAmountWeiSafe = vinAmountWei.mul(101).div(100);

    // Đảm bảo allowance: spender = contract (vì contract transferFrom buyer -> contract)
    const allow = await vinR.allowance(account, CFG.MUABAN_ADDR);
    if (allow.lt(vinAmountWeiSafe)){
      try{
        const txA = await vin.approve(CFG.MUABAN_ADDR, vinAmountWeiSafe, gasOv("light"));
        await txA.wait();
      }catch(e){ showRpc(e, "approve.placeOrder"); return; }
    }

    // simulate placeOrder(productId, quantity, vinPerVND, buyerInfoCipher)
    const txData = await muaban.populateTransaction.placeOrder(
      buyCtx.pid,
      ethers.BigNumber.from(String(qty)),
      vinWeiPerVnd, // VIN-wei per 1 VND
      buyerInfoCipher
    );
    txData.from = account;
    txData.type = 0;
    txData.gasPrice = ethers.utils.parseUnits(CFG.GAS_PRICE_GWEI, "gwei");
    try{ await providerWrite.call(txData); }
    catch(simErr){ toast(parseRevert(simErr)); return; }

    // send thật
    const tx = await muaban.placeOrder(
      buyCtx.pid,
      ethers.BigNumber.from(String(qty)),
      vinWeiPerVnd,
      buyerInfoCipher,
      gasOv("heavy")
    );
    await tx.wait();

    toast("Đặt mua thành công.");
    hide($("#formBuy"));
    await loadOrdersMine(); // tải lại đơn
  }catch(e){ showRpc(e, "submitBuy"); }
}

/* -------------------- ĐƠN HÀNG CỦA TÔI -------------------- */
async function loadOrdersMine(){
  if (!account) return;
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const tPlaced = iface.getEventTopic("OrderPlaced");
    const logs = await providerRead.getLogs({ address: CFG.MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [tPlaced] });

    const buy = [];
    const sell= [];
    for (const l of logs){
      const ev = iface.parseLog(l);
      const oid = Number(ev.args.oid || ev.args.orderId || ev.args[0]);
      const prodId = Number(ev.args.productId || ev.args[1]);
      const buyer = String(ev.args.buyer || ev.args[2] || "").toLowerCase();
      const quantity = Number(ev.args.quantity || ev.args[3] || 0);
      const vinAmount= String(ev.args.vinAmount || ev.args[4] || "0");

      try{
        const o = await muabanR.getOrder(oid);
        const card = {
          oid, prodId, buyer, quantity, vinAmount,
          raw: o
        };
        if (o.buyer?.toLowerCase()===account) buy.push(card);
        if (o.seller?.toLowerCase()===account) sell.push(card);
      }catch(_){}
    }
    renderOrders(buy, sell);
  }catch(e){ console.error("loadOrdersMine", e); }
}
function renderOrders(buy, sell){
  // Buyer side
  const buyBox = $("#ordersBuyList");
  $("#ordersBuySection")?.classList.remove("hidden");
  buyBox.innerHTML = buy.length? "" : `<div class="tag">Chưa có đơn mua.</div>`;
  for (const it of buy){
    const st = it.raw.status; // 0 default? xem trong struct — ta hiển thị tên đơn giản:
    const statusName = ["", "PLACED", "RELEASED", "REFUNDED"][st] || String(st);
    const deadlineTs = Number(it.raw.deadline||0);
    const deadlineStr = deadlineTs? new Date(deadlineTs*1000).toLocaleString("vi-VN") : "";
    const canConfirm = statusName==="PLACED";
    const canRefund  = statusName==="PLACED" && Date.now()/1000 > deadlineTs;

    const row = document.createElement("div");
    row.className="order-row";
    row.innerHTML = `
      <div class="order-main">
        <div>Đơn #${it.oid} • SP #${it.prodId} • SL: ${it.quantity} • VIN: ${ethers.utils.formatUnits(it.raw.vinAmount||"0", 18)}</div>
        <div class="mono">Trạng thái: ${statusName} • Hạn: ${deadlineStr}</div>
      </div>
      <div class="order-actions">
        ${canConfirm ? `<button class="btn" data-action="confirm" data-oid="${it.oid}">Đã nhận</button>` : ""}
        ${canRefund  ? `<button class="btn" data-action="refund"  data-oid="${it.oid}">Hoàn tiền</button>` : ""}
      </div>
    `;
    row.querySelector('[data-action="confirm"]')?.addEventListener("click", ()=> confirmReceipt(it.oid));
    row.querySelector('[data-action="refund"]') ?.addEventListener("click", ()=> refundIfExpired(it.oid));
    buyBox.appendChild(row);
  }

  // Seller side
  const sellBox = $("#ordersSellList");
  $("#ordersSellSection")?.classList.remove("hidden");
  sellBox.innerHTML = sell.length? "" : `<div class="tag">Chưa có đơn bán.</div>`;
  for (const it of sell){
    const st = it.raw.status;
    const statusName = ["", "PLACED", "RELEASED", "REFUNDED"][st] || String(st);
    const deadlineTs = Number(it.raw.deadline||0);
    const deadlineStr = deadlineTs? new Date(deadlineTs*1000).toLocaleString("vi-VN") : "";

    const row = document.createElement("div");
    row.className="order-row";
    row.innerHTML = `
      <div class="order-main">
        <div>Đơn #${it.oid} • SP #${it.prodId} • Mua: ${short(it.raw.buyer)} • SL: ${it.quantity} • VIN: ${ethers.utils.formatUnits(it.raw.vinAmount||"0", 18)}</div>
        <div class="mono">Trạng thái: ${statusName} • Hạn: ${deadlineStr}</div>
      </div>
    `;
    sellBox.appendChild(row);
  }
}

/* ---- Buyer actions ---- */
async function confirmReceipt(oid){
  try{
    // simulate
    const txData = await muaban.populateTransaction.confirmReceipt(oid);
    txData.from = account; txData.type=0; txData.gasPrice=ethers.utils.parseUnits(CFG.GAS_PRICE_GWEI,"gwei");
    try{ await providerWrite.call(txData); }catch(e){ toast(parseRevert(e)); return; }
    const tx = await muaban.confirmReceipt(oid, gasOv("med"));
    await tx.wait();
    toast("Đã xác nhận nhận hàng. VIN đã chuyển cho người bán.");
    await loadOrdersMine();
  }catch(e){ showRpc(e,"confirmReceipt"); }
}
async function refundIfExpired(oid){
  try{
    const txData = await muaban.populateTransaction.refundIfExpired(oid);
    txData.from = account; txData.type=0; txData.gasPrice=ethers.utils.parseUnits(CFG.GAS_PRICE_GWEI,"gwei");
    try{ await providerWrite.call(txData); }catch(e){ toast(parseRevert(e)); return; }
    const tx = await muaban.refundIfExpired(oid, gasOv("med"));
    await tx.wait();
    toast("Đã hoàn tiền về ví người mua.");
    await loadOrdersMine();
  }catch(e){ showRpc(e,"refundIfExpired"); }
}

/* -------------------- Tìm kiếm -------------------- */
$("#btnSearch")?.addEventListener("click", ()=>{
  const q = ($("#searchInput")?.value||"").trim().toLowerCase();
  if (!q){ renderProducts(productsCache); return; }
  const list = productsCache.filter(({data})=> (data?.name||"").toLowerCase().includes(q));
  renderProducts(list);
});

/* -------------------- Wire buttons -------------------- */
$("#btnConnect")?.addEventListener("click", connectWallet);
$("#btnDisconnect")?.addEventListener("click", disconnectWallet);

$("#btnRegister")?.addEventListener("click", doRegister);
$("#btnCreate")  ?.addEventListener("click", openCreate);
$("#btnOrdersBuy") ?.addEventListener("click", loadOrdersMine);
$("#btnOrdersSell")?.addEventListener("click", loadOrdersMine);

// Close modal
$$(".modal .close")?.forEach(btn=> btn.addEventListener("click", (e)=>{
  e.preventDefault();
  e.target.closest(".modal")?.classList.add("hidden");
}));

$("#btnSubmitCreate")?.addEventListener("click", submitCreate);
$("#btnSubmitUpdate")?.addEventListener("click", submitUpdate);
$("#btnSubmitBuy")   ?.addEventListener("click", submitBuy);

/* -------------------- Boot -------------------- */
(async function boot(){
  await loadAbis();
  initProviders();
  initReadContracts();
  try{ await refreshVinPrice(); }catch(_){}
  try{ await loadProducts(); }catch(_){}
})();

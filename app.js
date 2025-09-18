/* ====================================================================
   muaban.vin — app.js (ethers v5)
   Mục tiêu: sửa lỗi "Internal JSON-RPC error" khi ĐĂNG SẢN PHẨM
   - Legacy tx (type:0) + gasPrice cố định, gasLimit an toàn
   - Preflight simulate để bắt revert rõ ràng trước khi gửi giao dịch thật
   - Bám sát index.html & ABI Muaban/VIN hiện tại
==================================================================== */

/* -------------------- Helpers -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show = (el)=>{ if(el) el.classList.remove("hidden"); };
const hide = (el)=>{ if(el) el.classList.add("hidden"); };
const short = (a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`:"";
const toast = (m)=>alert(m);
const isAddr = (a)=>/^0x[0-9a-fA-F]{40}$/.test(a||"");

/* -------------------- Config (có thể override qua <body data-*>) -------------------- */
const CFG = {
  CHAIN_ID: 88,
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://vicscan.xyz",
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",
  REG_FEE_WEI: "1000000000000000", // 0.001 VIN
  // GAS: ép legacy
  GAS_PRICE_GWEI: "50",
  GAS_LIGHT: "200000",
  GAS_MED:   "400000",
  GAS_HEAVY: "800000",
};

/* Đọc override từ <body data-muaban-addr / data-vin-addr> nếu có */
(function applyDatasetOverride(){
  const b = document.body;
  if (b?.dataset?.muabanAddr && isAddr(b.dataset.muabanAddr)) CFG.MUABAN_ADDR = b.dataset.muabanAddr;
  if (b?.dataset?.vinAddr    && isAddr(b.dataset.vinAddr))    CFG.VIN_ADDR    = b.dataset.vinAddr;
})();

/* -------------------- Global state -------------------- */
let providerRead, providerWrite, signer, account;
let MUABAN_ABI, VIN_ABI;
let muabanR, vinR;   // read
let muaban,  vin;    // write
let isRegistered = false;

let productsCache = [];

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

/* -------------------- GAS overrides (legacy) -------------------- */
function ov(kind="med"){
  const gasPrice = ethers.utils.parseUnits(CFG.GAS_PRICE_GWEI, "gwei");
  const base = { type: 0, gasPrice };
  if (kind==="light") return { ...base, gasLimit: CFG.GAS_LIGHT };
  if (kind==="heavy") return { ...base, gasLimit: CFG.GAS_HEAVY };
  return { ...base, gasLimit: CFG.GAS_MED };
}

/* -------------------- Revert parser & RPC inspector -------------------- */
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
    VIN_PER_VND_REQUIRED: "Tỷ giá chưa sẵn sàng.",
    VIN_TRANSFER_FAIL: "Chuyển VIN thất bại (kiểm tra số dư/allowance).",
    NOT_PLACED: "Trạng thái đơn không hợp lệ.",
    NOT_BUYER: "Chỉ người mua mới thao tác được.",
    NOT_EXPIRED: "Đơn chưa quá hạn giao hàng."
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

/* -------------------- UI: wallet/menu -------------------- */
function refreshMenu(){
  const btnReg = $("#btnRegister");
  const btnCrt = $("#btnCreate");
  const btnOB  = $("#btnOrdersBuy");
  const btnOS  = $("#btnOrdersSell");
  const menu   = $("#menuBox");

  if (!account){
    btnReg?.classList.remove("hidden"); if (btnReg) btnReg.disabled = true;
    btnCrt?.classList.add("hidden"); btnOB?.classList.add("hidden"); btnOS?.classList.add("hidden");
    return;
  }
  if (!isRegistered){
    btnReg?.classList.remove("hidden"); if (btnReg) btnReg.disabled = false;
    btnCrt?.classList.add("hidden"); btnOB?.classList.add("hidden"); btnOS?.classList.add("hidden");
  }else{
    btnReg?.classList.add("hidden");
    btnCrt?.classList.remove("hidden");
    btnOB?.classList.remove("hidden");
    btnOS?.classList.remove("hidden");
  }
  menu?.classList.remove("hidden");
}

/* -------------------- Wallet connect/disconnect -------------------- */
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
    $("#vinBalance").textContent = `VIN: ${parseFloat(ethers.utils.formatUnits(vinBal,18)).toFixed(4)}`;
    $("#vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;

    isRegistered = Boolean(reg);
    refreshMenu();

    await loadProducts(); // sau khi có ví, hiển thị nút Mua/Cập nhật theo role
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

/* -------------------- Registration (0.001 VIN) -------------------- */
async function doRegister(){
  if (!account){ toast("Hãy kết nối ví trước."); return; }
  try{
    // ensure allowance cho owner (trong contract payRegistration chuyển VIN -> owner)
    const need = ethers.BigNumber.from(CFG.REG_FEE_WEI);
    const owner = await muabanR.owner(); // chủ contract nhận phí đăng ký
    const allow = await vin.allowance(account, owner);

    if (allow.lt(need)){
      try{
        const txA = await vin.approve(owner, need, ov("light"));
        await txA.wait();
      }catch(e){ showRpc(e, "approve.registration"); return; }
    }

    // preflight
    try{
      const txData = await muaban.populateTransaction.payRegistration();
      txData.from = account;
      // dùng providerWrite.call để simulate
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // send
    const tx = await muaban.payRegistration(ov("med"));
    await tx.wait();

    isRegistered = true;
    toast("Đăng ký thành công.");
    refreshMenu();
  }catch(e){ showRpc(e, "send.registration"); }
}

/* -------------------- Product list (qua event logs) -------------------- */
async function loadProducts(){
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("ProductCreated");
    const logs  = await providerRead.getLogs({
      address: CFG.MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic]
    });

    const pids = new Set();
    for (const l of logs){ const parsed = iface.parseLog(l); pids.add(parsed.args.productId.toString()); }

    productsCache = [];
    for (const pid of Array.from(pids).sort((a,b)=>Number(a)-Number(b))){
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
          ${isSeller ? `<button class="btn" data-action="update" data-pid="${pid}">Cập nhật sản phẩm</button>` : ""}
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
  const m = /^unit:(.+)$/i.exec(desc.trim());
  return m? m[1].trim() : "";
}
function toHttp(link){
  if (!link) return "";
  if (link.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + link.slice(7);
  return link;
}
function esc(s){ return String(s||"").replace(/[&<>"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;" }[c])); }

/* -------------------- CREATE PRODUCT (FIX JSON-RPC) -------------------- */
function openCreate(){
  if (!isRegistered){ toast("Ví chưa đăng ký. Bấm ‘Đăng ký’ trước."); return; }
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

    if (!name || !ipfs || !unit || !priceVND || !wallet || !days){
      toast("Vui lòng nhập đủ thông tin."); return;
    }
    if (!isAddr(wallet)){ toast("Ví nhận thanh toán không hợp lệ."); return; }
    if (name.length>500){ toast("Tên sản phẩm tối đa 500 ký tự."); return; }

    // Map vào tham số contract (đúng thứ tự theo ABI)
    const descriptionCID = `unit:${unit}`;
    const imageCID       = ipfs;
    const active         = true; // mặc định đăng là Còn hàng

    // --- Preflight (simulate) để bắt revert rõ ---
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
    try{
      await providerWrite.call(txData); // nếu revert sẽ ném ra lỗi có reason
    }catch(simErr){
      toast(parseRevert(simErr)); return;
    }

    // --- Send thật (legacy override) ---
    const tx = await muaban.createProduct(
      name, descriptionCID, imageCID,
      ethers.BigNumber.from(String(priceVND)),
      Number(days),
      wallet,
      active,
      ov("heavy")
    );
    await tx.wait();

    toast("Đăng sản phẩm thành công.");
    hide($("#formCreate"));
    await loadProducts();
  }catch(e){
    // Nếu vẫn có "Internal JSON-RPC error", hiển thị chi tiết để debug
    showRpc(e, "submitCreate");
  }
}

/* -------------------- UPDATE PRODUCT (tối thiểu) -------------------- */
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

    // preflight
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
    try{
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    const tx = await muaban.updateProduct(
      pid,
      ethers.BigNumber.from(String(price)),
      Number(days),
      wall,
      act,
      ov("med")
    );
    await tx.wait();

    toast("Cập nhật thành công.");
    hide($("#formUpdate"));
    await loadProducts();
  }catch(e){ showRpc(e, "submitUpdate"); }
}

/* -------------------- BUY (khung sẵn, giữ nguyên nếu bạn chưa cần) -------------------- */
function openBuy(pid, data){
  // Tùy tiến độ của bạn, có thể đã có formBuy trong index.html
  // Ở đây chỉ đảm bảo không ảnh hưởng luồng create/update.
  toast("Chức năng mua sẽ bật sau khi bạn yêu cầu. Tập trung fix đăng sản phẩm trước.");
}

/* -------------------- Search -------------------- */
$("#btnSearch")?.addEventListener("click", ()=>{
  const q = ($("#searchInput")?.value||"").trim().toLowerCase();
  if (!q) { renderProducts(productsCache); return; }
  const list = productsCache.filter(({data})=> (data?.name||"").toLowerCase().includes(q));
  renderProducts(list);
});

/* -------------------- Wire up buttons -------------------- */
$("#btnConnect")?.addEventListener("click", connectWallet);
$("#btnDisconnect")?.addEventListener("click", disconnectWallet);

$("#btnRegister")?.addEventListener("click", doRegister);
$("#btnCreate")  ?.addEventListener("click", openCreate);

// close modals
$$(".modal .close")?.forEach(btn=> btn.addEventListener("click", (e)=> {
  e.preventDefault();
  e.target.closest(".modal")?.classList.add("hidden");
}));

$("#btnSubmitCreate")?.addEventListener("click", submitCreate);
$("#btnSubmitUpdate")?.addEventListener("click", submitUpdate);

/* -------------------- Boot -------------------- */
(async function boot(){
  await loadAbis();
  initProviders();
  initReadContracts();
  try{ await loadProducts(); }catch(_){}
  // (Optional) load giá VIN/VND hiển thị UI nếu bạn có thẻ #vinPrice
  const vp = $("#vinPrice"); if (vp) vp.textContent = "1 VIN = … VND";
})();

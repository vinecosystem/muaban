/* ========== muaban.vin — app.js (ethers v5.7 UMD) ========== */
/* Phụ thuộc: ethers UMD (đã khai báo trong index.html) */

/* -------------------- 0) CẤU HÌNH -------------------- */
const CONFIG = {
  CHAIN_ID: 88, // Viction mainnet
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://www.vicscan.xyz",
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",

  // Nguồn giá: Binance (VICUSDT) + CoinGecko (USDT/VND)
  BINANCE_VICUSDT: "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",
  COINGECKO_USDTVND: "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",

  // Chặn quét logs quá dài: có thể đặt block bắt đầu nếu bạn biết block deploy
  LOGS_LOOKBACK_BLOCKS: 500_000n, // đủ sâu cho mainnet Viction, có thể chỉnh
};

/* -------------------- 1) TIỆN ÍCH DOM -------------------- */
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function shortAddr(addr){
  if (!addr) return "0x…";
  return addr.slice(0,6) + "…" + addr.slice(-4);
}
function fmtVND(n){ // số nguyên VND
  try{
    return new Intl.NumberFormat('vi-VN').format(Number(n||0)) + " VND";
  }catch{ return String(n) + " VND"; }
}
function fmtVINWeiToVIN(wei){
  return Number(ethers.utils.formatUnits(wei, 18));
}
function bn(n){ return ethers.BigNumber.from(String(n)); }
function clamp(n,min,max){ return Math.max(min, Math.min(max, n)); }
function toBase64(str){ return btoa(unescape(encodeURIComponent(str))); }

/* Toast nhỏ gọn */
let toastTimer=null;
function toast(msg){
  console.log("[toast]", msg);
  if ($("#_toast")) $("#_toast").remove();
  const el = document.createElement("div");
  el.id = "_toast";
  el.style.cssText = `
    position:fixed;left:50%;top:12px;transform:translateX(-50%);
    background:#111827;color:#fff;padding:10px 14px;border-radius:10px;
    box-shadow:0 6px 20px rgba(0,0,0,.25);z-index:9999;font-size:13px`;
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{ el.remove(); }, 2600);
}

/* -------------------- 2) TRẠNG THÁI -------------------- */
let providerRead, providerWrite, signer, account;
let muaban, vin;
let MUABAN_ABI, VIN_ABI;

let isRegistered = false;
let rate = {
  vic_usdt: null,     // số USDT cho 1 VIC
  usdt_vnd: null,     // số VND cho 1 USDT
  vin_vnd: null,      // số VND cho 1 VIN ( = vic_usdt * 100 * usdt_vnd )
  vinPerVND_wei: null // số wei VIN cho 1 VND (làm tròn xuống)
};

/* -------------------- 3) NẠP ABI (nhúng sẵn từ file JSON) -------------------- */
/* Bạn đã upload Muaban_ABI.json & VinToken_ABI.json — code này fetch trực tiếp */
async function loadABIs(){
  const [muabanAbiRaw, vinAbiRaw] = await Promise.all([
    fetch("Muaban_ABI.json").then(r=>r.json()),
    fetch("VinToken_ABI.json").then(r=>r.json())
  ]);
  MUABAN_ABI = muabanAbiRaw;
  VIN_ABI = vinAbiRaw;
}

/* -------------------- 4) KẾT NỐI ETHERS -------------------- */
async function setupProviders(){
  providerRead = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL, {
    name: "viction", chainId: CONFIG.CHAIN_ID
  });

  if (window.ethereum){
    providerWrite = new ethers.providers.Web3Provider(window.ethereum, "any");
  }else{
    providerWrite = null;
  }
}

/* Kiểm tra/switch chain */
async function ensureChain(){
  if (!providerWrite) return;
  const net = await providerWrite.getNetwork();
  if (Number(net.chainId) !== CONFIG.CHAIN_ID){
    try{
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + CONFIG.CHAIN_ID.toString(16) }]
      });
    }catch(err){
      // thêm mạng nếu chưa có
      if (err && err.code === 4902){
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: "0x" + CONFIG.CHAIN_ID.toString(16),
            chainName: "Viction Mainnet",
            rpcUrls: [CONFIG.RPC_URL],
            nativeCurrency: { name: "VIC", symbol: "VIC", decimals: 18 },
            blockExplorerUrls: [CONFIG.EXPLORER]
          }]
        });
      }else{
        throw err;
      }
    }
  }
}

/* -------------------- 5) GIÁ VIN THEO VND -------------------- */
/* VIN/VND = (VICUSDT × 100) × (USDT/VND)  => số VND cho 1 VIN (làm tròn xuống) */
async function fetchRates(){
  try{
    const [r1, r2] = await Promise.all([
      fetch(CONFIG.BINANCE_VICUSDT, {cache: "no-store"}).then(r=>r.json()),
      fetch(CONFIG.COINGECKO_USDTVND, {cache: "no-store"}).then(r=>r.json())
    ]);
    const vic_usdt = Number(r1?.price || 0);
    const usdt_vnd = Number(r2?.tether?.vnd || 0);
    if (vic_usdt > 0 && usdt_vnd > 0){
      rate.vic_usdt = vic_usdt;
      rate.usdt_vnd = usdt_vnd;
      const vin_vnd = Math.floor(vic_usdt * 100 * usdt_vnd);
      rate.vin_vnd = vin_vnd;
      // vinPerVND (wei) = floor(1e18 / vin_vnd)
      rate.vinPerVND_wei = ethers.BigNumber.from(
        Math.floor(1e18 / Math.max(1, vin_vnd)).toString()
      );
      $("#vinPrice").textContent = `1 VIN = ${new Intl.NumberFormat('vi-VN').format(vin_vnd)} VND`;
    }else{
      $("#vinPrice").textContent = "Loading price...";
    }
  }catch(err){
    console.error("fetchRates error:", err);
    $("#vinPrice").textContent = "Loading price...";
  }
}

/* -------------------- 6) KHỞI TẠO CONTRACT INSTANCES -------------------- */
function bindContracts(read=true){
  const prov = read ? providerRead : providerWrite;
  muaban = new ethers.Contract(CONFIG.MUABAN_ADDR, MUABAN_ABI, prov);
  vin    = new ethers.Contract(CONFIG.VIN_ADDR, VIN_ABI, prov);
}

/* -------------------- 7) UI: KẾT NỐI/NGẮT VÍ + HIỂN THỊ SỐ DƯ -------------------- */
async function refreshBalances(){
  try{
    if (!account){ return; }
    const [vinBal, vicBal] = await Promise.all([
      vin.balanceOf(account),
      providerWrite.getBalance(account)
    ]);
    $("#vinBalance").textContent = `VIN: ${ethers.utils.formatUnits(vinBal, 18).slice(0, 8)}`;
    $("#vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;
    $("#accountShort").textContent = shortAddr(account);
    $("#accountShort").href = `${CONFIG.EXPLORER}/address/${account}`;
  }catch(e){ console.warn("refreshBalances:", e); }
}

async function connectWallet(){
  if (!window.ethereum){ toast("Không phát hiện ví. Vui lòng cài MetaMask."); return; }
  try{
    await ensureChain();
    await providerWrite.send("eth_requestAccounts", []);
    signer = providerWrite.getSigner();
    account = await signer.getAddress();

    $("#btnConnect").classList.add("hidden");
    $("#walletBox").classList.remove("hidden");
    $("#menuBox").classList.remove("hidden");
    $("#accountShort").textContent = shortAddr(account);
    $("#accountShort").href = `${CONFIG.EXPLORER}/address/${account}`;

    bindContracts(false); // gắn providerWrite để gọi tx
    await refreshBalances();
    await checkRegistrationAndToggleMenu();
  }catch(err){
    console.error("connectWallet error:", err);
    toast("Kết nối ví thất bại.");
  }
}
function disconnectWallet(){
  signer = null; account = null; providerWrite = providerWrite; // giữ nguyên
  $("#walletBox").classList.add("hidden");
  $("#btnConnect").classList.remove("hidden");
  $("#menuBox").classList.add("hidden");
}

/* -------------------- 8) ĐĂNG KÝ VÍ (approve + payRegistration) -------------------- */
async function checkRegistrationAndToggleMenu(){
  if (!account) return;
  try{
    isRegistered = await muaban.registered(account);
  }catch(e){
    // fallback: chuyển sang read provider nếu cần
    bindContracts(true);
    isRegistered = await muaban.registered(account);
    bindContracts(false);
  }

  if (!isRegistered){
    $("#btnRegister").classList.remove("hidden");
    $("#btnCreate").classList.add("hidden");
    $("#btnOrdersBuy").classList.add("hidden");
    $("#btnOrdersSell").classList.add("hidden");
  }else{
    $("#btnRegister").classList.add("hidden");
    $("#btnCreate").classList.remove("hidden");
    $("#btnOrdersBuy").classList.remove("hidden");
    $("#btnOrdersSell").classList.remove("hidden");
  }
}

async function onRegister(){
  if (!signer) { toast("Vui lòng kết nối ví trước."); return; }
  try{
    // Lấy phí đăng ký từ contract (0.001 VIN — REG_FEE)
    const REG_FEE = await muaban.REG_FEE();
    // approve cho HỢP ĐỒNG (spender = hợp đồng Muaban)
    const vinWithSigner = vin.connect(signer);
    const allowance = await vinWithSigner.allowance(account, CONFIG.MUABAN_ADDR);
    if (allowance.lt(REG_FEE)){
      const txA = await vinWithSigner.approve(CONFIG.MUABAN_ADDR, REG_FEE);
      toast("Đang gửi approve phí đăng ký…");
      await txA.wait();
    }
    // Gọi đăng ký
    const tx = await muaban.connect(signer).payRegistration();
    toast("Đang đăng ký ví…");
    await tx.wait();
    toast("Đăng ký thành công.");
    await checkRegistrationAndToggleMenu();
    await refreshBalances();
  }catch(err){
    console.error("onRegister error:", err);
    toast("Đăng ký thất bại.");
  }
}

/* -------------------- 9) SẢN PHẨM: TẢI DANH SÁCH TỪ EVENT LOGS -------------------- */
/* Dùng ProductCreated(productId, seller, name, priceVND) để lấy danh sách pid,
   sau đó gọi getProduct(pid) để lấy trạng thái mới nhất. */
async function loadProducts(keyword=""){
  try{
    bindContracts(true);
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topicCreated = iface.getEventTopic("ProductCreated");

    const latest = await providerRead.getBlockNumber();
    let fromBlock = 0n;
    if (CONFIG.LOGS_LOOKBACK_BLOCKS){
      const lb = BigInt(latest) - CONFIG.LOGS_LOOKBACK_BLOCKS;
      fromBlock = lb > 0n ? lb : 0n;
    }
    const logs = await providerRead.getLogs({
      address: CONFIG.MUABAN_ADDR,
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock:   "latest",
      topics: [topicCreated]
    });

    // Lấy danh sách pid duy nhất (log cũ + có thể nhiều seller)
    const pidSet = new Set();
    for (const lg of logs){
      try{
        const parsed = iface.parseLog(lg);
        const pid = parsed.args.productId.toString();
        pidSet.add(pid);
      }catch{}
    }

    const list = [];
    for (const pid of pidSet){
      const p = await muaban.getProduct(pid);
      // Lọc theo keyword (trên tên, không phân biệt hoa/thường)
      if (keyword && !String(p.name||"").toLowerCase().includes(keyword.toLowerCase())) continue;

      // Unit hiển thị: nhúng trong descriptionCID theo dạng "unit:<text>" nếu có
      let unit = "";
      if (p.descriptionCID && p.descriptionCID.startsWith("unit:")){
        unit = p.descriptionCID.slice(5);
      }

      list.push({
        pid: Number(p.productId),
        name: p.name,
        image: p.imageCID,
        priceVND: p.priceVND.toString(),
        deliveryDaysMax: Number(p.deliveryDaysMax),
        seller: p.seller,
        payoutWallet: p.payoutWallet,
        active: p.active,
        unit
      });
    }

    // Sắp xếp mới nhất trước (pid lớn → mới)
    list.sort((a,b)=>b.pid - a.pid);
    renderProducts(list);
  }catch(err){
    console.error("loadProducts error:", err);
    toast("Không tải được danh sách sản phẩm.");
  }finally{
    bindContracts(false); // trả về write mode nếu đã kết nối ví
  }
}

/* Render danh sách sản phẩm vào #productList */
function renderProducts(list){
  const box = $("#productList");
  box.innerHTML = "";

  if (!list.length){
    const empty = document.createElement("div");
    empty.textContent = "Chưa có sản phẩm.";
    empty.style.cssText = "padding:12px;color:#64748b;";
    box.appendChild(empty);
    return;
  }

  for (const it of list){
    const card = document.createElement("div");
    card.className = "product-card";

    const img = document.createElement("img");
    img.className = "product-thumb";
    img.src = it.image || "";
    img.alt = it.name || "";

    const info = document.createElement("div");
    info.className = "product-info";

    const top = document.createElement("div");
    top.className = "product-top";

    const title = document.createElement("h3");
    title.className = "product-title";
    title.textContent = it.name || "(không tên)";

    const stock = document.createElement("span");
    stock.className = "stock-badge " + (it.active ? "" : "out");
    stock.textContent = it.active ? "Còn hàng" : "Hết hàng";

    top.appendChild(title);
    top.appendChild(stock);

    const meta = document.createElement("div");
    meta.className = "product-meta";
    const unitTxt = it.unit ? ` / ${it.unit}` : "";
    meta.innerHTML = `<span class="price-vnd">${fmtVND(it.priceVND)}</span>${unitTxt}`;

    const actions = document.createElement("div");
    actions.className = "card-actions";

    const aSeller = document.createElement("a");
    aSeller.href = `${CONFIG.EXPLORER}/address/${it.seller}`;
    aSeller.target = "_blank";
    aSeller.rel = "noopener";
    aSeller.className = "tag";
    aSeller.textContent = shortAddr(it.seller);

    actions.appendChild(aSeller);

    // Nếu đã kết nối & đăng ký:
    if (account && isRegistered){
      if (account.toLowerCase() === it.seller.toLowerCase()){
        const btnU = document.createElement("button");
        btnU.className = "btn";
        btnU.textContent = "Cập nhật sản phẩm";
        btnU.onclick = ()=> openUpdateModal(it);
        actions.appendChild(btnU);
      }else if (it.active){
        const btnB = document.createElement("button");
        btnB.className = "btn primary";
        btnB.textContent = "Mua";
        btnB.onclick = ()=> openBuyModal(it);
        actions.appendChild(btnB);
      }
    }

    info.appendChild(top);
    info.appendChild(meta);
    info.appendChild(actions);

    card.appendChild(img);
    card.appendChild(info);
    box.appendChild(card);
  }
}

/* -------------------- 10) ĐĂNG SẢN PHẨM -------------------- */
function openCreateModal(){
  $("#formCreate").classList.remove("hidden");
  document.body.classList.add("no-scroll");
}
function closeCreateModal(){
  $("#formCreate").classList.add("hidden");
  document.body.classList.remove("no-scroll");
}
async function onSubmitCreate(){
  try{
    if (!signer || !account) { toast("Vui lòng kết nối & đăng ký ví trước."); return; }
    if (!isRegistered){ toast("Bạn cần đăng ký ví trước."); return; }

    const name = ($("#createName").value||"").trim();
    const ipfs = ($("#createIPFS").value||"").trim();
    const unit = ($("#createUnit").value||"").trim();
    const priceVND = bn(String(Math.max(1, Number($("#createPrice").value||0))));
    const wallet = ($("#createWallet").value||"").trim();
    const days = Number($("#createDays").value||0);
    if (!name || !ipfs || !unit || priceVND.lte(0) || !wallet || !days){
      toast("Vui lòng nhập đủ thông tin.");
      return;
    }

    const descriptionCID = `unit:${unit}`;
    const imageCID = ipfs;
    // createProduct(name, descriptionCID, imageCID, priceVND, deliveryDaysMax, payoutWallet, active)
    const tx = await muaban.connect(signer).createProduct(
      name, descriptionCID, imageCID, priceVND, days, wallet, true
    );
    toast("Đang đăng sản phẩm…");
    await tx.wait();
    toast("Đăng sản phẩm thành công.");

    closeCreateModal();
    await loadProducts($("#searchInput").value||"");
  }catch(err){
    console.error("submitCreate error:", err);
    toast("Đăng sản phẩm thất bại.");
  }
}

/* -------------------- 11) CẬP NHẬT SẢN PHẨM -------------------- */
function openUpdateModal(item){
  $("#formUpdate").classList.remove("hidden");
  document.body.classList.add("no-scroll");
  $("#updatePid").value = String(item.pid);
  $("#updatePrice").value = String(item.priceVND);
  $("#updateDays").value = String(item.deliveryDaysMax);
  $("#updateWallet").value = item.payoutWallet;
  $("#updateActive").checked = !!item.active;
}
function closeUpdateModal(){
  $("#formUpdate").classList.add("hidden");
  document.body.classList.remove("no-scroll");
}
async function onSubmitUpdate(){
  try{
    const pid = Number($("#updatePid").value||0);
    const priceVND = bn(String(Math.max(1, Number($("#updatePrice").value||0))));
    const days = Number($("#updateDays").value||0);
    const wallet = ($("#updateWallet").value||"").trim();
    const active = !!$("#updateActive").checked;

    if (!pid || priceVND.lte(0) || !days || !wallet){ toast("Thiếu dữ liệu."); return; }

    // updateProduct(pid, priceVND, deliveryDaysMax, payoutWallet, active)
    const tx = await muaban.connect(signer).updateProduct(pid, priceVND, days, wallet, active);
    toast("Đang cập nhật sản phẩm…");
    await tx.wait();
    toast("Cập nhật thành công.");

    closeUpdateModal();
    await loadProducts($("#searchInput").value||"");
  }catch(err){
    console.error("onSubmitUpdate error:", err);
    toast("Cập nhật thất bại.");
  }
}

/* -------------------- 12) MUA HÀNG -------------------- */
let currentBuyItem = null;

function openBuyModal(item){
  currentBuyItem = item;
  $("#formBuy").classList.remove("hidden");
  document.body.classList.add("no-scroll");

  $("#buyProductInfo").innerHTML = `
    <div class="order-row">
      <span class="order-strong">${item.name}</span>
      <span>${fmtVND(item.priceVND)}${item.unit?(" / "+item.unit):""}</span>
      <span>Giao trong ${item.deliveryDaysMax} ngày</span>
    </div>
  `;
  $("#buyName").value = "";
  $("#buyAddress").value = "";
  $("#buyPhone").value = "";
  $("#buyNote").value = "";
  $("#buyQty").value = "1";
  updateBuyTotalVIN();
}
function closeBuyModal(){
  $("#formBuy").classList.add("hidden");
  document.body.classList.remove("no-scroll");
  currentBuyItem = null;
}

function updateBuyTotalVIN(){
  const qty = clamp(Number($("#buyQty").value||1), 1, 1_000_000);
  $("#buyQty").value = String(qty);

  if (!currentBuyItem || !rate.vinPerVND_wei) {
    $("#buyTotalVIN").textContent = `Tổng VIN cần trả: 0`;
    return;
  }
  // total wei = priceVND * qty * vinPerVND (wei/VND)
  const totalWei = bn(currentBuyItem.priceVND).mul(qty).mul(rate.vinPerVND_wei);
  const totalVIN = fmtVINWeiToVIN(totalWei);
  $("#buyTotalVIN").textContent = `Tổng VIN cần trả: ${totalVIN.toFixed(6)}`;
}

async function onSubmitBuy(){
  try{
    if (!signer || !isRegistered){ toast("Vui lòng kết nối & đăng ký ví trước."); return; }
    if (!currentBuyItem){ toast("Thiếu dữ liệu sản phẩm."); return; }
    if (!rate.vinPerVND_wei){ toast("Chưa có tỉ giá. Vui lòng đợi giá tải xong."); return; }

    const name = ($("#buyName").value||"").trim();
    const addr = ($("#buyAddress").value||"").trim();
    const phone= ($("#buyPhone").value||"").trim();
    const note = ($("#buyNote").value||"").trim();
    const qty  = clamp(Number($("#buyQty").value||1), 1, 1_000_000);

    if (!name || !addr || !phone){ toast("Vui lòng điền họ tên, địa chỉ, SĐT."); return; }

    // Encode buyer info (simple "cipher" = base64 JSON)
    const cipher = toBase64(JSON.stringify({name, addr, phone, note}));

    // Tính số VIN cần escrow để APPROVE (ceil theo contract đã bảo vệ seller)
    const expectWei = bn(currentBuyItem.priceVND).mul(qty).mul(rate.vinPerVND_wei);

    // 1) approve đủ VIN cho hợp đồng Muaban
    const vinWithSigner = vin.connect(signer);
    const currentAllowance = await vinWithSigner.allowance(account, CONFIG.MUABAN_ADDR);
    if (currentAllowance.lt(expectWei)){
      const txA = await vinWithSigner.approve(CONFIG.MUABAN_ADDR, expectWei);
      toast("Đang approve VIN…");
      await txA.wait();
    }

    // 2) placeOrder(productId, quantity, vinPerVND, buyerInfoCipher)
    const tx = await muaban.connect(signer).placeOrder(
      currentBuyItem.pid, qty, rate.vinPerVND_wei, cipher
    );
    toast("Đang tạo đơn hàng…");
    const rc = await tx.wait();
    toast("Đặt hàng thành công.");

    closeBuyModal();
    await refreshBalances();
    await loadMyOrders(); // cập nhật đơn mua/bán
  }catch(err){
    console.error("onSubmitBuy error:", err);
    toast("Đặt hàng thất bại.");
  }
}

/* -------------------- 13) ĐƠN HÀNG CỦA TÔI (BUY/SELL) -------------------- */
/* Quét logs OrderPlaced để tìm đơn theo buyer/seller, sau đó getOrder(oid). */
async function loadMyOrders(){
  if (!account) return;
  bindContracts(true);
  const iface = new ethers.utils.Interface(MUABAN_ABI);
  const topicOrder = iface.getEventTopic("OrderPlaced");

  const latest = await providerRead.getBlockNumber();
  let fromBlock = 0n;
  if (CONFIG.LOGS_LOOKBACK_BLOCKS){
    const lb = BigInt(latest) - CONFIG.LOGS_LOOKBACK_BLOCKS;
    fromBlock = lb > 0n ? lb : 0n;
  }

  const logs = await providerRead.getLogs({
    address: CONFIG.MUABAN_ADDR,
    fromBlock: "0x" + fromBlock.toString(16),
    toBlock:   "latest",
    topics: [topicOrder]
  });

  const buys = [];
  const sells = [];
  for (const lg of logs){
    try{
      const ev = iface.parseLog(lg);
      const oid = ev.args.orderId.toString();
      const od = await muaban.getOrder(oid);
      const buyer = od.buyer?.toLowerCase?.() || "";
      const seller= od.seller?.toLowerCase?.() || "";
      const mine = account.toLowerCase();

      const row = {
        oid: Number(od.orderId),
        pid: Number(od.productId),
        buyer: od.buyer,
        seller: od.seller,
        quantity: Number(od.quantity),
        vinAmount: od.vinAmount.toString(),
        placedAt: Number(od.placedAt),
        deadline: Number(od.deadline),
        status: Number(od.status)
      };

      if (buyer === mine) buys.push(row);
      if (seller=== mine) sells.push(row);
    }catch{}
  }

  // render
  renderOrders("#ordersBuySection", "#ordersBuyList", buys, "buy");
  renderOrders("#ordersSellSection","#ordersSellList", sells, "sell");

  bindContracts(false);
}

function renderOrders(sectionSel, listSel, arr, mode){
  const section = $(sectionSel);
  const list = $(listSel);
  list.innerHTML = "";

  if (!arr.length){
    const p = document.createElement("p");
    p.style.color = "#64748b";
    p.textContent = "Chưa có đơn.";
    list.appendChild(p);
    return;
  }

  for (const it of arr.sort((a,b)=>b.oid - a.oid)){
    const card = document.createElement("div");
    card.className = "order-card";

    const vin = fmtVINWeiToVIN(it.vinAmount);
    const placed = new Date(it.placedAt*1000).toLocaleString("vi-VN");
    const deadline = new Date(it.deadline*1000).toLocaleDateString("vi-VN");
    const stMap = ["NONE","PLACED","RELEASED","REFUNDED"];
    const st = stMap[it.status]||String(it.status);

    const row1 = document.createElement("div");
    row1.className = "order-row";
    row1.innerHTML = `
      <span class="order-strong">#${it.oid}</span>
      <span>PID: ${it.pid}</span>
      <span>Số lượng: ${it.quantity}</span>
      <span>VIN: ${vin.toFixed(6)}</span>
    `;

    const row2 = document.createElement("div");
    row2.className = "order-row";
    row2.innerHTML = `
      <span>Ngày đặt: ${placed}</span>
      <span>Hạn giao: ${deadline}</span>
      <span>Trạng thái: ${st}</span>
    `;

    const act = document.createElement("div");
    act.className = "card-actions";

    if (mode==="buy"){
      if (it.status === 1){ // PLACED
        const b1 = document.createElement("button");
        b1.className = "btn primary";
        b1.textContent = "Xác nhận đã nhận hàng";
        b1.onclick = ()=> confirmReceipt(it.oid);

        const b2 = document.createElement("button");
        b2.className = "btn";
        b2.textContent = "Hoàn tiền (quá hạn)";
        b2.onclick = ()=> refundIfExpired(it.oid);

        act.appendChild(b1);
        act.appendChild(b2);
      }
    }else if (mode==="sell"){
      const aBuyer = document.createElement("a");
      aBuyer.className = "tag";
      aBuyer.href = `${CONFIG.EXPLORER}/address/${it.buyer}`;
      aBuyer.target = "_blank"; aBuyer.rel = "noopener";
      aBuyer.textContent = "Buyer: " + shortAddr(it.buyer);
      act.appendChild(aBuyer);
    }

    card.appendChild(row1);
    card.appendChild(row2);
    card.appendChild(act);
    list.appendChild(card);
  }
}

async function confirmReceipt(oid){
  try{
    const tx = await muaban.connect(signer).confirmReceipt(oid);
    toast("Đang xác nhận…");
    await tx.wait();
    toast("Đã giải ngân cho người bán.");
    await loadMyOrders();
    await refreshBalances();
  }catch(err){
    console.error("confirmReceipt error:", err);
    toast("Xác nhận thất bại.");
  }
}
async function refundIfExpired(oid){
  try{
    const tx = await muaban.connect(signer).refundIfExpired(oid);
    toast("Đang yêu cầu hoàn tiền…");
    await tx.wait();
    toast("Đã hoàn tiền (nếu đơn quá hạn).");
    await loadMyOrders();
    await refreshBalances();
  }catch(err){
    console.error("refundIfExpired error:", err);
    toast("Hoàn tiền thất bại.");
  }
}

/* -------------------- 14) TÌM KIẾM -------------------- */
async function onSearch(){
  const kw = ($("#searchInput").value||"").trim();
  await loadProducts(kw);
}

/* -------------------- 15) GẮN SỰ KIỆN UI -------------------- */
function bindUI(){
  $("#btnConnect")?.addEventListener("click", connectWallet);
  $("#btnDisconnect")?.addEventListener("click", disconnectWallet);

  $("#btnRegister")?.addEventListener("click", onRegister);

  $("#btnCreate")?.addEventListener("click", openCreateModal);
  $("#btnSubmitCreate")?.addEventListener("click", onSubmitCreate);
  $("#formCreate .close")?.addEventListener("click", closeCreateModal);

  $("#btnSubmitUpdate")?.addEventListener("click", onSubmitUpdate);
  $("#formUpdate .close")?.addEventListener("click", closeUpdateModal);

  $("#btnSearch")?.addEventListener("click", onSearch);
  $("#searchInput")?.addEventListener("keydown", (e)=>{ if (e.key==="Enter") onSearch(); });

  $("#btnOrdersBuy")?.addEventListener("click", ()=>{
    $("#ordersBuySection").classList.remove("hidden");
    $("#ordersSellSection").classList.add("hidden");
    loadMyOrders();
    window.scrollTo({top: document.body.scrollHeight, behavior:"smooth"});
  });
  $("#btnOrdersSell")?.addEventListener("click", ()=>{
    $("#ordersBuySection").classList.add("hidden");
    $("#ordersSellSection").classList.remove("hidden");
    loadMyOrders();
    window.scrollTo({top: document.body.scrollHeight, behavior:"smooth"});
  });

  // Buy modal
  $("#buyQty")?.addEventListener("input", updateBuyTotalVIN);
  $("#btnSubmitBuy")?.addEventListener("click", onSubmitBuy);
  $("#formBuy .close")?.addEventListener("click", closeBuyModal);
}

/* -------------------- 16) KHỞI CHẠY -------------------- */
(async function init(){
  try{
    await Promise.all([loadABIs(), setupProviders()]);
    bindContracts(true);
    bindUI();
    await fetchRates();
    // Cập nhật giá định kỳ 60s
    setInterval(fetchRates, 60_000);

    // Tải sản phẩm lần đầu
    await loadProducts();

    // Nếu người dùng đã kết nối ví trong phiên trước
    if (window.ethereum){
      window.ethereum.on("accountsChanged", ()=>{ window.location.reload(); });
      window.ethereum.on("chainChanged",   ()=>{ window.location.reload(); });
    }
  }catch(err){
    console.error("init error:", err);
    toast("Lỗi khởi tạo ứng dụng.");
  }
})();

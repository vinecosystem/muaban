/* ====================================================================
   muaban.vin — app.js (ethers v5)
   - Đúng theo mô tả: giá sản phẩm nhập VND; thanh toán VIN (quy đổi từ VIC/USDT *100 * USDT/VND)
   - Hai trạng thái UI: chưa kết nối / đã kết nối; đã đăng ký mới hiện menu đầy đủ
   - Đăng sản phẩm (6 trường), Cập nhật sản phẩm (có bật/tắt còn hàng), Mua hàng (có số lượng & tổng VIN)
   - Danh sách sản phẩm, đơn mua/đơn bán lấy từ sự kiện on-chain (không cần indexer riêng)
   - Mã hóa thông tin giao hàng client-side (base64) trước khi ghi on-chain
==================================================================== */

/* -------------------- 0) Cấu hình & Hằng số -------------------- */
const CONFIG = {
  CHAIN_ID: 88, // Viction mainnet
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://scan.viction.xyz",

  // Địa chỉ theo mota.md
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",

  // API tỷ giá
  BINANCE_VICUSDT: "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",
  COINGECKO_USDT_VND: "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",

  // Phí đăng ký 0.001 VIN (18 decimals)
  REG_FEE_WEI: ethers.BigNumber.from("1000000000000000"),
};

// Tải ABI (đã rút gọn đúng các hàm dùng)
const MUABAN_ABI = [
  // Read
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"}],"name":"getProduct","outputs":[{"components":[{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"address","name":"seller","type":"address"},{"internalType":"string","name":"name","type":"string"},{"internalType":"string","name":"descriptionCID","type":"string"},{"internalType":"string","name":"imageCID","type":"string"},{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"bool","name":"active","type":"bool"},{"internalType":"uint64","name":"createdAt","type":"uint64"},{"internalType":"uint64","name":"updatedAt","type":"uint64"}],"internalType":"struct MuabanVND.Product","name":"","type":"tuple"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"oid","type":"uint256"}],"name":"getOrder","outputs":[{"components":[{"internalType":"uint256","name":"orderId","type":"uint256"},{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"address","name":"buyer","type":"address"},{"internalType":"address","name":"seller","type":"address"},{"internalType":"uint256","name":"quantity","type":"uint256"},{"internalType":"uint256","name":"vinAmount","type":"uint256"},{"internalType":"uint256","name":"placedAt","type":"uint256"},{"internalType":"uint256","name":"deadline","type":"uint256"},{"internalType":"enum MuabanVND.OrderStatus","name":"status","type":"uint8"},{"internalType":"string","name":"buyerInfoCipher","type":"string"}],"internalType":"struct MuabanVND.Order","name":"","type":"tuple"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"seller","type":"address"}],"name":"getSellerProductIds","outputs":[{"internalType":"uint256[]","name":"","type":"uint256[]"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"registered","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"REG_FEE","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  // Write
  {"inputs":[],"name":"payRegistration","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"string","name":"name","type":"string"},{"internalType":"string","name":"descriptionCID","type":"string"},{"internalType":"string","name":"imageCID","type":"string"},{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"bool","name":"active","type":"bool"}],"name":"createProduct","outputs":[{"internalType":"uint256","name":"pid","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"},{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"bool","name":"active","type":"bool"}],"name":"updateProduct","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"},{"internalType":"bool","name":"active","type":"bool"}],"name":"setProductActive","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"uint256","name":"quantity","type":"uint256"},{"internalType":"uint256","name":"vinPerVND","type":"uint256"},{"internalType":"string","name":"buyerInfoCipher","type":"string"}],"name":"placeOrder","outputs":[{"internalType":"uint256","name":"oid","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],"name":"confirmReceipt","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],"name":"refundIfExpired","outputs":[],"stateMutability":"nonpayable","type":"function"},
  // Events (để đọc log)
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"productId","type":"uint256"},{"indexed":true,"internalType":"address","name":"seller","type":"address"},{"indexed":false,"internalType":"string","name":"name","type":"string"},{"indexed":false,"internalType":"uint256","name":"priceVND","type":"uint256"}],"name":"ProductCreated","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"orderId","type":"uint256"},{"indexed":true,"internalType":"uint256","name":"productId","type":"uint256"},{"indexed":true,"internalType":"address","name":"buyer","type":"address"},{"indexed":false,"internalType":"uint256","name":"quantity","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"vinAmount","type":"uint256"}],"name":"OrderPlaced","type":"event"}
];

const ERC20_ABI = [
  {"inputs":[{"internalType":"address","name":"owner","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"}],"name":"allowance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[],"name":"decimals","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"}
];

/* -------------------- 1) Biến trạng thái -------------------- */
let providerRead, providerWrite, signer, account;
let muaban, vin;
let isRegistered = false;

let vinPerVNDWei = ethers.BigNumber.from("0");  // VIN wei cho 1 VND (ceil)
let vinVND = 0;                                  // 1 VIN = ? VND (làm tròn xuống)
let productsCache = [];                          // {pid, data}
let ordersBuyer = [];                            // danh sách order của tôi (buyer)
let ordersSeller = [];                           // danh sách order của tôi (seller)

/* -------------------- 2) DOM helpers -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show = (el)=>{
  if(!el) return;
  el.classList.remove("hidden");
  if(el.classList.contains("modal")){
    document.body.classList.add("no-scroll");
    // Focus ô nhập đầu tiên để người dùng gõ ngay
    const first = el.querySelector('input,select,textarea,button');
    if(first){ setTimeout(()=>{ try{ first.focus(); }catch(e){} }, 50); }
  }
};
const hide = (el)=>{
  if(!el) return;
  el.classList.add("hidden");
  if(el.classList.contains("modal")){
    // Nếu không còn modal nào mở thì mở khóa cuộn nền
    const anyOpen = Array.from(document.querySelectorAll('.modal'))
      .some(m=>!m.classList.contains('hidden'));
    if(!anyOpen){ document.body.classList.remove("no-scroll"); }
  }
};
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`:"";
const fmt2=(x)=>Number(x).toFixed(2);
const fmt0=(x)=>Number(x).toLocaleString("vi-VN", {maximumFractionDigits:0});
const toast=(m)=>{ alert(m); }; // đơn giản; bạn có thể thay bằng toaster tùy ý

/* -------------------- 3) Khởi tạo Provider/Contract -------------------- */
function initProviders(){
  providerRead = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
  if (window.ethereum) {
    providerWrite = new ethers.providers.Web3Provider(window.ethereum, "any");
  }
  muaban = new ethers.Contract(CONFIG.MUABAN_ADDR, MUABAN_ABI, providerRead);
  vin    = new ethers.Contract(CONFIG.VIN_ADDR, ERC20_ABI, providerRead);
}

/* -------------------- 4) Tỷ giá VIN/VND -------------------- */
async function fetchVinToVND(){
  try{
    const [vicPriceRes, usdtRes] = await Promise.all([
      fetch(CONFIG.BINANCE_VICUSDT), 
      fetch(CONFIG.COINGECKO_USDT_VND)
    ]);
    const vicJson = await vicPriceRes.json();
    const usdtJson = await usdtRes.json();

    const vicUsdt = Number(vicJson.price);              // VIC/USDT
    const usdtVnd = Number(usdtJson?.tether?.vnd || 0); // USDT/VND
    if (!vicUsdt || !usdtVnd) throw new Error("Không lấy được giá");

    // 1 VIN = (VIC/USDT * 100) * (USDT/VND)
    const val = vicUsdt * 100 * usdtVnd;
    vinVND = Math.floor(val); // làm tròn xuống theo mô tả
    $("#vinPrice").textContent = `1 VIN = ${vinVND.toLocaleString("vi-VN")} VND`;

    // VIN wei per 1 VND = ceil(1e18 / vinVND)
    const ONE = ethers.BigNumber.from("1000000000000000000");
    vinPerVNDWei = ONE.div(vinVND);
    if (ONE.mod(vinVND).gt(0)) vinPerVNDWei = vinPerVNDWei.add(1);
  }catch(e){
    console.error("fetchVinToVND:", e);
    $("#vinPrice").textContent = "Loading price...";
  }
}

/* -------------------- 5) Kết nối ví & trạng thái -------------------- */
async function connectWallet(){
  if (!window.ethereum) { toast("Vui lòng cài MetaMask / Wallet"); return; }
  await providerWrite.send("eth_requestAccounts", []);
  const net = await providerWrite.getNetwork();
  if (Number(net.chainId) !== CONFIG.CHAIN_ID){
    toast("Sai mạng. Vui lòng chọn Viction (chainId=88).");
    // không tự switch để tránh lỗi; user tự chọn
  }
  signer = providerWrite.getSigner();
  account = (await signer.getAddress()).toLowerCase();

  // update UI
  hide($("#btnConnect"));
  show($("#walletBox"));
  $("#accountShort").textContent = short(account);
  $("#accountShort").href = `${CONFIG.EXPLORER}/address/${account}`;

  // số dư
  const [vinBal, vicBal] = await Promise.all([
    vin.connect(providerWrite).balanceOf(account),
    providerWrite.getBalance(account)
  ]);
  $("#vinBalance").textContent = `VIN: ${parseFloat(ethers.utils.formatUnits(vinBal, 18)).toFixed(4)}`; // lấy 4 chữ số sau dấu chấm
  $("#vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`; // lấy 4 chữ số sau dấu chấm

  // kiểm tra đăng ký
  isRegistered = await muaban.connect(providerWrite).registered(account);
  refreshMenu();

  // Khởi tạo instances write
  muaban = muaban.connect(signer);
  vin    = vin.connect(signer);

  // Tải dữ liệu
  await Promise.all([loadAllProducts(), loadMyOrders()]);
}

function disconnectWallet(){
  // Chế độ dapp tĩnh → chỉ reset UI local
  account = null; signer = null;
  hide($("#walletBox"));
  show($("#btnConnect"));
  $("#vinBalance").textContent = "VIN: 0";
  $("#vicBalance").textContent = "VIC: 0";
  // Menu về mặc định
  isRegistered = false;
  refreshMenu();
}

function refreshMenu(){
  if (!account){
    // chưa kết nối
    show($("#btnRegister"));      // theo mô tả: chưa kết nối -> chỉ xem, nhưng giữ nút đăng ký mờ?
    $("#btnRegister").disabled = true;
    hide($("#btnCreate")); hide($("#btnOrdersBuy")); hide($("#btnOrdersSell"));
    return;
  }
  $("#btnRegister").disabled = false;
  if (!isRegistered){
    // chỉ hiện nút đăng ký
    show($("#btnRegister"));
    hide($("#btnCreate")); hide($("#btnOrdersBuy")); hide($("#btnOrdersSell"));
  } else {
    // đã đăng ký: hiện đủ 3 nút
    hide($("#btnRegister"));
    show($("#btnCreate")); show($("#btnOrdersBuy")); show($("#btnOrdersSell"));
  }
  show($("#menuBox"));
}

/* -------------------- 6) Sản phẩm: load qua sự kiện -------------------- */
async function loadAllProducts(){
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("ProductCreated");
    const logs = await providerRead.getLogs({
      address: CONFIG.MUABAN_ADDR,
      fromBlock: 0,
      toBlock: "latest",
      topics: [topic]
    });
    const pids = new Set();
    logs.forEach(l=>{
      const parsed = iface.parseLog(l);
      pids.add(parsed.args.productId.toString());
    });

    productsCache = [];
    for (const pid of Array.from(pids).sort((a,b)=>Number(a)-Number(b))){
      const p = await muaban.getProduct(pid);
      productsCache.push({ pid: Number(pid), data: p });
    }
    renderProducts(productsCache);
  }catch(e){
    console.error("loadAllProducts:", e);
  }
}

function renderProducts(list){
  const wrap = $("#productList");
  wrap.innerHTML = "";
  if (!list.length){
    wrap.innerHTML = `<div class="tag">Chưa có sản phẩm.</div>`;
    return;
  }
  list.forEach(({pid, data})=>{
    const unit = parseUnitFromCID(data.descriptionCID); // lấy đơn vị tính từ descriptionCID (UI đã nhúng)
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
          <span class="price-vnd">${fmt0(price)} VND</span> <span class="unit">/ ${escapeHtml(unit||"đv")}</span>
        </div>
        <div>
          <span class="stock-badge ${active? "":"out"}">${active? "Còn hàng":"Hết hàng"}</span>
          <span class="tag mono" title="${data.payoutWallet}">Người bán: ${short(data.seller)}</span>
          <span class="tag">Giao tối đa ${data.deliveryDaysMax} ngày</span>
        </div>
        <div class="card-actions">
          ${renderCardButtons(pid, data)}
        </div>
      </div>
    `;
    attachCardHandlers(card, pid, data);
    wrap.appendChild(card);
  });
}

function renderCardButtons(pid, p){
  if (!account) return ""; // chưa kết nối: chỉ xem
  // Nếu tôi là seller → có nút cập nhật
  if (account && p.seller.toLowerCase() === account.toLowerCase()){
    return `<button class="btn" data-action="update" data-pid="${pid}">Cập nhật sản phẩm</button>`;
  }
  // Tôi không phải seller
  if (isRegistered && p.active){
    return `<button class="btn primary" data-action="buy" data-pid="${pid}">Mua</button>`;
  }
  return "";
}

function attachCardHandlers(card, pid, p){
  const btnBuy = card.querySelector('[data-action="buy"]');
  if (btnBuy){
    btnBuy.addEventListener("click", ()=>{
      openBuyForm(pid, p);
    });
  }
  const btnUpd = card.querySelector('[data-action="update"]');
  if (btnUpd){
    btnUpd.addEventListener("click", ()=>{
      openUpdateForm(pid, p);
    });
  }
}

/* -------------------- 7) Tìm kiếm -------------------- */
$("#btnSearch").addEventListener("click", ()=>{
  const q = ($("#searchInput").value||"").trim().toLowerCase();
  if (!q) { renderProducts(productsCache); return; }
  const list = productsCache.filter(({data})=> data.name.toLowerCase().includes(q));
  renderProducts(list);
});

/* -------------------- 8) Đăng ký ví -------------------- */
$("#btnRegister").addEventListener("click", async ()=>{
  if (!account){ toast("Hãy kết nối ví trước."); return; }
  try{
    // approve trước cho hợp đồng trích 0.001 VIN
    const allowance = await vin.allowance(account, CONFIG.MUABAN_ADDR);
    if (allowance.lt(CONFIG.REG_FEE_WEI)){
      const txA = await vin.approve(CONFIG.MUABAN_ADDR, CONFIG.REG_FEE_WEI);
      await txA.wait();
    }
    const tx = await muaban.payRegistration();
    await tx.wait();
    isRegistered = true;
    toast("Đăng ký thành công.");
    refreshMenu();
  }catch(e){
    console.error(e); toast(e?.data?.message || e?.message || "Đăng ký thất bại");
  }
});

/* -------------------- 9) Đăng sản phẩm (6 trường) -------------------- */
$("#btnCreate").addEventListener("click", ()=> openCreateForm());
$(".modal#formCreate .close").addEventListener("click", ()=> hide($("#formCreate")));
$("#btnSubmitCreate").addEventListener("click", submitCreate);

function openCreateForm(){
  if (!isRegistered){ toast("Bạn cần đăng ký trước."); return; }
  $("#createName").value = "";
  $("#createIPFS").value = "";
  $("#createUnit").value = "";
  $("#createPrice").value = "";
  $("#createWallet").value = account || "";
  $("#createDays").value = "3";
  show($("#formCreate"));
}

async function submitCreate(){
  try{
    const name = ($("#createName").value||"").trim();
    const ipfs = ($("#createIPFS").value||"").trim();
    const unit = ($("#createUnit").value||"").trim();
    const priceVND = ethers.BigNumber.from(String(Math.max(1, Number($("#createPrice").value||0))));
    const wallet = ($("#createWallet").value||"").trim();
    const days = Number($("#createDays").value||0);

    if (!name || !ipfs || !unit || !priceVND || !wallet || !days){ toast("Vui lòng nhập đủ thông tin."); return; }

    // Theo contract: createProduct(name, descriptionCID, imageCID, priceVND, deliveryDaysMax, payoutWallet, active)
    // Dùng descriptionCID để lưu 'unit:<...>' (để UI hiển thị đơn vị)
    const descriptionCID = `unit:${unit}`;
    const imageCID = ipfs; // hình/video IPFS

    const tx = await muaban.createProduct(
      name, descriptionCID, imageCID,
      priceVND, days, wallet, true
    );
    const rc = await tx.wait();
    toast("Đăng sản phẩm thành công.");
    hide($("#formCreate"));
    await loadAllProducts();
  }catch(e){
    console.error(e); toast(e?.data?.message || e?.message || "Đăng sản phẩm thất bại");
  }
}

/* -------------------- 10) Cập nhật sản phẩm -------------------- */
$(".modal#formUpdate .close").addEventListener("click", ()=> hide($("#formUpdate")));
$("#btnSubmitUpdate").addEventListener("click", submitUpdate);

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
    const priceVND = ethers.BigNumber.from(String(Math.max(1, Number($("#updatePrice").value||0))));
    const days = Number($("#updateDays").value||0);
    const wallet = ($("#updateWallet").value||"").trim();
    const active = !!$("#updateActive").checked;

    const tx = await muaban.updateProduct(pid, priceVND, days, wallet, active);
    await tx.wait();
    toast("Cập nhật thành công.");
    hide($("#formUpdate"));
    await loadAllProducts();
  }catch(e){
    console.error(e); toast(e?.data?.message || e?.message || "Cập nhật thất bại");
  }
}

/* -------------------- 11) Mua hàng (có số lượng & tổng VIN) -------------------- */
$(".modal#formBuy .close").addEventListener("click", ()=> hide($("#formBuy")));
$("#btnSubmitBuy").addEventListener("click", submitBuy);
$("#buyQty").addEventListener("input", recalcBuyTotal);

let currentBuying = null; // {pid, product}

function openBuyForm(pid, p){
  currentBuying = { pid, product: p };
  $("#buyProductInfo").innerHTML = `
    <div class="order-row">
      <span class="order-strong">${escapeHtml(p.name)}</span>
      <span class="badge mono">#${pid}</span>
    </div>
    <div class="order-row">
      Giá: <span class="order-strong">${fmt0(p.priceVND)} VND</span> · Giao tối đa ${p.deliveryDaysMax} ngày
    </div>
  `;
  $("#buyName").value = "";
  $("#buyAddress").value = "";
  $("#buyPhone").value = "";
  $("#buyNote").value = "";
  $("#buyQty").value = 1;
  recalcBuyTotal();
  show($("#formBuy"));
}

function recalcBuyTotal(){
  try{
    if (!currentBuying) return;
    const qty = Math.max(1, Number($("#buyQty").value||1));
    const totalVND = ethers.BigNumber.from(String(currentBuying.product.priceVND)).mul(qty);
    // theo contract: vinAmount = ceil(totalVND * vinPerVNDWei)
    const vinAmt = totalVND.mul(vinPerVNDWei);
    $("#buyTotalVIN").textContent = `Tổng VIN cần trả: ${ethers.utils.formatUnits(vinAmt, 18)} VIN`;
  }catch(e){
    $("#buyTotalVIN").textContent = `Tổng VIN cần trả: ...`;
  }
}

async function submitBuy(){
  if (!currentBuying){ toast("Thiếu thông tin sản phẩm."); return; }
  try{
    const qty = Math.max(1, Number($("#buyQty").value||1));
    const info = {
      name: ($("#buyName").value||"").trim(),
      addr: ($("#buyAddress").value||"").trim(),
      phone: ($("#buyPhone").value||"").trim(),
      note: ($("#buyNote").value||"").trim()
    };
    if (!info.name || !info.addr || !info.phone){ toast("Vui lòng nhập đủ họ tên, địa chỉ, SĐT."); return; }

    // Chuẩn bị tham số
    const pid = currentBuying.pid;
    const totalVND = ethers.BigNumber.from(String(currentBuying.product.priceVND)).mul(qty);
    const vinAmount = totalVND.mul(vinPerVNDWei); // ceil đã tính cho vinPerVNDWei
    // Approve đủ số VIN
    const allow = await vin.allowance(account, CONFIG.MUABAN_ADDR);
    if (allow.lt(vinAmount)){
      const txA = await vin.approve(CONFIG.MUABAN_ADDR, vinAmount);
      await txA.wait();
    }

    // Mã hóa thông tin buyer (base64) → seller giải mã client-side
    const cipher = btoa(unescape(encodeURIComponent(JSON.stringify(info))));

    const tx = await muaban.placeOrder(
      pid, qty, vinPerVNDWei, cipher
    );
    const rc = await tx.wait();
    toast("Đặt mua thành công.");
    hide($("#formBuy"));
    await loadMyOrders();
  }catch(e){
    console.error(e); toast(e?.data?.message || e?.message || "Đặt mua thất bại");
  }
}

/* -------------------- 12) Đơn hàng của tôi -------------------- */
$("#btnOrdersBuy").addEventListener("click", ()=>{
  show($("#ordersBuySection")); hide($("#ordersSellSection"));
  window.scrollTo({top: $("#ordersBuySection").offsetTop - 20, behavior:"smooth"});
});
$("#btnOrdersSell").addEventListener("click", ()=>{
  show($("#ordersSellSection")); hide($("#ordersBuySection"));
  window.scrollTo({top: $("#ordersSellSection").offsetTop - 20, behavior:"smooth"});
});

async function loadMyOrders(){
  if (!account) return;
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("OrderPlaced");
    const logs = await providerRead.getLogs({
      address: CONFIG.MUABAN_ADDR,
      fromBlock: 0,
      toBlock: "latest",
      topics: [topic]
    });

    ordersBuyer = [];
    ordersSeller = [];
    for (const l of logs){
      const parsed = iface.parseLog(l);
      const orderId = parsed.args.orderId.toNumber();
      const buyer = parsed.args.buyer.toLowerCase();
      const productId = parsed.args.productId.toNumber();

      // đọc order & product để xác định seller
      const o = await muaban.getOrder(orderId);
      const p = await muaban.getProduct(productId);
      const isBuyer = (buyer === account?.toLowerCase());
      const isSeller = (p.seller?.toLowerCase() === account?.toLowerCase());

      const item = { order: o, product: p, orderId, productId };
      if (isBuyer) ordersBuyer.push(item);
      if (isSeller) ordersSeller.push(item);
    }
    renderOrders();
  }catch(e){
    console.error("loadMyOrders:", e);
  }
}

function renderOrders(){
  // Buyer
  const bWrap = $("#ordersBuyList");
  bWrap.innerHTML = "";
  if (!ordersBuyer.length){
    bWrap.innerHTML = `<div class="tag">Chưa có đơn mua.</div>`;
  }else{
    ordersBuyer.sort((a,b)=>b.orderId-a.orderId).forEach(({order, product, orderId, productId})=>{
      const canConfirm = Number(order.status)===1 /* PLACED */ && order.buyer.toLowerCase()===account.toLowerCase();
      const canRefund = canConfirm && (Number(order.deadline)*1000 < Date.now());
      const card = document.createElement("div");
      card.className = "order-card";
      card.innerHTML = `
        <div class="order-row"><span class="order-strong">${escapeHtml(product.name)}</span> <span class="badge mono">#${productId}</span></div>
        <div class="order-row">Mã đơn: <span class="order-strong mono">#${orderId}</span> · Số lượng: ${order.quantity} · VIN escrow: ${ethers.utils.formatUnits(order.vinAmount,18)}</div>
        <div class="order-row">Hạn giao: ${new Date(Number(order.deadline)*1000).toLocaleString("vi-VN")}</div>
        <div class="order-row">Trạng thái: ${statusText(order.status)}</div>
        <div class="card-actions">
          ${canConfirm? `<button class="btn primary" data-action="confirm" data-oid="${orderId}">Xác nhận đã nhận</button>`:""}
          ${canRefund? `<button class="btn" data-action="refund" data-oid="${orderId}">Hoàn tiền (quá hạn)</button>`:""}
        </div>
      `;
      // attach
      const btnC = card.querySelector('[data-action="confirm"]');
      if (btnC) btnC.addEventListener("click", ()=>confirmReceipt(orderId));
      const btnR = card.querySelector('[data-action="refund"]');
      if (btnR) btnR.addEventListener("click", ()=>refundExpired(orderId));
      bWrap.appendChild(card);
    });
  }

  // Seller
  const sWrap = $("#ordersSellList");
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
        <div class="order-row">Trạng thái: ${statusText(order.status)}</div>
      `;
      sWrap.appendChild(card);
    });
  }
}

async function confirmReceipt(orderId){
  try{
    const tx = await muaban.confirmReceipt(orderId);
    await tx.wait();
    toast("Đã xác nhận nhận hàng. VIN đã giải ngân cho người bán.");
    await loadMyOrders();
  }catch(e){
    console.error(e); toast(e?.data?.message || e?.message || "Xác nhận thất bại");
  }
}
async function refundExpired(orderId){
  try{
    const tx = await muaban.refundIfExpired(orderId);
    await tx.wait();
    toast("Đã hoàn tiền về ví (đơn quá hạn).");
    await loadMyOrders();
  }catch(e){
    console.error(e); toast(e?.data?.message || e?.message || "Hoàn tiền thất bại");
  }
}

/* -------------------- 13) Utils -------------------- */
function ipfsToHttp(link){
  if (!link) return "";
  if (link.startsWith("ipfs://")){
    return "https://ipfs.io/ipfs/" + link.replace("ipfs://", "");
  }
  return link;
}
function parseUnitFromCID(desc){
  if (!desc) return "";
  const m = /^unit:(.+)$/i.exec(desc.trim());
  return m ? m[1].trim() : "";
}
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[s]));
}
function statusText(code){
  // enum OrderStatus { NONE(0), PLACED(1), RELEASED(2), REFUNDED(3) }
  const m = {0:"-",1:"Đang xử lý",2:"Đã giải ngân",3:"Đã hoàn tiền"};
  return m[Number(code)] || "-";
}

/* -------------------- 14) Gắn sự kiện UI chung -------------------- */
$("#btnConnect").addEventListener("click", connectWallet);
$("#btnDisconnect").addEventListener("click", disconnectWallet);

// Đóng modal khi click nền tối
$$(".modal").forEach(m=>{
  m.addEventListener("click", (e)=>{ if (e.target.classList.contains("modal")) hide(e.currentTarget); });
});

/* -------------------- 15) Khởi chạy -------------------- */
(async function main(){
  initProviders();
  await fetchVinToVND();
  setInterval(fetchVinToVND, 60_000); // cập nhật mỗi 60s
  // load sản phẩm (cho khách chưa kết nối ví)
  await loadAllProducts();

  // Tự ẩn menu khi chưa kết nối
  hide($("#menuBox"));
})();

/* ====================================================================
   muaban.vin — app.js (ethers v5)
   BẢN ĐÃ VÁ (v3.1 – stable):
   - Giữ nguyên cấu trúc & hành vi tốt từ bản gốc
   - Thêm tiền-kiểm đầu vào + preflight (populateTransaction + provider.call)
     để tránh “Internal JSON-RPC error.”
   - Áp dụng cho: đăng ký ví, đăng sản phẩm, cập nhật sản phẩm, đặt mua
   - parseRevert() hiển thị lý do rõ ràng theo require() trong contract
==================================================================== */

/* -------------------- 0) Cấu hình & Hằng số -------------------- */
const CONFIG = {
  CHAIN_ID: 88, // Viction mainnet
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://vicscan.xyz",

  // Địa chỉ (khớp với footer/index.html hiện tại)
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",

  // API tỷ giá
  BINANCE_VICUSDT: "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",
  COINGECKO_USDT_VND: "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",

  // Phí đăng ký 0.001 VIN (18 decimals)
  REG_FEE_WEI: ethers.BigNumber.from("1000000000000000"),
};

// ABI rút gọn đúng các hàm dùng (getProduct/getOrder/... createProduct, placeOrder, ...)
const MUABAN_ABI = [
  // Read
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"}],"name":"getProduct","outputs":[{"components":[{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"address","name":"seller","type":"address"},{"internalType":"string","name":"name","type":"string"},{"internalType":"string","name":"descriptionCID","type":"string"},{"internalType":"string","name":"imageCID","type":"string"},{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"bool","name":"active","type":"bool"},{"internalType":"uint64","name":"createdAt","type":"uint64"},{"internalType":"uint64","name":"updatedAt","type":"uint64"}],"internalType":"struct MuabanVND.Product","name":"","type":"tuple"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"oid","type":"uint256"}],"name":"getOrder","outputs":[{"components":[{"internalType":"uint256","name":"orderId","type":"uint256"},{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"address","name":"buyer","type":"address"},{"internalType":"address","name":"seller","type":"address"},{"internalType":"uint256","name":"quantity","type":"uint256"},{"internalType":"uint256","name":"vinAmount","type":"uint256"},{"internalType":"uint256","name":"placedAt","type":"uint256"},{"internalType":"uint256","name":"deadline","type":"uint256"},{"internalType":"enum MuabanVND.OrderStatus","name":"status","type":"uint8"},{"internalType":"string","name":"buyerInfoCipher","type":"string"}],"internalType":"struct MuabanVND.Order","name":"","type":"tuple"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"seller","type":"address"}],"name":"getSellerProductIds","outputs":[{"internalType":"uint256[]","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
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
  // Events
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
let vinVND = 0;                                  // 1 VIN = ? VND (floor)
let productsCache = [];
let ordersBuyer = [];
let ordersSeller = [];

/* -------------------- 2) DOM helpers -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show = (el)=>{
  if(!el) return;
  el.classList.remove("hidden");
  if(el.classList.contains("modal")){
    document.body.classList.add("no-scroll");
    const first = el.querySelector('input,select,textarea,button');
    if(first){ setTimeout(()=>{ try{ first.focus(); }catch(e){} }, 50); }
  }
};
const hide = (el)=>{
  if(!el) return;
  el.classList.add("hidden");
  if(el.classList.contains("modal")){
    const anyOpen = Array.from(document.querySelectorAll('.modal'))
      .some(m=>!m.classList.contains('hidden'));
    if(!anyOpen){ document.body.classList.remove("no-scroll"); }
  }
};
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`:"";
const fmt0=(x)=>Number(x).toLocaleString("vi-VN", {maximumFractionDigits:0});
const toast=(m)=>{ alert(m); };

/* ---------- 3) Xử lý lỗi revert (thông điệp thân thiện) ---------- */
function parseRevert(err){
  const raw = err?.error?.message || err?.data?.message || err?.reason || err?.message || "";
  const map = {
    NOT_REGISTERED: "Ví này chưa đăng ký. Hãy bấm ‘Đăng ký’ trước.",
    PRICE_REQUIRED: "Giá bán (VND) phải > 0.",
    DELIVERY_REQUIRED: "Thời gian giao hàng (ngày) phải ≥ 1.",
    PAYOUT_WALLET_ZERO: "Ví nhận thanh toán không được để trống.",
    NOT_SELLER: "Bạn không phải người bán của sản phẩm này.",
    PRODUCT_NOT_ACTIVE: "Sản phẩm đang tắt bán.",
    PRODUCT_NOT_FOUND: "Không tìm thấy sản phẩm.",
    QUANTITY_REQUIRED: "Số lượng phải ≥ 1.",
    VIN_PER_VND_REQUIRED: "Tỷ giá chưa sẵn sàng. Vui lòng thử lại.",
  };
  for (const k in map){ if (raw.includes(k)) return map[k]; }
  const m = /execution reverted(?: with reason string)?:\s*([^\n]+)/i.exec(raw);
  if (m) return m[1];
  // Thử decode Error(string) từ data hex (nếu có)
  try{
    const data = err?.error?.data || err?.data;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10){
      const iface = new ethers.utils.Interface(["function Error(string)"]);
      const reason = iface.parseError(data)?.args?.[0];
      if (reason) return String(reason);
    }
  }catch(_){}
  return raw || "Giao dịch bị từ chối/không hợp lệ.";
}

/* ---------- 4) Chuẩn hoá số tiền VND: "1.200.000" / "1,200,000" -> 1200000 ---------- */
function parseVND(input) {
  const raw = String(input || "").trim();
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return NaN;
  const n = Number(digits);
  return Number.isFinite(n) ? n : NaN;
}

/* -------------------- 5) Khởi tạo Provider/Contract -------------------- */
function initProviders(){
  providerRead = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
  if (window.ethereum) {
    providerWrite = new ethers.providers.Web3Provider(window.ethereum, "any");
  }
  muaban = new ethers.Contract(CONFIG.MUABAN_ADDR, MUABAN_ABI, providerRead);
  vin    = new ethers.Contract(CONFIG.VIN_ADDR, ERC20_ABI, providerRead);
}

/* -------------------- 6) Tỷ giá VIN/VND -------------------- */
async function fetchVinToVND(){
  try{
    const [vicPriceRes, usdtRes] = await Promise.all([
      fetch(CONFIG.BINANCE_VICUSDT),
      fetch(CONFIG.COINGECKO_USDT_VND)
    ]);
    const vicJson = await vicPriceRes.json();
    const usdtJson = await usdtRes.json();

    const vicUsdt = Number(vicJson.price);
    const usdtVnd = Number(usdtJson?.tether?.vnd || 0);
    if (!vicUsdt || !usdtVnd) throw new Error("Không lấy được giá");

    const val = vicUsdt * 100 * usdtVnd; // 1 VIN = (VIC/USDT * 100) * (USDT/VND)
    vinVND = Math.floor(val);
    const el = document.querySelector('#vinPrice');
    if (el) el.textContent = `1 VIN = ${vinVND.toLocaleString("vi-VN")} VND`;

    // VIN wei per 1 VND = ceil(1e18 / vinVND)
    const ONE = ethers.BigNumber.from("1000000000000000000");
    vinPerVNDWei = ONE.div(vinVND);
    if (ONE.mod(vinVND).gt(0)) vinPerVNDWei = vinPerVNDWei.add(1);
  }catch(e){
    console.error("fetchVinToVND:", e);
    const el = document.querySelector('#vinPrice');
    if (el && vinPerVNDWei.isZero()) el.textContent = "Đang tải giá…";
  }
}

/* -------------------- 7) Kết nối ví & trạng thái -------------------- */
async function connectWallet(){
  if (!window.ethereum) { toast("Vui lòng cài MetaMask / Wallet"); return; }
  await providerWrite.send("eth_requestAccounts", []);
  const net = await providerWrite.getNetwork();
  if (Number(net.chainId) !== CONFIG.CHAIN_ID){
    toast("Sai mạng. Vui lòng chọn Viction (chainId=88).");
  }
  signer = providerWrite.getSigner();
  account = (await signer.getAddress()).toLowerCase();

  hide(document.querySelector("#btnConnect"));
  show(document.querySelector("#walletBox"));
  const aEl = document.querySelector("#accountShort");
  if (aEl){
    aEl.textContent = short(account);
    aEl.href = `${CONFIG.EXPLORER}/address/${account}`;
  }

  const [vinBal, vicBal] = await Promise.all([
    vin.connect(providerWrite).balanceOf(account),
    providerWrite.getBalance(account)
  ]);
  const v1 = document.querySelector('#vinBalance');
  const v2 = document.querySelector('#vicBalance');
  if (v1) v1.textContent = `VIN: ${parseFloat(ethers.utils.formatUnits(vinBal, 18)).toFixed(4)}`;
  if (v2) v2.textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;

  isRegistered = await muaban.connect(providerWrite).registered(account);
  refreshMenu();

  muaban = muaban.connect(signer);
  vin    = vin.connect(signer);

  await Promise.all([loadAllProducts(), loadMyOrders()]);
}

function disconnectWallet(){
  account = null; signer = null;
  hide(document.querySelector("#walletBox"));
  show(document.querySelector("#btnConnect"));
  const v1 = document.querySelector('#vinBalance');
  const v2 = document.querySelector('#vicBalance');
  if (v1) v1.textContent = "VIN: 0";
  if (v2) v2.textContent = "VIC: 0";
  isRegistered = false;
  refreshMenu();
}

function refreshMenu(){
  const btnReg = document.querySelector('#btnRegister');
  const btnCrt = document.querySelector('#btnCreate');
  const btnOB  = document.querySelector('#btnOrdersBuy');
  const btnOS  = document.querySelector('#btnOrdersSell');
  const menu   = document.querySelector('#menuBox');

  if (!account){
    if (btnReg){ btnReg.classList.remove('hidden'); btnReg.disabled = true; }
    if (btnCrt) btnCrt.classList.add('hidden');
    if (btnOB)  btnOB.classList.add('hidden');
    if (btnOS)  btnOS.classList.add('hidden');
    return;
  }
  if (btnReg) btnReg.disabled = false;
  if (!isRegistered){
    if (btnReg) btnReg.classList.remove('hidden');
    if (btnCrt) btnCrt.classList.add('hidden');
    if (btnOB)  btnOB.classList.add('hidden');
    if (btnOS)  btnOS.classList.add('hidden');
  } else {
    if (btnReg) btnReg.classList.add('hidden');
    if (btnCrt) btnCrt.classList.remove('hidden');
    if (btnOB)  btnOB.classList.remove('hidden');
    if (btnOS)  btnOS.classList.remove('hidden');
  }
  if (menu) menu.classList.remove('hidden');
}

/* -------------------- 8) Sản phẩm: load qua sự kiện -------------------- */
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
  const wrap = document.querySelector('#productList');
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!list.length){
    wrap.innerHTML = `<div class="tag">Chưa có sản phẩm.</div>`;
    return;
  }
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
  if (!account) return "";
  if (p.seller && p.seller.toLowerCase() === account.toLowerCase()){
    return `<button class="btn" data-action="update" data-pid="${pid}">Cập nhật sản phẩm</button>`;
  }
  if (isRegistered && p.active){
    return `<button class="btn primary" data-action="buy" data-pid="${pid}">Mua</button>`;
  }
  return "";
}
function attachCardHandlers(card, pid, p){
  const btnBuy = card.querySelector('[data-action="buy"]');
  if (btnBuy){ btnBuy.addEventListener("click", ()=>{ openBuyForm(pid, p); }); }
  const btnUpd = card.querySelector('[data-action="update"]');
  if (btnUpd){ btnUpd.addEventListener("click", ()=>{ openUpdateForm(pid, p); }); }
}

/* -------------------- 9) Tìm kiếm -------------------- */
const btnSearch = document.querySelector('#btnSearch');
if (btnSearch){
  btnSearch.addEventListener("click", ()=>{
    const q = (document.querySelector('#searchInput')?.value||"").trim().toLowerCase();
    if (!q) { renderProducts(productsCache); return; }
    const list = productsCache.filter(({data})=> data.name.toLowerCase().includes(q));
    renderProducts(list);
  });
}

/* -------------------- 10) Đăng ký ví -------------------- */
const btnRegister = document.querySelector('#btnRegister');
if (btnRegister){
  btnRegister.addEventListener("click", async ()=>{
    if (!account){ toast("Hãy kết nối ví trước."); return; }
    try{
      const allowance = await vin.allowance(account, CONFIG.MUABAN_ADDR);
      if (allowance.lt(CONFIG.REG_FEE_WEI)){
        const txA = await vin.approve(CONFIG.MUABAN_ADDR, CONFIG.REG_FEE_WEI);
        await txA.wait();
      }
      // mô phỏng để bắt lỗi rõ ràng
      try{
        const txData = await muaban.populateTransaction.payRegistration();
        txData.from = account;
        await providerWrite.call(txData);
      } catch(simErr){
        toast(parseRevert(simErr)); return;
      }

      const tx = await muaban.payRegistration();
      await tx.wait();
      isRegistered = true;
      toast("Đăng ký thành công.");
      refreshMenu();
    }catch(e){ console.error(e); toast(parseRevert(e)); }
  });
}

/* -------------------- 11) Đăng sản phẩm -------------------- */
const btnCreate = document.querySelector('#btnCreate');
if (btnCreate){ btnCreate.addEventListener("click", ()=> openCreateForm()); }
const closeCreate = document.querySelector('.modal#formCreate .close');
if (closeCreate){ closeCreate.addEventListener("click", ()=> hide(document.querySelector('#formCreate'))); }
const btnSubmitCreate = document.querySelector('#btnSubmitCreate');
if (btnSubmitCreate){ btnSubmitCreate.addEventListener("click", submitCreate); }

function openCreateForm(){
  if (!isRegistered){ toast("Bạn cần đăng ký trước."); return; }
  document.querySelector('#createName').value = "";
  document.querySelector('#createIPFS').value = "";
  document.querySelector('#createUnit').value = "";
  document.querySelector('#createPrice').value = "";
  document.querySelector('#createWallet').value = account || "";
  document.querySelector('#createDays').value = "3";
  show(document.querySelector('#formCreate'));
}

async function submitCreate(){
  try{
    const name = (document.querySelector('#createName').value||"").trim();
    const ipfs = (document.querySelector('#createIPFS').value||"").trim();
    const unit = (document.querySelector('#createUnit').value||"").trim();
    const wallet = (document.querySelector('#createWallet').value||"").trim();
    const days = parseInt((document.querySelector('#createDays').value||"").trim(), 10);

    // Giá: chấp nhận 1.200.000 / 1,200,000 / 1200000
    const priceInput = parseVND(document.querySelector('#createPrice').value);

    if (!name || !ipfs || !unit || !wallet){ toast("Vui lòng nhập đủ thông tin."); return; }
    if (!ethers.utils.isAddress(wallet)){ toast("Ví nhận thanh toán không hợp lệ (0x...)."); return; }
    if (!Number.isInteger(days) || days <= 0){ toast("Thời gian giao hàng (ngày) phải ≥ 1."); return; }
    if (!Number.isFinite(priceInput) || priceInput <= 0){ toast("Giá bán (VND) phải là số dương."); return; }
    if (!isRegistered){ toast("Ví này chưa đăng ký. Vui lòng bấm ‘Đăng ký’. "); return; }

    const priceVND = ethers.BigNumber.from(String(priceInput));
    const descriptionCID = `unit:${unit}`;
    const imageCID = ipfs;

    // Preflight: mô phỏng để bắt revert reason rõ ràng
    try{
      const txData = await muaban.populateTransaction.createProduct(
        name, descriptionCID, imageCID, priceVND, days, wallet, true
      );
      txData.from = account; // để qua modifier onlyRegistered
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // Gửi tx thật
    const tx = await muaban.createProduct(name, descriptionCID, imageCID, priceVND, days, wallet, true);
    await tx.wait();

    toast("Đăng sản phẩm thành công.");
    hide(document.querySelector('#formCreate'));
    await loadAllProducts();
  }catch(e){ console.error(e); toast(parseRevert(e)); }
}

/* -------------------- 12) Cập nhật sản phẩm -------------------- */
const closeUpdate = document.querySelector('.modal#formUpdate .close');
if (closeUpdate){ closeUpdate.addEventListener("click", ()=> hide(document.querySelector('#formUpdate'))); }
const btnSubmitUpdate = document.querySelector('#btnSubmitUpdate');
if (btnSubmitUpdate){ btnSubmitUpdate.addEventListener("click", submitUpdate); }

function openUpdateForm(pid, p){
  document.querySelector('#updatePid').value = String(pid);
  document.querySelector('#updatePrice').value = String(p.priceVND);
  document.querySelector('#updateDays').value = String(p.deliveryDaysMax);
  document.querySelector('#updateWallet').value = String(p.payoutWallet);
  document.querySelector('#updateActive').checked = !!p.active;
  show(document.querySelector('#formUpdate'));
}

async function submitUpdate(){
  try{
    const pid = Number(document.querySelector('#updatePid').value);
    const wallet = (document.querySelector('#updateWallet').value||"").trim();
    const days = parseInt((document.querySelector('#updateDays').value||"").trim(), 10);
    const priceInput = parseVND(document.querySelector('#updatePrice').value);

    const active = !!document.querySelector('#updateActive').checked;

    if (!Number.isFinite(priceInput) || priceInput <= 0){ toast("Giá bán (VND) phải > 0."); return; }
    if (!Number.isInteger(days) || days <= 0){ toast("Thời gian giao hàng (ngày) phải ≥ 1."); return; }
    if (!ethers.utils.isAddress(wallet)){ toast("Ví nhận thanh toán không hợp lệ (0x...)."); return; }

    const priceVND = ethers.BigNumber.from(String(priceInput));

    try{
      const txData = await muaban.populateTransaction.updateProduct(pid, priceVND, days, wallet, active);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    const tx = await muaban.updateProduct(pid, priceVND, days, wallet, active);
    await tx.wait();
    toast("Cập nhật thành công.");
    hide(document.querySelector('#formUpdate'));
    await loadAllProducts();
  }catch(e){ console.error(e); toast(parseRevert(e)); }
}

/* -------------------- 13) Mua hàng -------------------- */
const closeBuy = document.querySelector('.modal#formBuy .close');
if (closeBuy){ closeBuy.addEventListener("click", ()=> hide(document.querySelector('#formBuy'))); }
const btnSubmitBuy = document.querySelector('#btnSubmitBuy');
if (btnSubmitBuy){ btnSubmitBuy.addEventListener("click", submitBuy); }
const buyQty = document.querySelector('#buyQty');
if (buyQty){ buyQty.addEventListener("input", recalcBuyTotal); }

let currentBuying = null; // {pid, product}

function openBuyForm(pid, p){
  currentBuying = { pid, product: p };
  const info = document.querySelector('#buyProductInfo');
  if (info){
    info.innerHTML = `
      <div class="order-row">
        <span class="order-strong">${escapeHtml(p.name)}</span>
        <span class="badge mono">#${pid}</span>
      </div>
      <div class="order-row">
        Giá: <span class="order-strong">${fmt0(p.priceVND)} VND</span> · Giao tối đa ${p.deliveryDaysMax} ngày
      </div>`;
  }
  document.querySelector('#buyName').value = "";
  document.querySelector('#buyAddress').value = "";
  document.querySelector('#buyPhone').value = "";
  document.querySelector('#buyNote').value = "";
  document.querySelector('#buyQty').value = 1;
  recalcBuyTotal();
  show(document.querySelector('#formBuy'));
}

function recalcBuyTotal(){
  try{
    if (!currentBuying) return;
    const qty = Math.max(1, Number(document.querySelector('#buyQty').value||1));
    const totalVND = ethers.BigNumber.from(String(currentBuying.product.priceVND)).mul(qty);
    const vinAmt = totalVND.mul(vinPerVNDWei);
    const el = document.querySelector('#buyTotalVIN');
    if (el) el.textContent = `Tổng VIN cần trả: ${ethers.utils.formatUnits(vinAmt, 18)} VIN`;
  }catch(e){
    const el = document.querySelector('#buyTotalVIN');
    if (el) el.textContent = `Tổng VIN cần trả: ...`;
  }
}

async function submitBuy(){
  if (!currentBuying){ toast("Thiếu thông tin sản phẩm."); return; }
  try{
    const qty = Math.max(1, Number(document.querySelector('#buyQty').value||1));
    const info = {
      name: (document.querySelector('#buyName').value||"").trim(),
      addr: (document.querySelector('#buyAddress').value||"").trim(),
      phone: (document.querySelector('#buyPhone').value||"").trim(),
      note: (document.querySelector('#buyNote').value||"").trim()
    };
    if (!info.name || !info.addr || !info.phone){ toast("Vui lòng nhập đủ họ tên, địa chỉ, SĐT."); return; }
    if (vinPerVNDWei.isZero()){ toast("Tỷ giá VIN/VND chưa sẵn sàng, vui lòng thử lại."); return; }
    if (!isRegistered){ toast("Ví này chưa đăng ký. Vui lòng bấm ‘Đăng ký’. "); return; }

    const pid = currentBuying.pid;
    const totalVND = ethers.BigNumber.from(String(currentBuying.product.priceVND)).mul(qty);
    const vinAmount = totalVND.mul(vinPerVNDWei);

    // đảm bảo allowance đủ
    const allow = await vin.allowance(account, CONFIG.MUABAN_ADDR);
    if (allow.lt(vinAmount)){
      const txA = await vin.approve(CONFIG.MUABAN_ADDR, vinAmount);
      await txA.wait();
    }

    const cipher = btoa(unescape(encodeURIComponent(JSON.stringify(info))));

    try{
      const txData = await muaban.populateTransaction.placeOrder(pid, qty, vinPerVNDWei, cipher);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    const tx = await muaban.placeOrder(pid, qty, vinPerVNDWei, cipher);
    await tx.wait();
    toast("Đặt mua thành công.");
    hide(document.querySelector('#formBuy'));
    await loadMyOrders();
  }catch(e){ console.error(e); toast(parseRevert(e)); }
}

/* -------------------- 14) Đơn hàng của tôi -------------------- */
const btnOrdersBuy = document.querySelector('#btnOrdersBuy');
if (btnOrdersBuy){
  btnOrdersBuy.addEventListener("click", ()=>{
    show(document.querySelector('#ordersBuySection')); hide(document.querySelector('#ordersSellSection'));
    window.scrollTo({top: document.querySelector('#ordersBuySection').offsetTop - 20, behavior:"smooth"});
  });
}
const btnOrdersSell = document.querySelector('#btnOrdersSell');
if (btnOrdersSell){
  btnOrdersSell.addEventListener("click", ()=>{
    show(document.querySelector('#ordersSellSection')); hide(document.querySelector('#ordersBuySection'));
    window.scrollTo({top: document.querySelector('#ordersSellSection').offsetTop - 20, behavior:"smooth"});
  });
}

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

      const o = await muaban.getOrder(orderId);
      const p = await muaban.getProduct(productId);
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
  // Buyer
  const bWrap = document.querySelector('#ordersBuyList');
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
          <div class="order-row">Mã đơn: <span class="order-strong mono">#${orderId}</span> · Số lượng: ${order.quantity} · VIN escrow: ${ethers.utils.formatUnits(order.vinAmount,18)}</div>
          <div class="order-row">Hạn giao: ${new Date(Number(order.deadline)*1000).toLocaleString("vi-VN")}</div>
          <div class="order-row">Trạng thái: ${statusText(order.status)}</div>
          <div class="card-actions">
            ${canConfirm? `<button class="btn primary" data-action="confirm" data-oid="${orderId}">Xác nhận đã nhận</button>`:""}
            ${canRefund? `<button class="btn" data-action="refund" data-oid="${orderId}">Hoàn tiền (quá hạn)</button>`:""}
          </div>`;
        const btnC = card.querySelector('[data-action="confirm"]');
        if (btnC) btnC.addEventListener("click", ()=>confirmReceipt(orderId));
        const btnR = card.querySelector('[data-action="refund"]');
        if (btnR) btnR.addEventListener("click", ()=>refundExpired(orderId));
        bWrap.appendChild(card);
      });
    }
  }

  // Seller
  const sWrap = document.querySelector('#ordersSellList');
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
    const tx = await muaban.confirmReceipt(orderId);
    await tx.wait();
    toast("Đã xác nhận nhận hàng. VIN đã giải ngân cho người bán.");
    await loadMyOrders();
  }catch(e){ console.error(e); toast(parseRevert(e)); }
}
async function refundExpired(orderId){
  try{
    try{
      const txData = await muaban.populateTransaction.refundIfExpired(orderId);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }
    const tx = await muaban.refundIfExpired(orderId);
    await tx.wait();
    toast("Đã hoàn tiền về ví (đơn quá hạn).");
    await loadMyOrders();
  }catch(e){ console.error(e); toast(parseRevert(e)); }
}

/* -------------------- 15) Utils -------------------- */
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
  return String(str).replace(/[&<>"']/g, s=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;" }[s]));
}
function statusText(code){
  const m = {0:"-",1:"Đang xử lý",2:"Đã giải ngân",3:"Đã hoàn tiền"};
  return m[Number(code)] || "-";
}

/* -------------------- 16) Gắn sự kiện UI chung -------------------- */
const btnConnect = document.querySelector('#btnConnect');
if (btnConnect){ btnConnect.addEventListener("click", connectWallet); }
const btnDisconnect = document.querySelector('#btnDisconnect');
if (btnDisconnect){ btnDisconnect.addEventListener("click", disconnectWallet); }

// Đóng modal khi click nền tối
$$('.modal').forEach(m=>{
  m.addEventListener("click", (e)=>{ if (e.target.classList.contains('modal')) hide(e.currentTarget); });
});

/* -------------------- 17) Khởi chạy -------------------- */
(async function main(){
  initProviders();
  await fetchVinToVND();
  setInterval(fetchVinToVND, 60_000);
  await loadAllProducts(); // cho khách chưa kết nối ví
  const menu = document.querySelector('#menuBox');
  if (menu) menu.classList.add('hidden');
})();

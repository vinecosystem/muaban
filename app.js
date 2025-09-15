/* ====================================================================
   muaban.vin — app.js (ethers v5, drop-in)
   - Giá sản phẩm nhập VND (số nguyên); thanh toán VIN (tự quy đổi).
   - Fix "Internal JSON-RPC error." bằng preflight callStatic + validate.
   - Tương thích MetaMask Mobile: ép chain 88, tránh NaN/undefined, BigNumber.toString().
   - Tính năng: Kết nối ví • Đăng ký • Đăng sản phẩm • Mua hàng (có SỐ LƯỢNG & tổng VIN)
                 • Danh sách sản phẩm • Đơn mua/Đơn bán • Bật/tắt sản phẩm
==================================================================== */

/* -------------------- 0) Cấu hình -------------------- */
const CONFIG = {
  CHAIN_ID: 88,                                        // Viction mainnet
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://scan.viction.xyz",

  // Địa chỉ theo mô tả bạn đã cung cấp (VIC mainnet)
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",

  // Tuỳ chỉnh quy đổi nếu bạn pegged VIN theo VIC (dùng nếu muốn):
  // Ví dụ: nếu 1 VIN = 100 VIC, đặt VIN_PER_VIC=100.
  // Nếu không dùng peg → để 1 (mặc định tính VIN theo thị giá VIC/USDT).
  VIN_PER_VIC: 1,

  // API lấy giá (có thể lỗi CORS ở một số môi trường; code đã có fallback hiển thị "Loading price...")
  BINANCE_VIC: "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",
  FX_USD_VND:  "https://api.exchangerate.host/latest?base=USD&symbols=VND"
};

/* -------------------- 1) Biến toàn cục -------------------- */
let providerRead, providerWrite, signer, account;
let muabanRead, muaban, vinRead, vin;

let isRegistered = false;
let vinDecimals = 18;

// VIN-wei cho 1 VND (uint256, dùng truyền vào placeOrder)
let vinPerVNDWei = ethers.BigNumber.from("0");

// cache sản phẩm / đơn hàng
let productsCache = new Map();   // pid -> product
let ordersBuyCache = [];         // đơn mua của tôi
let ordersSellCache = [];        // đơn bán (sp của tôi)

/* -------------------- 2) DOM helpers -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show=(el)=>el && el.classList.remove("hidden");
const hide=(el)=>el && el.classList.add("hidden");
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`:"";
const fmt2=(x)=>Number(x).toFixed(2);
const fmt4=(x)=>Number(x).toFixed(4);

/* -------------------- 3) Guard & tiện ích -------------------- */
const isAddr = (a)=>/^0x[a-fA-F0-9]{40}$/.test(String(a||"").trim());
const toUInt = (v)=>{ const n = Number(String(v||"").trim()); if(!Number.isFinite(n)||n<=0) throw new Error("Giá trị phải là số dương"); return Math.floor(n); };
const ensure = (cond, msg)=>{ if(!cond) throw new Error(msg); };

const normalizeIPFS = (s)=>{
  s = String(s||"").trim();
  if (!s) return s;
  if (s.startsWith("ipfs://")) return s;
  if (s.includes("/ipfs/")) return s;
  return s;
};

// Hiển thị lỗi TX dễ hiểu (thay cho “Internal JSON-RPC error.”)
const showTxError = (e, fallback) => {
  const m = e?.error?.message || e?.data?.message || e?.message || fallback || "Tx failed";
  if (m.includes("ONLY_REGISTERED") || m.includes("NOT_REGISTERED")) alert("Ví chưa đăng ký (0.001 VIN).");
  else if (m.includes("PRICE_REQUIRED")) alert("Giá VND phải > 0.");
  else if (m.includes("DELIVERY_REQUIRED")) alert("Số ngày giao hàng phải > 0.");
  else if (m.includes("PAYOUT_WALLET_ZERO")) alert("Ví nhận thanh toán không hợp lệ.");
  else alert(m);
  console.error(e);
};

// Gọi thử callStatic để bắt revert trước khi gửi tx thật
const preflight = async (fn, args, overrides={})=>{
  try { await fn.callStatic(...args, overrides); return true; }
  catch(e){ showTxError(e, "Kiểm tra tham số thất bại."); return false; }
};

// Bảo đảm đã ở chain 88 (Viction) — chạy được trên MetaMask Mobile
async function ensureChain88(){
  const hex88 = "0x58"; // 88
  const nw = await providerWrite.getNetwork();
  if (Number(nw.chainId) === 88) return;
  try{
    await window.ethereum.request({ method:"wallet_switchEthereumChain", params:[{ chainId: hex88 }]});
  }catch(e){
    if (e?.code === 4902){
      await window.ethereum.request({
        method:"wallet_addEthereumChain",
        params:[{
          chainId: hex88,
          chainName: "Viction Mainnet",
          rpcUrls: [CONFIG.RPC_URL],
          nativeCurrency: { name:"VIC", symbol:"VIC", decimals:18 },
          blockExplorerUrls: [CONFIG.EXPLORER]
        }]
      });
    } else { throw e; }
  }
}

/* -------------------- 4) ABI rút gọn -------------------- */
// VIN ERC20
const VIN_ABI = [
  {"inputs":[{"internalType":"address","name":"owner","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"decimals","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"}],"name":"allowance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"}
];

// Muaban (đủ các hàm đang dùng)
const MUABAN_ABI = [
  {"inputs":[{"internalType":"address","name":"vinToken","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"orderId","type":"uint256"},{"indexed":true,"internalType":"uint256","name":"productId","type":"uint256"},{"indexed":true,"internalType":"address","name":"buyer","type":"address"},{"indexed":false,"internalType":"uint256","name":"quantity","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"vinAmount","type":"uint256"}],"name":"OrderPlaced","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"orderId","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"vinAmount","type":"uint256"}],"name":"OrderRefunded","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"orderId","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"vinAmount","type":"uint256"}],"name":"OrderReleased","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"productId","type":"uint256"},{"indexed":true,"internalType":"address","name":"seller","type":"address"},{"indexed":false,"internalType":"string","name":"name","type":"string"},{"indexed":false,"internalType":"uint256","name":"priceVND","type":"uint256"}],"name":"ProductCreated","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"productId","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"priceVND","type":"uint256"},{"indexed":false,"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"indexed":false,"internalType":"bool","name":"active","type":"bool"}],"name":"ProductUpdated","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"user","type":"address"}],"name":"Registered","type":"event"},
  {"inputs":[],"name":"REG_FEE","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"registered","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"}],"name":"getProduct","outputs":[{"components":[{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"address","name":"seller","type":"address"},{"internalType":"bool","name":"active","type":"bool"},{"internalType":"string","name":"name","type":"string"},{"internalType":"string","name":"descriptionCID","type":"string"},{"internalType":"string","name":"imageCID","type":"string"}],"internalType":"struct Product","name":"","type":"tuple"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"oid","type":"uint256"}],"name":"getOrder","outputs":[{"components":[{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"uint256","name":"quantity","type":"uint256"},{"internalType":"uint256","name":"vinAmount","type":"uint256"},{"internalType":"uint256","name":"deadline","type":"uint256"},{"internalType":"address","name":"buyer","type":"address"},{"internalType":"address","name":"seller","type":"address"},{"internalType":"bool","name":"released","type":"bool"},{"internalType":"bool","name":"refunded","type":"bool"},{"internalType":"string","name":"buyerInfoCipher","type":"string"}],"internalType":"struct Order","name":"","type":"tuple"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"seller","type":"address"}],"name":"getSellerProductIds","outputs":[{"internalType":"uint256[]","name":"","type":"uint256[]"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"payRegistration","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"string","name":"name","type":"string"},{"internalType":"string","name":"descriptionCID","type":"string"},{"internalType":"string","name":"imageCID","type":"string"},{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"bool","name":"active","type":"bool"}],"name":"createProduct","outputs":[{"internalType":"uint256","name":"productId","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"},{"internalType":"uint256","name":"newPriceVND","type":"uint256"},{"internalType":"uint32","name":"newDeliveryDaysMax","type":"uint32"},{"internalType":"address","name":"newPayoutWallet","type":"address"},{"internalType":"bool","name":"newActive","type":"bool"}],"name":"updateProduct","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"},{"internalType":"bool","name":"active","type":"bool"}],"name":"setProductActive","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"uint256","name":"quantity","type":"uint256"},{"internalType":"uint256","name":"vinPerVND","type":"uint256"},{"internalType":"string","name":"buyerInfoCipher","type":"string"}],"name":"placeOrder","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],"name":"confirmReceipt","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],"name":"refundIfExpired","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[],"name":"vin","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"vinDecimals","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"}
];

/* -------------------- 5) Khởi tạo provider & contract -------------------- */
function boot(){
  providerRead  = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
  providerWrite = window.ethereum ? new ethers.providers.Web3Provider(window.ethereum) : null;

  muabanRead = new ethers.Contract(CONFIG.MUABAN_ADDR, MUABAN_ABI, providerRead);
  vinRead    = new ethers.Contract(CONFIG.VIN_ADDR,    VIN_ABI,    providerRead);

  // gắn handler UI
  bindUI();

  // tải tỷ giá VIN/VND (không chặn render; khi xong sẽ cập nhật UI)
  fetchVinToVND().catch(console.warn);
}
document.addEventListener("DOMContentLoaded", boot);

/* -------------------- 6) UI Binding -------------------- */
function bindUI(){
  $("#btnConnect")?.addEventListener("click", connectWallet);

  $("#btnRegister")?.addEventListener("click", onRegister);

  $("#btnCreate")?.addEventListener("click", ()=> show($("#formCreate")));
  $("#btnCloseCreate")?.addEventListener("click", ()=> hide($("#formCreate")));
  $("#btnSubmitCreate")?.addEventListener("click", onSubmitCreate);

  $("#btnOrdersBuy")?.addEventListener("click", ()=>{ show($("#ordersBuy")); hide($("#ordersSell")); hide($("#formCreate")); });
  $("#btnOrdersSell")?.addEventListener("click", ()=>{ show($("#ordersSell")); hide($("#ordersBuy")); hide($("#formCreate")); });

  $("#btnCloseBuy")?.addEventListener("click", ()=> hide($("#formBuy")));
  $("#btnSubmitBuy")?.addEventListener("click", onSubmitBuy);

  $("#searchBtn")?.addEventListener("click", applySearch);
  $("#searchInput")?.addEventListener("keydown", (e)=>{ if(e.key==="Enter") applySearch(); });
}

/* -------------------- 7) Kết nối ví -------------------- */
async function connectWallet(){
  try{
    if (!window.ethereum){ alert("Vui lòng cài MetaMask."); return; }

    await providerWrite.send("eth_requestAccounts", []);
    await ensureChain88();

    signer  = providerWrite.getSigner();
    account = (await signer.getAddress()).toLowerCase();

    muaban = muabanRead.connect(signer);
    vin    = vinRead.connect(signer);

    // lấy decimals của VIN (từ contract)
    try { vinDecimals = Number(await muaban.vinDecimals()); } catch { vinDecimals = Number(await vin.decimals()); }

    // UI header
    hide($("#btnConnect"));
    show($("#walletBox"));
    $("#accountShort").textContent = short(account);
    $("#accountShort").href = `${CONFIG.EXPLORER}/address/${account}`;

    // số dư
    const [vinBal, vicBal] = await Promise.all([
      vin.balanceOf(account),
      providerWrite.getBalance(account)
    ]);
    $("#vinBalance").textContent = `VIN: ${parseFloat(ethers.utils.formatUnits(vinBal, vinDecimals)).toFixed(4)}`;
    $("#vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;

    // đăng ký?
    isRegistered = await muaban.registered(account);
    refreshMenu();

    // dữ liệu
    await Promise.all([loadAllProducts(), loadMyOrders()]);
  }catch(e){
    showTxError(e, "Kết nối ví thất bại.");
  }
}

function refreshMenu(){
  const btnReg = $("#btnRegister");
  const btnC   = $("#btnCreate");
  const btnB   = $("#btnOrdersBuy");
  const btnS   = $("#btnOrdersSell");
  if (isRegistered){
    hide(btnReg); show(btnC); show(btnB); show(btnS);
  }else{
    show(btnReg); hide(btnC); hide(btnB); hide(btnS);
  }
}

/* -------------------- 8) Đăng ký ví -------------------- */
async function onRegister(){
  try{
    ensure(account, "Hãy kết nối ví.");
    await ensureChain88();

    // Lấy phí đăng ký từ contract (0.001 VIN)
    const fee = await muaban.REG_FEE();

    // approve nếu thiếu
    const cur = await vin.allowance(account, CONFIG.MUABAN_ADDR);
    if (cur.lt(fee)){
      const txA = await vin.approve(CONFIG.MUABAN_ADDR, fee.toString());
      await txA.wait();
    }

    // preflight
    const ok = await preflight(muaban.payRegistration, []);
    if (!ok) return;

    const tx = await muaban.payRegistration();
    await tx.wait();

    isRegistered = true;
    refreshMenu();
    alert("Đăng ký thành công.");
  }catch(e){
    showTxError(e, "Đăng ký thất bại.");
  }
}

/* -------------------- 9) Đăng sản phẩm -------------------- */
async function onSubmitCreate(){
  try{
    ensure(account, "Hãy kết nối ví.");
    await ensureChain88();

    // Lấy & validate input
    const name  = String($("#createName").value||"").trim();
    const ipfs  = normalizeIPFS($("#createIPFS").value);
    const unit  = String($("#createUnit").value||"").trim();
    const priceVND = toUInt($("#createPrice").value);        // số nguyên VND
    const wallet  = String($("#createWallet").value||"").trim();
    const days    = toUInt($("#createDays").value);          // số ngày giao

    ensure(name.length>0 && name.length<=500, "Tên sản phẩm không hợp lệ.");
    ensure(ipfs.length>0, "Link IPFS không hợp lệ.");
    ensure(unit.length>0, "Đơn vị tính không hợp lệ.");
    ensure(isAddr(wallet), "Ví nhận thanh toán không hợp lệ.");

    // ghi đơn vị vào descriptionCID để UI hiển thị
    const descriptionCID = `unit:${unit}`;
    const imageCID       = ipfs;

    const args = [name, descriptionCID, imageCID, String(priceVND), days, wallet, true];

    // preflight để bắt revert & loại "Internal JSON-RPC error."
    const ok = await preflight(muaban.createProduct, args);
    if (!ok) return;

    const tx = await muaban.createProduct(...args);
    await tx.wait();

    alert("Đăng sản phẩm thành công.");
    hide($("#formCreate"));
    await loadAllProducts();
  }catch(e){
    showTxError(e, "Đăng sản phẩm thất bại.");
  }
}

/* -------------------- 10) Tải danh sách sản phẩm -------------------- */
async function loadAllProducts(){
  // Duyệt từ event ProductCreated (index theo productId & seller)
  try{
    const fromBlock = 0; // có thể đổi sang block gần đây cho nhanh
    const evs = await muabanRead.queryFilter(muabanRead.filters.ProductCreated(), fromBlock, "latest");
    productsCache.clear();
    for (const ev of evs){
      const pid = ev.args.productId.toNumber();
      const p   = await muabanRead.getProduct(pid);
      productsCache.set(pid, { pid, ...decodeProductStruct(p) });
    }
    renderProducts();
  }catch(e){
    console.error("loadAllProducts:", e);
  }
}

function decodeProductStruct(p){
  return {
    priceVND:        bnToNum(p.priceVND),
    deliveryDaysMax: Number(p.deliveryDaysMax),
    payoutWallet:    String(p.payoutWallet).toLowerCase(),
    seller:          String(p.seller).toLowerCase(),
    active:          Boolean(p.active),
    name:            p.name,
    descriptionCID:  p.descriptionCID,
    imageCID:        p.imageCID
  };
}
const bnToNum = (b)=> Number(ethers.BigNumber.from(b).toString());

function renderProducts(){
  const wrap = $("#productsList");
  if (!wrap) return;
  const keyword = String($("#searchInput")?.value||"").trim().toLowerCase();

  const items = [...productsCache.values()]
    .filter(p=>p.active)
    .filter(p=>!keyword || p.name.toLowerCase().includes(keyword));

  wrap.innerHTML = items.map(p=>{
    const unit = readUnitFromDesc(p.descriptionCID) || "";
    const priceVNDStr = new Intl.NumberFormat("vi-VN").format(p.priceVND);
    return `
      <div class="card product">
        <img class="pimg" src="${p.imageCID}" alt="${escapeHtml(p.name)}"
             onerror="this.src='placeholder.png'"/>
        <div class="pinfo">
          <h3>${escapeHtml(p.name)}</h3>
          <div class="muted">${priceVNDStr} VND / ${escapeHtml(unit||"sp")}</div>
          <div class="actions">
            <button class="btn" onclick="openBuyModal(${p.pid})">Mua</button>
          </div>
        </div>
      </div>
    `;
  }).join("") || `<div class="muted">Chưa có sản phẩm.</div>`;
}

function applySearch(){ renderProducts(); }
function readUnitFromDesc(s){ const m=/^unit:(.*)$/.exec(String(s||"")); return m?m[1]:""; }
function escapeHtml(s){ return String(s||"").replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }

/* -------------------- 11) Mua hàng -------------------- */
async function openBuyModal(pid){
  try{
    const p = productsCache.get(pid) || decodeProductStruct(await muabanRead.getProduct(pid));
    $("#buyPid").value = String(pid);
    $("#buyNameProd").textContent = p.name;
    $("#buyPriceVND").textContent = new Intl.NumberFormat("vi-VN").format(p.priceVND);
    $("#buyQty").value = "1";
    $("#buyTotalVin").textContent = "…";
    show($("#formBuy"));
    // tính tổng VIN hiển thị
    await updateBuyTotal();
  }catch(e){ console.error(e); }
}
$("#buyQty")?.addEventListener("input", updateBuyTotal);

async function updateBuyTotal(){
  try{
    const pid = Number($("#buyPid").value||"0");
    if (!pid) return;
    const qty = Math.max(1, Number($("#buyQty").value||"1")|0);

    const p = productsCache.get(pid) || decodeProductStruct(await muabanRead.getProduct(pid));
    const totalVND = ethers.BigNumber.from(String(p.priceVND)).mul(qty);

    // Cần có vinPerVNDWei
    if (vinPerVNDWei.lte(0)){ $("#buyTotalVin").textContent="Loading price…"; return; }

    const vinNeed = totalVND.mul(vinPerVNDWei); // (wei VIN / 1 VND) * VND = wei VIN
    const vinNeedStr = ethers.utils.formatUnits(vinNeed, vinDecimals);
    $("#buyTotalVin").textContent = `${fmt4(vinNeedStr)} VIN`;
  }catch(e){
    console.error("updateBuyTotal:", e);
    $("#buyTotalVin").textContent = "—";
  }
}

async function onSubmitBuy(){
  try{
    ensure(account, "Hãy kết nối ví.");
    await ensureChain88();

    const pid   = Number($("#buyPid").value);
    const qty   = toUInt($("#buyQty").value);

    // thông tin giao hàng
    const fullName = String($("#buyName").value||"").trim();
    const address  = String($("#buyAddr").value||"").trim();
    const phone    = String($("#buyPhone").value||"").trim();
    const note     = String($("#buyNote").value||"").trim();
    ensure(fullName && address && phone, "Vui lòng nhập đủ Họ tên / Địa chỉ / SĐT.");

    ensure(vinPerVNDWei.gt(0), "Chưa tải được tỷ giá VIN/VND, vui lòng thử lại.");

    // lấy product và tính tổng VIN cần approve
    const p = await muabanRead.getProduct(pid);
    ensure(p.active, "Sản phẩm hiện không bán.");
    const totalVND = ethers.BigNumber.from(p.priceVND.toString()).mul(qty);
    const vinNeed  = totalVND.mul(vinPerVNDWei);

    // approve đủ VIN
    const cur = await vin.allowance(account, CONFIG.MUABAN_ADDR);
    if (cur.lt(vinNeed)){
      const txA = await vin.approve(CONFIG.MUABAN_ADDR, vinNeed.toString());
      await txA.wait();
    }

    // mã hoá thông tin buyer (Base64 UTF-8, tránh ký tự lạ trên MM mobile)
    const buyerInfoCipher = btoa(unescape(encodeURIComponent(JSON.stringify({fullName, address, phone, note}))));

    const args = [String(pid), String(qty), vinPerVNDWei.toString(), buyerInfoCipher];

    // preflight
    const ok = await preflight(muaban.placeOrder, args);
    if (!ok) return;

    const tx = await muaban.placeOrder(...args);
    await tx.wait();

    alert("Đặt hàng thành công.");
    hide($("#formBuy"));
    await loadMyOrders();
  }catch(e){
    showTxError(e, "Đặt hàng thất bại.");
  }
}

/* -------------------- 12) Đơn mua / Đơn bán -------------------- */
async function loadMyOrders(){
  try{
    if (!account){ $("#ordersBuyList").innerHTML=""; $("#ordersSellList").innerHTML=""; return; }

    // Đơn bán: lấy danh sách productId của tôi, sau đó quét OrderPlaced theo productId
    const pids = await muabanRead.getSellerProductIds(account);
    const pset = new Set(pids.map(x=>Number(x)));
    ordersSellCache = [];

    // Đơn mua: query event OrderPlaced filter buyer=account
    const evBuy = await muabanRead.queryFilter(muabanRead.filters.OrderPlaced(null, null, account), 0, "latest");
    ordersBuyCache = await Promise.all(evBuy.map(async ev=>{
      const oid = Number(ev.args.orderId);
      const od  = await muabanRead.getOrder(oid);
      return { oid, ...decodeOrder(od) };
    }));

    // Đơn bán: mọi OrderPlaced mà productId thuộc pids của tôi
    const evAll = await muabanRead.queryFilter(muabanRead.filters.OrderPlaced(), 0, "latest");
    for (const ev of evAll){
      const pid = Number(ev.args.productId);
      if (!pset.has(pid)) continue;
      const oid = Number(ev.args.orderId);
      const od  = await muabanRead.getOrder(oid);
      ordersSellCache.push({ oid, ...decodeOrder(od) });
    }

    renderOrders();
  }catch(e){
    console.error("loadMyOrders:", e);
  }
}

function decodeOrder(o){
  return {
    productId: Number(o.productId),
    quantity:  bnToNum(o.quantity),
    vinAmount: o.vinAmount.toString(),
    deadline:  Number(o.deadline),
    buyer:     String(o.buyer).toLowerCase(),
    seller:    String(o.seller).toLowerCase(),
    released:  Boolean(o.released),
    refunded:  Boolean(o.refunded),
    buyerInfoCipher: String(o.buyerInfoCipher||"")
  };
}

function renderOrders(){
  const buyEl  = $("#ordersBuyList");
  const sellEl = $("#ordersSellList");
  if (buyEl){
    buyEl.innerHTML = ordersBuyCache.map(od=>{
      return `
        <div class="card order">
          <div>Mã đơn: <b>#${od.oid}</b> · SP: ${od.productId} · SL: ${od.quantity}</div>
          <div>VIN: ${fmt4(ethers.utils.formatUnits(od.vinAmount, vinDecimals))}</div>
          <div>Trạng thái: ${od.released?"Đã giải ngân": od.refunded?"Đã hoàn": "Đang chờ"}</div>
          <div class="actions">
            ${(!od.released && !od.refunded)? `<button class="btn" onclick="confirmReceipt(${od.oid})">Xác nhận đã nhận hàng</button>
            <button class="btn" onclick="refundIfExpired(${od.oid})">Hoàn tiền khi quá hạn</button>`:""}
          </div>
        </div>
      `;
    }).join("") || `<div class="muted">Chưa có đơn mua.</div>`;
  }
  if (sellEl){
    sellEl.innerHTML = ordersSellCache.map(od=>{
      return `
        <div class="card order">
          <div>ĐƠN BÁN • Mã #${od.oid} · Người mua: <a href="${CONFIG.EXPLORER}/address/${od.buyer}" target="_blank" rel="noopener">${short(od.buyer)}</a></div>
          <div>SP: ${od.productId} · SL: ${od.quantity} · VIN: ${fmt4(ethers.utils.formatUnits(od.vinAmount, vinDecimals))}</div>
          <div>Trạng thái: ${od.released?"Đã giải ngân": od.refunded?"Đã hoàn": "Đang chờ"}</div>
        </div>
      `;
    }).join("") || `<div class="muted">Chưa có đơn bán.</div>`;
  }
}

async function confirmReceipt(oid){
  try{
    ensure(account, "Hãy kết nối ví.");
    await ensureChain88();
    const ok = await preflight(muaban.confirmReceipt, [String(oid)]);
    if (!ok) return;
    const tx = await muaban.confirmReceipt(String(oid));
    await tx.wait();
    alert("Đã xác nhận nhận hàng.");
    await loadMyOrders();
  }catch(e){ showTxError(e, "Xác nhận thất bại."); }
}

async function refundIfExpired(oid){
  try{
    ensure(account, "Hãy kết nối ví.");
    await ensureChain88();
    const ok = await preflight(muaban.refundIfExpired, [String(oid)]);
    if (!ok) return;
    const tx = await muaban.refundIfExpired(String(oid));
    await tx.wait();
    alert("Yêu cầu hoàn tiền (nếu đã quá hạn).");
    await loadMyOrders();
  }catch(e){ showTxError(e, "Hoàn tiền thất bại."); }
}

/* -------------------- 13) Tỷ giá VIN/VND -------------------- */
// Tính vinPerVNDWei = (10^decimals) / VND_PER_VIN
async function fetchVinToVND(){
  try{
    // 1) Giá VIC/USDT
    let vicUsd = null;
    try{
      const r = await fetch(CONFIG.BINANCE_VIC, {cache:"no-store"});
      const j = await r.json();
      vicUsd = Number(j?.price);
      if (!Number.isFinite(vicUsd) || vicUsd<=0) vicUsd=null;
    }catch(_){ vicUsd=null; }

    // 2) USD→VND
    let usdVnd = null;
    try{
      const r = await fetch(CONFIG.FX_USD_VND, {cache:"no-store"});
      const j = await r.json();
      usdVnd = Number(j?.rates?.VND);
      if (!Number.isFinite(usdVnd) || usdVnd<=0) usdVnd=null;
    }catch(_){ usdVnd=null; }

    // 3) Tính VIN/VND (tuỳ peg VIN_PER_VIC)
    if (vicUsd && usdVnd){
      const vinUsd = vicUsd * (CONFIG.VIN_PER_VIC || 1);
      const vndPerVin = vinUsd * usdVnd;          // VND cho 1 VIN
      vinPerVNDWei = ethers.BigNumber.from("1" + "0".repeat(vinDecimals)).div(Math.max(1, Math.floor(vndPerVin)));

      // Hiển thị góc header nếu có phần tử
      const chip = $("#vinVndChip");
      if (chip) chip.textContent = `1 VIN = ${new Intl.NumberFormat("vi-VN").format(Math.floor(vndPerVin))} VND`;
    }else{
      vinPerVNDWei = ethers.BigNumber.from("0");
      const chip = $("#vinVndChip");
      if (chip) chip.textContent = "Loading price…";
    }
    // cập nhật tổng VIN nếu đang mở modal mua
    updateBuyTotal().catch(()=>{});
  }catch(e){
    console.warn("fetchVinToVND:", e);
    const chip = $("#vinVndChip");
    if (chip) chip.textContent = "Loading price…";
  }
}

/* -------------------- 14) Tiện ích khác -------------------- */
window.openBuyModal = openBuyModal; // dùng trong onclick render
window.confirmReceipt = confirmReceipt;
window.refundIfExpired = refundIfExpired;

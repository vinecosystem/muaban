/* ====================================================================
   muaban • app.js (ethers v5) — FULL SYNC WITH UPDATED index.html
   - ABI rút gọn nhúng sẵn (đủ các hàm & event đang dùng)
   - Ẩn/hiện 2 nút “Đơn của tôi …” theo trạng thái ví & đăng ký
   - Mua hàng có SỐ LƯỢNG + hiển thị TỔNG VIN trước khi ký ví
==================================================================== */

/* -------------------- DOM helpers -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show=(el)=>el && el.classList.remove("hidden");
const hide=(el)=>el && el.classList.add("hidden");
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`:"";
const fmt2=(x)=>Number(x).toFixed(2);
const fmt4=(x)=>Number(x).toFixed(4);
const toast=(m)=>{ const t=$("#toast"); if(!t) return alert(m); t.textContent=m; t.classList.remove("hidden"); clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.add("hidden"),2600); };

const formatVin = (bn)=> {
  try { return Number(window.ethers.utils.formatUnits(bn,18)).toFixed(4); }
  catch(_){ return "—"; }
};
const makeTxLink = (tx)=> `https://vicscan.xyz/tx/${tx}`;

/* -------------------- Địa chỉ mạng -------------------- */
const RPC = "https://rpc.viction.xyz";
const EXPLORER = "https://vicscan.xyz";
const MUABAN = "0xe01e2213A899E9B3b1921673D2d13a227a8df638";
const VIN    = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4";

/* -------------------- ABI rút gọn (đủ dùng) -------------------- */
/* Trích từ ABI bạn gửi: các event/hàm dùng ở FE. */
const MUABAN_ABI = [
  // --- Events (dùng để query logs) ---
  {
    "anonymous": false, "name": "ProductCreated", "type": "event",
    "inputs": [
      {"indexed": true,"name":"productId","type":"uint256"},
      {"indexed": true,"name":"seller","type":"address"},
      {"indexed": false,"name":"name","type":"string"},
      {"indexed": false,"name":"descriptionCID","type":"string"},
      {"indexed": false,"name":"imageCID","type":"string"},
      {"indexed": false,"name":"priceUsdCents","type":"uint256"},
      {"indexed": false,"name":"shippingUsdCents","type":"uint256"},
      {"indexed": false,"name":"taxRateBps","type":"uint16"},
      {"indexed": false,"name":"deliveryDaysMax","type":"uint32"},
      {"indexed": false,"name":"revenueWallet","type":"address"},
      {"indexed": false,"name":"taxWallet","type":"address"},
      {"indexed": false,"name":"shippingWallet","type":"address"},
      {"indexed": false,"name":"sellerEncryptPubKey","type":"bytes"},
      {"indexed": false,"name":"stock","type":"uint256"}
    ]
  },
  {
    "anonymous": false, "name": "OrderPlaced", "type": "event",
    "inputs": [
      {"indexed": true,"name":"orderId","type":"uint256"},
      {"indexed": true,"name":"productId","type":"uint256"},
      {"indexed": true,"name":"buyer","type":"address"},
      {"indexed": false,"name":"seller","type":"address"},
      {"indexed": false,"name":"quantity","type":"uint256"},
      {"indexed": false,"name":"vinAmountTotal","type":"uint256"},
      {"indexed": false,"name":"placedAt","type":"uint256"},
      {"indexed": false,"name":"deadline","type":"uint256"},
      {"indexed": false,"name":"shippingInfoCiphertext","type":"bytes"}
    ]
  },
  {
    "anonymous": false, "name": "OrderReleased", "type": "event",
    "inputs": [
      {"indexed": true,"name":"orderId","type":"uint256"},
      {"indexed": true,"name":"productId","type":"uint256"},
      {"indexed": true,"name":"buyer","type":"address"},
      {"indexed": false,"name":"seller","type":"address"},
      {"indexed": false,"name":"vinAmountTotal","type":"uint256"}
    ]
  },
  {
    "anonymous": false, "name": "OrderRefunded", "type": "event",
    "inputs": [
      {"indexed": true,"name":"orderId","type":"uint256"},
      {"indexed": true,"name":"productId","type":"uint256"},
      {"indexed": true,"name":"buyer","type":"address"},
      {"indexed": false,"name":"seller","type":"address"},
      {"indexed": false,"name":"vinAmountTotal","type":"uint256"}
    ]
  },

  // --- Views / pure ---
  {"inputs":[{"name":"wallet","type":"address"}],"name":"isRegistered","outputs":[{"type":"bool"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"PLATFORM_FEE","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"name":"productId","type":"uint256"}],"name":"getProduct","outputs":[{"components":[
    {"name":"productId","type":"uint256"},
    {"name":"seller","type":"address"},
    {"name":"name","type":"string"},
    {"name":"descriptionCID","type":"string"},
    {"name":"imageCID","type":"string"},
    {"name":"priceUsdCents","type":"uint256"},
    {"name":"shippingUsdCents","type":"uint256"},
    {"name":"taxRateBps","type":"uint16"},
    {"name":"deliveryDaysMax","type":"uint32"},
    {"name":"revenueWallet","type":"address"},
    {"name":"taxWallet","type":"address"},
    {"name":"shippingWallet","type":"address"},
    {"name":"sellerEncryptPubKey","type":"bytes"},
    {"name":"active","type":"bool"},
    {"name":"createdAt","type":"uint64"},
    {"name":"updatedAt","type":"uint64"},
    {"name":"stock","type":"uint256"}
  ],"type":"tuple"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"name":"orderId","type":"uint256"}],"name":"getOrder","outputs":[{"components":[
    {"name":"orderId","type":"uint256"},
    {"name":"productId","type":"uint256"},
    {"name":"buyer","type":"address"},
    {"name":"seller","type":"address"},
    {"name":"quantity","type":"uint256"},
    {"name":"vinAmountTotal","type":"uint256"},
    {"name":"placedAt","type":"uint256"},
    {"name":"deadline","type":"uint256"},
    {"name":"shippingInfoCiphertext","type":"bytes"},
    {"name":"status","type":"uint8"},
    {"name":"reviewed","type":"bool"}
  ],"type":"tuple"}],"stateMutability":"view","type":"function"},

  // Hàm quote tính VIN theo số lượng & tỷ giá (FE dùng để hiển thị tổng VIN)
  {"inputs":[
    {"name":"productId","type":"uint256"},
    {"name":"quantity","type":"uint256"},
    {"name":"vinPerUSD","type":"uint256"}
  ],"name":"quoteVinForProduct","outputs":[
    {"name":"vinRevenue","type":"uint256"},
    {"name":"vinShipping","type":"uint256"},
    {"name":"vinTax","type":"uint256"},
    {"name":"vinTotal","type":"uint256"}
  ],"stateMutability":"view","type":"function"},

  // --- Mutating ---
  {"inputs":[],"name":"payRegistration","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[
    {"name":"name_","type":"string"},
    {"name":"descriptionCID_","type":"string"},
    {"name":"imageCID_","type":"string"},
    {"name":"priceUsdCents_","type":"uint256"},
    {"name":"shippingUsdCents_","type":"uint256"},
    {"name":"taxRateBps_","type":"uint16"},
    {"name":"deliveryDaysMax_","type":"uint32"},
    {"name":"revenueWallet_","type":"address"},
    {"name":"taxWallet_","type":"address"},
    {"name":"shippingWallet_","type":"address"},
    {"name":"sellerEncryptPubKey_","type":"bytes"},
    {"name":"stock_","type":"uint256"},
    {"name":"active_","type":"bool"}
  ],"name":"createProduct","outputs":[{"name":"productId","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[
    {"name":"productId","type":"uint256"},
    {"name":"priceUsdCents_","type":"uint256"},
    {"name":"shippingUsdCents_","type":"uint256"},
    {"name":"taxRateBps_","type":"uint16"},
    {"name":"deliveryDaysMax_","type":"uint32"},
    {"name":"revenueWallet_","type":"address"},
    {"name":"taxWallet_","type":"address"},
    {"name":"shippingWallet_","type":"address"},
    {"name":"stock_","type":"uint256"},
    {"name":"sellerEncryptPubKey_","type":"bytes"}
  ],"name":"updateProduct","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"name":"productId","type":"uint256"},{"name":"active_","type":"bool"}],"name":"setProductActive","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"name":"orderId","type":"uint256"}],"name":"confirmReceipt","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"name":"orderId","type":"uint256"}],"name":"refundIfExpired","outputs":[],"stateMutability":"nonpayable","type":"function"},
];

const VIN_ABI = [
  {"inputs":[{"name":"owner","type":"address"}],"name":"balanceOf","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"name":"owner","type":"address"},{"name":"spender","type":"address"}],"name":"allowance","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],"name":"approve","outputs":[{"type":"bool"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[],"name":"decimals","outputs":[{"type":"uint8"}],"stateMutability":"view","type":"function"},
  {"anonymous":false,"name":"Transfer","type":"event","inputs":[
    {"indexed":true,"name":"from","type":"address"},
    {"indexed":true,"name":"to","type":"address"},
    {"indexed":false,"name":"value","type":"uint256"}
  ]}
];

/* -------------------- Biến toàn cục -------------------- */
let roProv, provider, signer, user;
let muaban, vin;
let isRegistered = false;

let USDperVIN_BN = null; // 1 VIN = ? USD (BN 18)
let vinPerUSD_BN = null; // 1 USD = ? VIN (BN 18)

/* -------------------- Tiện ích phụ thuộc ethers (khởi tạo muộn) -------------------- */
function ONEe18(){ return window.ethers.BigNumber.from("1000000000000000000"); }
function toUnitsBN(str, decimals){
  const s = String(str);
  const parts = s.split(".");
  const ip = (parts[0]||"0").replace(/\D/g,"") || "0";
  let fp = ((parts[1]||"").replace(/\D/g,""));
  if (fp.length > decimals) fp = fp.slice(0,decimals);
  while (fp.length < decimals) fp += "0";
  const full = ip + fp;
  return window.ethers.BigNumber.from(full || "0");
}

/* -------------------- Contracts -------------------- */
async function bindRO(){
  roProv = new window.ethers.providers.JsonRpcProvider(RPC);
  muaban = new window.ethers.Contract(MUABAN, MUABAN_ABI, roProv);
  vin    = new window.ethers.Contract(VIN,    VIN_ABI,    roProv);
}
async function bindRW(){
  provider = new window.ethers.providers.Web3Provider(window.ethereum,"any");
  signer   = provider.getSigner();
  muaban   = muaban.connect(signer);
  vin      = vin.connect(signer);
  user     = await signer.getAddress();
}

/* -------------------- Quy đổi VIN <-> USD -------------------- */
async function refreshVinPrice(){
  try{
    const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT", {cache:"no-store"});
    const { price } = await r.json(); // string
    const usdPerVin = Number(price) * 100;           // 1 VIN = (VICUSDT*100) USD (hiển thị)
    $("#vinPriceUsd").textContent = fmt2(usdPerVin);

    // BigNumber 18
    USDperVIN_BN = toUnitsBN(String(usdPerVin), 18);
    vinPerUSD_BN = ONEe18().mul(ONEe18()).div(USDperVIN_BN); // = 1 / usdPerVin
  }catch(e){
    console.warn("Price fetch failed", e);
    if (!USDperVIN_BN) $("#vinPriceUsd").textContent = "—";
  }
}
function usdCentsToVinWei(usdCents){
  if (!vinPerUSD_BN) return window.ethers.BigNumber.from(0);
  return vinPerUSD_BN.mul(window.ethers.BigNumber.from(usdCents)).div(100);
}

/* -------------------- Wallet UI -------------------- */
async function connectWallet(){
  try{
    if (!window.ethereum){ toast("Vui lòng cài ví EVM (MetaMask/Coin98)"); return; }
    await bindRW();

    const vic = await provider.getBalance(user);
    const vvin= await vin.balanceOf(user);
    $("#accountShort").textContent = short(user);
    $("#accountShort").href = `${EXPLORER}/address/${user}`;
    $("#vicBalance").textContent = fmt4(window.ethers.utils.formatEther(vic));
    $("#vinBalance").textContent = fmt4(window.ethers.utils.formatUnits(vvin,18));

    // Ẩn/hiện khu ví
    hide($("#btnConnect")); show($("#walletInfo"));

    // Kiểm tra đã đăng ký trên hợp đồng chưa
    isRegistered = await muaban.isRegistered(user); // view trong contract
    if (isRegistered){
      hide($("#btnRegister"));
      show($("#btnCreateProduct"));
      // chỉ hiện 2 nút Đơn khi đã kết nối + đã đăng ký
      show($("#btnBuyerOrders"));
      show($("#btnSellerOrders"));
    }else{
      show($("#btnRegister"));
      hide($("#btnCreateProduct"));
      hide($("#btnBuyerOrders"));
      hide($("#btnSellerOrders"));
    }

    await Promise.all([loadProducts(), loadBuyerOrders(), loadSellerOrders()]);
  }catch(e){
    console.error(e);
    toast("Kết nối ví thất bại");
  }
}
function disconnectWallet(){
  signer=null; user=null; isRegistered=false;
  show($("#btnConnect")); hide($("#walletInfo"));
  hide($("#btnRegister")); hide($("#btnCreateProduct"));

  // Ẩn 2 nút đơn khi ngắt ví
  hide($("#btnBuyerOrders"));
  hide($("#btnSellerOrders"));

  renderProducts(); // trở lại chế độ khách
}
async function payRegistration(){
  try{
    if (!signer || !user) return toast("Hãy kết nối ví");
    const fee = await muaban.PLATFORM_FEE(); // 0.001 VIN (xem hằng số trong contract) :contentReference[oaicite:5]{index=5}
    const allow = await vin.allowance(user, MUABAN);
    if (allow.lt(fee)){ const t1=await vin.approve(MUABAN, fee); toast("Approve phí…"); await t1.wait(); }
    const t2=await muaban.payRegistration(); toast("Đăng ký…"); await t2.wait();
    toast("Đăng ký thành công");
    isRegistered = true;
    hide($("#btnRegister")); show($("#btnCreateProduct"));
    show($("#btnBuyerOrders")); show($("#btnSellerOrders"));
  }catch(e){ console.error(e); toast("Đăng ký thất bại"); }
}

/* -------------------- Sản phẩm -------------------- */
let productIds = [];
let products   = new Map();

async function loadProducts(){
  await bindRO();
  try{
    const logs = await muaban.queryFilter(muaban.filters.ProductCreated(), 0, "latest");
    const ids = [...new Set(logs.map(l=>l.args.productId.toNumber()))];
    productIds = ids;
    products.clear();
    for (const id of ids){
      const p = await muaban.getProduct(id);
      products.set(id, p);
    }
    renderProducts();
  }catch(e){ console.error(e); toast("Không tải được sản phẩm"); }
}
function mediaNode(url){
  const u = String(url||"");
  const http = u.startsWith("http") ? u : (u.startsWith("ipfs://")? u.replace("ipfs://","https://ipfs.io/ipfs/") : `https://ipfs.io/ipfs/${u}`);
  const isVid = /\.(mp4|webm|ogg)$/i.test(http);
  const el = isVid ? document.createElement("video"):document.createElement("img");
  if (isVid){ el.src=http; el.controls=true; el.playsInline=true; } else { el.src=http; el.alt="media"; }
  return el;
}
function renderProducts(){
  const wrap = $("#productList"); wrap.innerHTML="";
  const q = ($("#searchInput").value||"").trim().toLowerCase();
  let shown = 0;

  for (const id of productIds.slice().reverse()){
    const p = products.get(id); if (!p) continue;
    const active = p.active ?? p[13];
    if (!active) continue;

    const name = p.name ?? p[2];
    const unit = p.descriptionCID ?? p[3];
    const media = p.imageCID ?? p[4];
    const priceC = p.priceUsdCents ? Number(p.priceUsdCents) : (p[5].toNumber ? p[5].toNumber() : Number(p[5]));
    const stock  = p.stock ?? p[16];
    const seller = p.seller ?? p[1];

    const text = ((name||"") + " " + (unit||"")).toLowerCase();
    if (q && !text.includes(q)) continue;

    const tpl = $("#tplProductCard").content.cloneNode(true);
    const mediaWrap = tpl.querySelector(".p-media");
    mediaWrap.innerHTML=""; mediaWrap.appendChild(mediaNode(media));

    tpl.querySelector(".p-title").textContent = unit ? `${name} (${unit})` : name;

    const vinWei = usdCentsToVinWei(priceC);
    const vinNum = Number(window.ethers.utils.formatUnits(vinWei,18));
    tpl.querySelector(".p-price-vin").textContent = `≈ ${fmt4(vinNum)} VIN / ${unit||"đv"}`;

    const badge = tpl.querySelector(".stock-badge");
    const inStock = active && String(stock)!=="0";
    badge.classList.add("badge", inStock? "ok":"out");
    badge.textContent = inStock ? "Còn hàng" : "Hết hàng";

    const buyBtn = tpl.querySelector(".buy-btn");
    const updBtn = tpl.querySelector(".update-btn");

    if (!user){ hide(buyBtn); hide(updBtn); }
    else if (String(user).toLowerCase() === String(seller).toLowerCase()){
      show(updBtn); updBtn.dataset.productId=String(id); hide(buyBtn);
    }else{
      if (inStock){ show(buyBtn); buyBtn.dataset.productId=String(id); } else hide(buyBtn);
      hide(updBtn);
    }

    wrap.appendChild(tpl); shown++;
  }
  if (shown===0) show($("#emptyProducts")); else hide($("#emptyProducts"));
}

/* -------------------- Đăng / cập nhật sản phẩm -------------------- */
function openCreateModal(){
  if (!user) return toast("Kết nối ví trước");
  if (!isRegistered) return toast("Ví chưa đăng ký người bán");
  $("#pName").value=""; $("#pImageCID").value=""; $("#pUnit").value="";
  $("#pPriceUsd").value=""; $("#pRevenueWallet").value=user; $("#pDeliveryDays").value="7";
  show($("#createModal"));
}
async function submitCreate(){
  try{
    if (!user) return toast("Kết nối ví");
    await bindRW();
    const name = $("#pName").value.trim().slice(0,500);
    const media= $("#pImageCID").value.trim();
    const unit = $("#pUnit").value.trim() || "đv";
    const priceUsd = Number($("#pPriceUsd").value);
    const revenueWallet = $("#pRevenueWallet").value.trim();
    const delivery = parseInt($("#pDeliveryDays").value||"7",10);
    if (!name || !media || !(priceUsd>0) || !window.ethers.utils.isAddress(revenueWallet) || delivery<1){
      return toast("Điền đúng: Tên/Ảnh/Giá/Ví/Ngày");
    }
    let sellerPubB64 = "";
    try{ sellerPubB64 = await window.ethereum.request({ method:"eth_getEncryptionPublicKey", params:[user] }); }catch(_){}

    const priceC = Math.round(priceUsd*100);
    const shippingC=0, taxBps=0;
    const taxWallet = revenueWallet; // contract yêu cầu taxWallet != 0x0
    const shippingWallet = window.ethers.constants.AddressZero;
    const stock = 1, active = true;

    const tx = await muaban.createProduct(
      name, unit, media,
      priceC, shippingC, taxBps, delivery,
      revenueWallet, taxWallet, shippingWallet,
      sellerPubB64 ? window.ethers.utils.toUtf8Bytes(sellerPubB64) : "0x",
      stock, active
    );
    toast("Đăng sản phẩm…"); await tx.wait();
    hide($("#createModal")); await loadProducts();
  }catch(e){ console.error(e); toast("Đăng sản phẩm thất bại"); }
}

let updatingId = null;
async function openUpdateModal(pid){
  if (!user) return toast("Kết nối ví");
  await bindRW();
  const p = await muaban.getProduct(pid);
  if (String((p.seller ?? p[1])).toLowerCase() !== String(user).toLowerCase()) return toast("Không phải chủ sản phẩm");
  updatingId = pid;
  $("#uProductId").value = String(pid);
  $("#uPriceUsd").value  = (Number(p.priceUsdCents ?? p[5])/100).toFixed(2);
  $("#uRevenueWallet").value = (p.revenueWallet ?? p[9]);
  $("#uDeliveryDays").value  = (p.deliveryDaysMax ?? p[8]);
  $("#uStock").value = String(p.stock ?? p[16]);
  $("#uActive").checked = !!(p.active ?? p[13]);
  show($("#updateModal"));
}
async function submitUpdate(){
  try{
    if (!user) return toast("Kết nối ví");
    await bindRW();
    const priceUsd = Number($("#uPriceUsd").value);
    const revenueWallet = $("#uRevenueWallet").value.trim();
    const delivery = parseInt($("#uDeliveryDays").value||"7",10);
    const stock = parseInt($("#uStock").value||"0",10);
    const active = $("#uActive").checked;
    if (!(priceUsd>=0) || !window.ethers.utils.isAddress(revenueWallet) || delivery<1 || stock<0) return toast("Dữ liệu không hợp lệ");

    let sellerPubB64 = "";
    try{ sellerPubB64 = await window.ethereum.request({ method:"eth_getEncryptionPublicKey", params:[user] }); }catch(_){}

    const priceC = Math.round(priceUsd*100);
    const tx = await muaban.updateProduct(
      updatingId, priceC, 0, 0, delivery,
      revenueWallet, revenueWallet, window.ethers.constants.AddressZero,
      stock,
      sellerPubB64 ? window.ethers.utils.toUtf8Bytes(sellerPubB64) : "0x"
    );
    toast("Cập nhật…"); await tx.wait();

    const cur = await muaban.getProduct(updatingId);
    if (!!(cur.active ?? cur[13]) !== active){
      const t2 = await muaban.setProductActive(updatingId, active);
      await t2.wait();
    }
    hide($("#updateModal")); await loadProducts();
  }catch(e){ console.error(e); toast("Cập nhật thất bại"); }
}

/* -------------------- Mua hàng (mã hoá địa chỉ) -------------------- */
let buying = { id:null, p:null };

async function startBuy(pid){
  if (!user){ toast("Kết nối ví để mua"); return; }
  const p = await muaban.getProduct(pid);
  if (!(p.active ?? p[13]) || String(p.stock ?? p[16])==="0") return toast("Sản phẩm tạm hết hàng");
  buying = { id:pid, p };

  // reset form
  $("#shipName").value=""; $("#shipPhone").value=""; $("#shipAddress").value=""; $("#shipNote").value="";
  const qtyEl = $("#buyQty");
  const maxStock = Number(p.stock ?? (p[16]?.toNumber ? p[16].toNumber() : p[16])) || 999999;
  qtyEl.min = 1; qtyEl.max = Math.max(1, maxStock); qtyEl.value = 1;

  show($("#buyModal"));
  await recalcBuyTotal();
  qtyEl.oninput = recalcBuyTotal;
}

async function recalcBuyTotal(){
  try{
    if (!vinPerUSD_BN) await refreshVinPrice();
    if (!buying || buying.id==null) return;
    const qty = Math.max(1, parseInt($("#buyQty").value || "1", 10));

    const q = await muaban.quoteVinForProduct(buying.id, qty, vinPerUSD_BN);
    const vinTotal = window.ethers.BigNumber.from(q[3]); // (vinRevenue, vinShipping, vinTax, vinTotal)
    $("#buyTotalVin").textContent = formatVin(vinTotal);
  }catch(e){ console.warn("recalcBuyTotal", e); $("#buyTotalVin").textContent = "—"; }
}

async function ensureNaCl(){
  if (window.nacl) return;
  await import("https://cdn.jsdelivr.net/npm/tweetnacl-util@0.15.1/nacl-util.js");
  await import("https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js");
}
async function encryptForSellerBase64(pubB64, plainJSON){
  await ensureNaCl();
  const pk = window.nacl.util.decodeBase64(pubB64);
  const eph=window.nacl.box.keyPair(), nonce=window.nacl.randomBytes(24), msg=window.nacl.util.decodeUTF8(plainJSON);
  const ct = window.nacl.box(msg, nonce, pk, eph.secretKey);
  const payload = {
    version:"x25519-xsalsa20-poly1305",
    ephemPublicKey: window.nacl.util.encodeBase64(eph.publicKey),
    nonce:          window.nacl.util.encodeBase64(nonce),
    ciphertext:     window.nacl.util.encodeBase64(ct)
  };
  return window.ethers.utils.hexlify(window.ethers.utils.toUtf8Bytes(JSON.stringify(payload)));
}

async function submitBuy(){
  try{
    if (!user) return toast("Kết nối ví");
    await bindRW();
    if (!vinPerUSD_BN) await refreshVinPrice();

    const ship = {
      name: $("#shipName").value.trim(),
      phone: $("#shipPhone").value.trim(),
      address: $("#shipAddress").value.trim(),
      note: $("#shipNote").value.trim()
    };
    if (!ship.name || !ship.phone || !ship.address) return toast("Điền đủ Tên/SĐT/Địa chỉ");

    let shipHex;
    try{
      let sellerPubB64=""; 
      try{ sellerPubB64 = window.ethers.utils.toUtf8String(buying.p.sellerEncryptPubKey ?? buying.p[12]); }catch(_){}
      const plain = JSON.stringify(ship);
      shipHex = sellerPubB64 ? await encryptForSellerBase64(sellerPubB64, plain)
                             : window.ethers.utils.hexlify(window.ethers.utils.toUtf8Bytes(plain));
    }catch(e){ console.warn("encrypt fail", e); shipHex = window.ethers.utils.hexlify(window.ethers.utils.toUtf8Bytes(JSON.stringify(ship))); }

    // SỐ LƯỢNG & TỔNG VIN cần approve dựa theo quote
    const qty = Math.max(1, parseInt($("#buyQty").value || "1", 10));
    const q = await muaban.quoteVinForProduct(buying.id, qty, vinPerUSD_BN);
    const vinNeed = window.ethers.BigNumber.from(q[3]); // vinTotal

    // Approve nếu thiếu
    const allow = await vin.allowance(user, MUABAN);
    if (allow.lt(vinNeed)){ const t1=await vin.approve(MUABAN, vinNeed); toast("Approve VIN…"); await t1.wait(); }

    // ĐẶT HÀNG
    const t2 = await muaban.placeOrder(buying.id, qty, vinPerUSD_BN, shipHex);
    toast("Đặt hàng…"); await t2.wait();
    toast("Đặt hàng thành công");
    hide($("#buyModal"));

    await Promise.all([loadBuyerOrders(), loadSellerOrders()]);
    showTab("buyer");
  }catch(e){ console.error(e); toast("Đặt hàng thất bại"); }
}

/* -------------------- Đơn của tôi -------------------- */
function statusText(s){ const n=Number(s); if(n===1) return "Đang ký quỹ"; if(n===2) return "Đã xả tiền"; if(n===3) return "Đã hoàn"; return "—"; }

async function loadBuyerOrders(){
  try{
    if (!roProv || !user || !isRegistered) return;
    const iface = new window.ethers.utils.Interface(MUABAN_ABI);
    const topicPlaced = iface.getEventTopic("OrderPlaced");

    const logs = await roProv.getLogs({
      address: MUABAN,
      topics: [topicPlaced, null, null, window.ethers.utils.hexZeroPad(user, 32)],
      fromBlock: 0, toBlock: "latest"
    });

    const cont = $("#buyerOrders");
    cont.innerHTML = "";
    if (logs.length === 0){ show($("#emptyBuyerOrders")); return; }
    hide($("#emptyBuyerOrders"));

    for (const lg of logs){
      const ev = iface.parseLog(lg);
      const orderId = ev.args.orderId.toString();

      const o = await muaban.getOrder(orderId);
      const status = Number(o.status ?? o[0]);
      const vinTotal = o.vinAmountTotal ?? o[5];
      const deadline = (o.deadline ?? o[7]).toNumber ? (o.deadline ?? o[7]).toNumber() : Number(o.deadline ?? o[7]);

      const tpl = $("#tplBuyerOrder").content.cloneNode(true);
      tpl.querySelector(".p-title").textContent = `Đơn #${orderId} • SP ${o.productId ?? o[1]} • ${statusText(status)}`;
      tpl.querySelector(".p-price-vin").textContent = `Tổng: ${formatVin(vinTotal)} VIN`;
      tpl.querySelector(".muted").textContent = deadline ? `Hạn xác nhận: ${new Date(deadline*1000).toLocaleString()}` : "";

      tpl.querySelector(".confirm-btn").onclick = ()=> confirmReceipt(orderId);
      tpl.querySelector(".refund-btn").onclick  = ()=> refundIfExpired(orderId);

      cont.appendChild(tpl);
    }
  }catch(e){ console.error(e); }
}

async function loadSellerOrders(){
  try{
    if (!roProv || !user || !isRegistered) return;
    const iface = new window.ethers.utils.Interface(MUABAN_ABI);
    const topicPlaced = iface.getEventTopic("OrderPlaced");

    const logs = await roProv.getLogs({ address: MUABAN, topics: [topicPlaced], fromBlock: 0, toBlock: "latest" });

    const cont = $("#sellerOrders");
    cont.innerHTML = "";
    let count = 0;

    for (const lg of logs){
      const ev = iface.parseLog(lg);
      const orderId = ev.args.orderId.toString();
      const o = await muaban.getOrder(orderId);
      const seller = (o.seller ?? o[3]).toLowerCase();
      if (!user || seller !== user.toLowerCase()) continue;

      count++;
      const vinTotal = o.vinAmountTotal ?? o[5];
      const tpl = $("#tplSellerOrder").content.cloneNode(true);
      tpl.querySelector(".p-title").textContent = `Đơn #${orderId} • SP ${o.productId ?? o[1]} • ${statusText(o.status ?? o[0])}`;
      tpl.querySelector(".p-price-vin").textContent = `Tổng: ${formatVin(vinTotal)} VIN`;
      tpl.querySelector(".muted").textContent = `Người mua: ${(o.buyer ?? o[2])}`;

      const a = tpl.querySelector(".tx-link");
      a.href = makeTxLink(lg.transactionHash);

      tpl.querySelector(".decrypt-btn").onclick = ()=> decryptShipping(orderId, tpl.querySelector(".shipping-plain"));

      cont.appendChild(tpl);
    }

    if (count===0) show($("#emptySellerOrders")); else hide($("#emptySellerOrders"));
  }catch(e){ console.error(e); }
}

async function decryptShipping(orderId, preEl){
  try{
    const o = await muaban.getOrder(orderId);
    const cipher = o.shippingInfoCiphertext ?? o[8];
    const hex = window.ethers.utils.isBytesLike(cipher) ? cipher : window.ethers.utils.hexlify(cipher);
    const text = window.ethers.utils.toUtf8String(hex);
    preEl.textContent = text;
    preEl.classList.remove("hidden");
  }catch(e){ console.error(e); toast("Không giải mã được địa chỉ"); }
}

async function confirmReceipt(orderId){
  try{
    await bindRW();
    const t = await muaban.confirmReceipt(orderId);
    toast("Xác nhận đã nhận hàng…"); await t.wait();
    toast("Đã xả tiền cho người bán");
    await Promise.all([loadBuyerOrders(), loadSellerOrders()]);
  }catch(e){ console.error(e); toast("Xác nhận thất bại"); }
}
async function refundIfExpired(orderId){
  try{
    await bindRW();
    const t = await muaban.refundIfExpired(orderId);
    toast("Yêu cầu hoàn VIN…"); await t.wait();
    toast("Đã hoàn VIN (nếu đơn quá hạn)");
    await Promise.all([loadBuyerOrders(), loadSellerOrders()]);
  }catch(e){ console.error(e); toast("Hoàn VIN thất bại"); }
}

/* -------------------- Gắn sự kiện UI -------------------- */
function bindUI(){
  $("#btnConnect").onclick = connectWallet;
  $("#btnDisconnect").onclick = disconnectWallet;

  $("#btnRegister").onclick = payRegistration;
  $("#btnCreateProduct").onclick = openCreateModal;

  $("#createClose").onclick=()=>hide($("#createModal"));
  $("#createCancel").onclick=()=>hide($("#createModal"));
  $("#createSubmit").onclick=submitCreate;

  $("#updateClose").onclick=()=>hide($("#updateModal"));
  $("#updateCancel").onclick=()=>hide($("#updateModal"));
  $("#updateSubmit").onclick=submitUpdate;

  $("#buyClose").onclick=()=>hide($("#buyModal"));
  $("#buyCancel").onclick=()=>hide($("#buyModal"));
  $("#buySubmit").onclick=submitBuy;

  $("#btnReload").onclick = ()=>renderProducts();
  $("#searchInput").oninput = ()=>renderProducts();

  $("#productList").addEventListener("click", async (ev)=>{
    const buy = ev.target.closest(".buy-btn");
    const upd = ev.target.closest(".update-btn");
    if (buy){ const id=parseInt(buy.dataset.productId,10); if(!user){toast("Kết nối ví để mua");return;} await startBuy(id); }
    if (upd){ const id=parseInt(upd.dataset.productId,10); await openUpdateModal(id); }
  });

  $("#btnViewProducts").onclick = ()=>{ showTab("products"); };
  $("#btnBuyerOrders").onclick  = ()=>{ if(!isRegistered){toast("Ví chưa đăng ký");return;} showTab("buyer");  if(user) loadBuyerOrders(); };
  $("#btnSellerOrders").onclick = ()=>{ if(!isRegistered){toast("Ví chưa đăng ký");return;} showTab("seller"); if(user) loadSellerOrders(); };
}
function showTab(which){
  const tabs = {
    products: {sec:"#tabProducts", btn:"#btnViewProducts"},
    buyer:    {sec:"#tabBuyer",    btn:"#btnBuyerOrders"},
    seller:   {sec:"#tabSeller",   btn:"#btnSellerOrders"},
  };
  for (const k in tabs){
    const s=$(tabs[k].sec), b=$(tabs[k].btn);
    if (k===which){ show(s); b.classList.add("outline","active"); }
    else { hide(s); b.classList.remove("active"); }
  }
}

/* -------------------- Bootstrap -------------------- */
window.addEventListener("DOMContentLoaded", async ()=>{
  bindUI();
  showTab("products");
  hide($("#createModal")); hide($("#updateModal")); hide($("#buyModal"));
  // Ẩn 2 nút đơn ở trạng thái chưa connect/đăng ký (phòng khi HTML thiếu class hidden)
  hide($("#btnBuyerOrders")); hide($("#btnSellerOrders"));

  // Chờ ethers sẵn sàng (tránh 'ethers is not defined' trên hosting tĩnh)
  const waitEthers = async ()=>{
    const t0 = Date.now();
    while (!window.ethers){
      if (Date.now()-t0 > 7000) { alert("Không tải được thư viện Ethers. Kiểm tra mạng/CDN."); return false; }
      await new Promise(r=>setTimeout(r,60));
    }
    return true;
  };
  const ok = await waitEthers(); if(!ok) return;

  await bindRO();
  await refreshVinPrice();
  await loadProducts();

  if (window.ethereum){
    window.ethereum.on("accountsChanged", ()=>{ disconnectWallet(); });
    window.ethereum.on("chainChanged", ()=>{ location.reload(); });
  }
});

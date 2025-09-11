/* ======================================================================
   muaban — app.js (ethers v5)
   - Connect wallet (+ switch/add Viction 88)
   - Show VIN/VIC balance, VIN≈USD (Binance VICUSDT * 100)
   - Registration: approve VIN(0.001) → payRegistration()
   - Create product (6 trường, tên ≤ 500 ký tự, media IPFS/http), tự lưu pubkey mã hoá
   - Update product: giá USD, ví nhận, thời gian, tồn kho, bật/tắt
   - Buy: mã hoá thông tin nhận hàng (x25519) → approve → placeOrder
   - Search: filter theo tên/đơn vị; Live toast khi có OrderPlaced của seller
   ====================================================================== */

/* -------------------- 0) CONFIG -------------------- */
const RPC_URL = "https://rpc.viction.xyz";
const CHAIN_ID_HEX = "0x58"; // 88
const EXPLORER = "https://vicscan.xyz";
const MUABAN = "0xe01e2213A899E9B3b1921673D2d13a227a8df638";
const VIN    = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4";

// ABIs
const ABI_VIN = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

const ABI_MUABAN = [
  "function PLATFORM_FEE() view returns (uint256)",
  "function payRegistration()",
  "function isRegistered(address) view returns (bool)",
  "function createProduct(string,string,string,uint256,uint256,uint16,uint32,address,address,address,bytes,uint256,bool) returns (uint256)",
  "function updateProduct(uint256,uint256,uint256,uint16,uint32,address,address,address,uint256,bytes)",
  "function setProductActive(uint256,bool)",
  "function getProduct(uint256) view returns (tuple(uint256,address,string,string,string,uint256,uint256,uint16,uint32,address,address,address,bytes,bool,uint64,uint64,uint256))",
  "function getSellerProductIds(address) view returns (uint256[])",
  "event ProductCreated(uint256 indexed productId,address indexed seller,string,string,string,uint256,uint256,uint16,uint32,address,address,address,bytes,uint256)",
  "event ProductUpdated(uint256,uint256,uint256,uint16,uint32,address,address,address,uint256,bytes)",
  "event ProductStatusChanged(uint256,bool)",
  "event OrderPlaced(uint256 indexed orderId,uint256 indexed productId,address indexed buyer,address seller,uint256 quantity,uint256 vinAmountTotal,uint256 placedAt,uint256 deadline,bytes shippingInfoCiphertext)"
];

/* -------------------- 1) STATE -------------------- */
let provider, signer, user;
let muaban, vin;
let vinPerUSD_BN = null; // BigNumber(wei per 1 USD)
let lastProducts = [];   // cache list for search
let connectedOrderListener = false;

/* -------------------- 2) HELPERS -------------------- */
const $ = (q) => document.querySelector(q);
function show(el){ el.classList.remove("hidden"); }
function hide(el){ el.classList.add("hidden"); }
function short(addr){ return addr ? addr.slice(0,6)+"…"+addr.slice(-4) : ""; }
function toast(msg, ms=2800){ const t=$("#toast"); t.textContent=msg; t.classList.remove("hidden"); setTimeout(()=>t.classList.add("hidden"), ms); }
const fmt2 = (x) => Number(x).toFixed(2);
const fmt4 = (x) => Number(x).toFixed(4);

// URL helpers
function toDisplayUrl(input){
  if (!input) return "";
  const s = String(input).trim();
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("ipfs://")) return s.replace("ipfs://","https://ipfs.io/ipfs/");
  return "https://ipfs.io/ipfs/" + s;
}
function isVideoUrl(u){
  const x = u.toLowerCase();
  return x.endsWith(".mp4") || x.endsWith(".webm") || x.endsWith(".ogg");
}
async function loadScript(src){
  if (document.querySelector(`script[src="${src}"]`)) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.async = true; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

/* -------------------- 3) PRICE -------------------- */
// BigNumber-safe: vinPerUSD = 1e18 / (VIC_USD*100)
function computeVinPerUSD_BN(vicUsdStr){
  const SCALE = 8; // lấy tối đa 8 chữ số thập phân để tránh tràn
  const parts = String(vicUsdStr).split(".");
  const ip = parts[0] || "0";
  let fp = (parts[1] || "").slice(0, SCALE);
  while (fp.length < SCALE) fp += "0";
  const vicUsdInt = (parseInt(ip,10) * Math.pow(10, SCALE)) + parseInt(fp||"0",10);
  const vinUsdInt = vicUsdInt * 100;
  const numerator = ethers.BigNumber.from("100000000000000000000000000"); // 1e26
  return numerator.div(String(vinUsdInt));
}
function usdCentsToVinWei_BN(usdCents, vinPerUSD){
  const num = vinPerUSD.mul(usdCents);
  return num.add(ethers.BigNumber.from(99)).div(100); // ceil /100
}
async function refreshVinPrice(){
  try{
    $("#vinPriceUsd").textContent = "Loading…";
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT", { cache: "no-store" });
    const { price } = await res.json();
    const vinUsd = Number(price) * 100;
    $("#vinPriceUsd").textContent = fmt2(vinUsd);
    vinPerUSD_BN = computeVinPerUSD_BN(price);
  }catch(e){
    console.error(e);
    $("#vinPriceUsd").textContent = "—";
  }
}

/* -------------------- 4) STARTUP -------------------- */
window.addEventListener("DOMContentLoaded", () => {
  $("#btnConnect").addEventListener("click", connectWallet);
  $("#btnDisconnect").addEventListener("click", disconnectWallet);
  $("#btnRegister").addEventListener("click", doRegister);

  $("#btnCreateProduct").addEventListener("click", ()=>show($("#createModal")));
  $("#createClose").addEventListener("click", ()=>hide($("#createModal")));
  $("#createCancel").addEventListener("click", ()=>hide($("#createModal")));
  $("#createSubmit").addEventListener("click", submitCreate);

  $("#updateClose").addEventListener("click", ()=>hide($("#updateModal")));
  $("#updateCancel").addEventListener("click", ()=>hide($("#updateModal")));
  $("#updateSubmit").addEventListener("click", submitUpdate);

  $("#buyClose").addEventListener("click", ()=>hide($("#buyModal")));
  $("#buyCancel").addEventListener("click", ()=>hide($("#buyModal")));
  $("#buySubmit").addEventListener("click", submitBuy);

  $("#btnReload").addEventListener("click", ()=>renderProducts(filterBySearch(lastProducts)));
  $("#searchInput").addEventListener("keydown",(e)=>{ if(e.key==="Enter"){ renderProducts(filterBySearch(lastProducts)); } });

  $("#productList").addEventListener("click", onProductClick);

  refreshVinPrice().then(loadProducts);
});

/* -------------------- 5) WALLET -------------------- */
async function connectWallet(){
  if (!window.ethereum){ toast("Vui lòng cài MetaMask / ví EVM"); return; }

  // Switch/add chain
  try{
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
  }catch(err){
    if (err && err.code === 4902){
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
        chainId: CHAIN_ID_HEX,
        chainName: "Viction Mainnet",
        nativeCurrency: { name: "VIC", symbol: "VIC", decimals: 18 },
        rpcUrls: [RPC_URL],
        blockExplorerUrls: [EXPLORER]
      }]});
    }else{ console.error(err); toast("Không thể chuyển mạng Viction"); return; }
  }

  provider = new ethers.providers.Web3Provider(window.ethereum, "any");
  await provider.send("eth_requestAccounts", []);
  signer = provider.getSigner();
  user = await signer.getAddress();

  vin = new ethers.Contract(VIN, ABI_VIN, signer);
  muaban = new ethers.Contract(MUABAN, ABI_MUABAN, signer);

  await updateAccountUI();
  await checkRegistration();
  await loadProducts(true);

  // Lắng nghe OrderPlaced (seller = bạn) → toast
  bindOrderPlacedListener();

  if (window.ethereum && window.ethereum.on){
    window.ethereum.on("accountsChanged", ()=>connectWallet());
    window.ethereum.on("chainChanged", ()=>window.location.reload());
  }
}
function disconnectWallet(){ user=null; signer=null; provider=null; hide($("#walletInfo")); show($("#btnConnect")); }
async function updateAccountUI(){
  if (!signer || !user) return;
  const vicBal = await signer.getBalance();
  const vinBal = await vin.balanceOf(user);
  $("#accountShort").textContent = short(user);
  $("#accountShort").href = `${EXPLORER}/address/${user}`;
  $("#vicBalance").textContent = fmt4(ethers.utils.formatEther(vicBal));
  $("#vinBalance").textContent = fmt4(ethers.utils.formatUnits(vinBal, 18));
  hide($("#btnConnect")); show($("#walletInfo"));
}
async function checkRegistration(){
  if (!provider || !user){ hide($("#btnRegister")); hide($("#btnCreateProduct")); return; }
  const reg = await (new ethers.Contract(MUABAN, ABI_MUABAN, provider)).isRegistered(user);
  if (reg){ hide($("#btnRegister")); show($("#btnCreateProduct")); }
  else { show($("#btnRegister")); hide($("#btnCreateProduct")); }
}

/* -------------------- 6) REGISTRATION -------------------- */
async function doRegister(){
  try{
    if (!signer) return toast("Hãy kết nối ví");
    const platformFee = await (new ethers.Contract(MUABAN, ABI_MUABAN, provider)).PLATFORM_FEE();
    const allowance = await vin.allowance(user, MUABAN);
    if (allowance.lt(platformFee)){ const tx1 = await vin.approve(MUABAN, platformFee); toast("Đang ký approve 0.001 VIN…"); await tx1.wait(); }
    const tx2 = await muaban.payRegistration(); toast("Đang gửi đăng ký…"); await tx2.wait();
    toast("Đăng ký thành công"); await checkRegistration(); await updateAccountUI();
  }catch(e){ console.error(e); toast("Đăng ký thất bại"); }
}

/* -------------------- 7) CRYPTO (MetaMask + tweetnacl) -------------------- */
async function ensureNacl(){
  await loadScript("https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl.min.js");
  await loadScript("https://cdn.jsdelivr.net/npm/tweetnacl-util@0.15.1/nacl-util.min.js");
}
async function getWalletEncryptionPublicKey(address){
  // MetaMask trả về public key mã hoá (base64) — dùng eth_getEncryptionPublicKey
  try{
    const base64 = await window.ethereum.request({ method: "eth_getEncryptionPublicKey", params: [address] });
    return base64;
  }catch(e){
    console.warn("Không lấy được pubkey mã hoá", e);
    return "";
  }
}
async function encryptForSeller_base64Pub(sellerPubBase64, jsonStr){
  await ensureNacl();
  const pubKey = nacl.util.decodeBase64(sellerPubBase64);
  const ephem = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);
  const msg = nacl.util.decodeUTF8(jsonStr);
  const cipher = nacl.box(msg, nonce, pubKey, ephem.secretKey);
  const payload = {
    version: "x25519-xsalsa20-poly1305",
    nonce: nacl.util.encodeBase64(nonce),
    ephemPublicKey: nacl.util.encodeBase64(ephem.publicKey),
    ciphertext: nacl.util.encodeBase64(cipher)
  };
  return ethers.utils.hexlify(ethers.utils.toUtf8Bytes(JSON.stringify(payload)));
}

/* -------------------- 8) CREATE PRODUCT -------------------- */
async function submitCreate(){
  try{
    if (!signer) return toast("Hãy kết nối ví");

    const name = $("#pName").value.trim();
    const media = $("#pImageCID").value.trim();
    const unit  = $("#pUnit").value.trim();
    const priceUsd = parseFloat($("#pPriceUsd").value);
    const revenueWallet = $("#pRevenueWallet").value.trim();
    const deliveryDays = parseInt($("#pDeliveryDays").value, 10);

    if (!name || !media || !unit || !priceUsd || !revenueWallet || !deliveryDays){
      return toast("Điền đầy đủ 6 mục");
    }
    if (name.length > 500){ return toast("Tên tối đa 500 ký tự"); }

    let sellerPubB64 = await getWalletEncryptionPublicKey(user);
    const priceCents = Math.round(priceUsd * 100);
    const shipCents = 0, taxBps = 0;
    const taxWallet = revenueWallet;
    const shippingWallet = "0x0000000000000000000000000000000000000000";
    const stock = 999999, active = true;

    const sellerPubBytes = sellerPubB64 ? ethers.utils.toUtf8Bytes(sellerPubB64) : new Uint8Array([]);

    const tx = await muaban.createProduct(
      name,         // name: cho phép mô tả dài (<=500)
      unit,         // dùng làm "đơn vị tính"
      media,        // ảnh/video CID/URL
      priceCents,
      shipCents,
      taxBps,
      deliveryDays,
      revenueWallet,
      taxWallet,
      shippingWallet,
      sellerPubBytes,
      stock,
      active
    );
    toast("Đang đăng sản phẩm…"); await tx.wait();
    toast("Đăng sản phẩm thành công");
    hide($("#createModal"));
    await loadProducts(true);
  }catch(e){ console.error(e); toast("Tạo sản phẩm thất bại"); }
}

/* -------------------- 9) LOAD & RENDER -------------------- */
async function loadProducts(){
  try{
    const _prov = provider ? provider : new ethers.providers.JsonRpcProvider(RPC_URL);
    const _muaban = new ethers.Contract(MUABAN, ABI_MUABAN, _prov);

    const logs = await _muaban.queryFilter(_muaban.filters.ProductCreated(), 0, "latest");
    const ids = [];
    for (let i=logs.length-1;i>=0;i--){
      const id = logs[i].args.productId.toNumber();
      if (!ids.includes(id)) ids.push(id);
    }

    const items = [];
    for (const id of ids){
      const p = await _muaban.getProduct(id);
      if (!p[13]) continue; // active
      items.push({ id, p });
    }
    lastProducts = items;
    renderProducts(filterBySearch(items));
  }catch(e){
    console.error(e);
    $("#productList").innerHTML = "";
    $("#emptyProducts").textContent = "Không tải được danh sách sản phẩm.";
  }
}

function filterBySearch(list){
  const q = ($("#searchInput").value || "").trim().toLowerCase();
  if (!q) return list;
  return list.filter(({p})=>{
    const name = (p[2]||"").toLowerCase();
    const unit = (p[3]||"").toLowerCase();
    return name.includes(q) || unit.includes(q);
  });
}

function renderProducts(list){
  const wrap = $("#productList");
  wrap.innerHTML = "";
  if (!list.length){ $("#emptyProducts").textContent = "Không tìm thấy sản phẩm."; return; }
  $("#emptyProducts").textContent = "";
  const tpl = $("#tplProductCard").content;

  for (const { id, p } of list){
    const el = document.importNode(tpl, true);

    const name = p[2];   // name (cho hiển thị full, style.css đã cho wrap)
    const unit = p[3];   // đơn vị
    const media = p[4];  // ảnh/video
    const priceC = p[5].toNumber();
    const stock  = p[16];
    const seller = p[1];

    // Media
    const url = toDisplayUrl(media);
    const mediaWrap = el.querySelector(".p-media");
    mediaWrap.innerHTML = "";
    if (isVideoUrl(url)){ const v=document.createElement("video"); v.src=url; v.controls=true; v.playsInline=true; mediaWrap.appendChild(v); }
    else { const img=document.createElement("img"); img.src=url; img.alt=name; mediaWrap.appendChild(img); }

    // Title
    el.querySelector(".p-title").textContent = unit ? `${name} (${unit})` : name;

    // Stock badge
    const badge = el.querySelector(".stock-badge");
    if (String(stock) === "0"){ badge.textContent="Hết hàng"; badge.classList.add("badge","out"); }
    else { badge.textContent="Còn hàng"; badge.classList.add("badge","ok"); }

    // Giá ≈ X VIN/đơn vị
    if (!vinPerUSD_BN){
      el.querySelector(".p-price-vin").textContent = `≈ ${(priceC/100).toFixed(2)} USD/đơn vị`;
    } else {
      const vinOne = usdCentsToVinWei_BN(priceC, vinPerUSD_BN);
      el.querySelector(".p-price-vin").textContent = `≈ ${fmt2(ethers.utils.formatUnits(vinOne,18))} VIN/đơn vị`;
    }

    // Nút theo quyền
    const buyBtn = el.querySelector(".buy-btn");
    const updBtn = el.querySelector(".update-btn");
    if (user && String(user).toLowerCase() === String(seller).toLowerCase()){
      updBtn.dataset.productId = String(id);
      show(updBtn); hide(buyBtn);
    }else{
      buyBtn.dataset.productId = String(id);
      show(buyBtn); hide(updBtn);
    }

    wrap.appendChild(el);
  }
}

/* -------------------- 10) PRODUCT ACTIONS -------------------- */
function onProductClick(ev){
  const buy = ev.target.closest(".buy-btn");
  const upd = ev.target.closest(".update-btn");
  if (buy){
    const id = parseInt(buy.dataset.productId,10);
    startBuy(id);
    return;
  }
  if (upd){
    const id = parseInt(upd.dataset.productId,10);
    startUpdate(id);
    return;
  }
}

/* ---- Update flow ---- */
async function startUpdate(productId){
  try{
    if (!signer) return toast("Hãy kết nối ví");
    const p = await muaban.getProduct(productId);
    // Điền sẵn
    $("#uProductId").value = String(productId);
    $("#uPriceUsd").value = (p[5].toNumber()/100).toFixed(2);
    $("#uRevenueWallet").value = p[9];
    $("#uDeliveryDays").value = p[8];
    $("#uStock").value = p[16];
    $("#uActive").checked = !!p[13];

    show($("#updateModal"));
  }catch(e){ console.error(e); toast("Không tải được sản phẩm"); }
}

async function submitUpdate(){
  try{
    if (!signer) return toast("Hãy kết nối ví");
    const productId = parseInt($("#uProductId").value,10);
    const priceUsd = parseFloat($("#uPriceUsd").value);
    const revenueWallet = $("#uRevenueWallet").value.trim();
    const deliveryDays = parseInt($("#uDeliveryDays").value,10);
    const stock = parseInt($("#uStock").value,10);
    const active = $("#uActive").checked;

    if (!priceUsd || !revenueWallet || !deliveryDays || stock<0) return toast("Kiểm tra giá/ ví/ ngày/ tồn kho");

    // Lấy pubkey mã hoá mới (để seller có thể thay ví và vẫn nhận được thông tin giao hàng)
    let sellerPubB64 = await getWalletEncryptionPublicKey(user);
    const sellerPubBytes = sellerPubB64 ? ethers.utils.toUtf8Bytes(sellerPubB64) : new Uint8Array([]);

    const priceCents = Math.round(priceUsd*100);
    const shipCents = 0, taxBps=0;
    const taxWallet = revenueWallet;
    const shippingWallet = "0x0000000000000000000000000000000000000000";

    // Gọi updateProduct (không đổi tên/hình theo thiết kế contract) :contentReference[oaicite:4]{index=4}
    const tx1 = await muaban.updateProduct(
      productId,
      priceCents,
      shipCents,
      taxBps,
      deliveryDays,
      revenueWallet,
      taxWallet,
      shippingWallet,
      stock,
      sellerPubBytes
    );
    toast("Đang cập nhật…"); await tx1.wait();

    // Bật/tắt Active nếu có thay đổi
    const tx2 = await muaban.setProductActive(productId, active);
    await tx2.wait();

    toast("Cập nhật thành công");
    hide($("#updateModal"));
    await loadProducts(true);
  }catch(e){ console.error(e); toast("Cập nhật thất bại"); }
}

/* -------------------- 11) BUY FLOW (mã hoá ngầm) -------------------- */
let buying = null;

async function startBuy(productId){
  try{
    const _prov = provider ? provider : new ethers.providers.JsonRpcProvider(RPC_URL);
    const _muaban = new ethers.Contract(MUABAN, ABI_MUABAN, _prov);
    const p = await _muaban.getProduct(productId);
    buying = { id: productId, p };
    show($("#buyModal"));
  }catch(e){ console.error(e); toast("Không tải được sản phẩm"); }
}

async function submitBuy(){
  try{
    if (!signer || !user) return toast("Hãy kết nối ví");
    if (!vinPerUSD_BN) await refreshVinPrice();

    const shipInfo = {
      name: $("#shipName").value.trim(),
      phone: $("#shipPhone").value.trim(),
      address: $("#shipAddress").value.trim(),
      note: $("#shipNote").value.trim()
    };
    if (!shipInfo.name || !shipInfo.phone || !shipInfo.address) return toast("Điền đủ Tên / SĐT / Địa chỉ");

    // Mã hoá cho seller (nếu có pubkey), nếu chưa có thì lưu plaintext (fallback)
    let shipHex;
    try{
      await ensureNacl();
      const sellerPubBytes = buying.p[12];
      let sellerPubB64 = "";
      try{ sellerPubB64 = ethers.utils.toUtf8String(sellerPubBytes); }catch(_e){ sellerPubB64 = ""; }
      const plaintext = JSON.stringify(shipInfo);
      if (sellerPubB64 && window.nacl){
        shipHex = await encryptForSeller_base64Pub(sellerPubB64, plaintext);
      }else{
        shipHex = ethers.utils.hexlify(ethers.utils.toUtf8Bytes(plaintext));
      }
    }catch(e){
      console.warn("Encrypt fail, fallback plaintext", e);
      shipHex = ethers.utils.hexlify(ethers.utils.toUtf8Bytes(JSON.stringify(shipInfo)));
    }

    // VIN cần trả
    const priceC = buying.p[5].toNumber();
    const vinTotal = usdCentsToVinWei_BN(priceC, vinPerUSD_BN);

    // Approve VIN
    const allowance = await vin.allowance(user, MUABAN);
    if (allowance.lt(vinTotal)){ const tx1 = await vin.approve(MUABAN, vinTotal); toast("Đang ký approve VIN…"); await tx1.wait(); }

    // placeOrder(với quantity=1)
    const tx2 = await muaban.placeOrder(buying.id, 1, vinPerUSD_BN, shipHex);
    toast("Đang gửi đơn hàng…"); await tx2.wait();
    toast("Đặt hàng thành công");
    hide($("#buyModal"));
    await updateAccountUI();
  }catch(e){ console.error(e); toast("Đặt hàng thất bại"); }
}

/* -------------------- 12) NOTIFY SELLER ON ORDER -------------------- */
// Lắng nghe OrderPlaced, kiểm tra seller == user (seller không được indexed trong event)
function bindOrderPlacedListener(){
  if (!muaban || !user || connectedOrderListener) return;
  connectedOrderListener = true;
  muaban.on("OrderPlaced", (orderId, productId, buyer, seller, quantity, vinAmountTotal, placedAt, deadline, shippingInfoCiphertext, ev) => {
    if (String(seller).toLowerCase() === String(user).toLowerCase()){
      const amt = fmt4(ethers.utils.formatUnits(vinAmountTotal, 18));
      toast(`Có đơn hàng mới #${orderId.toString()} cho sản phẩm #${productId.toString()} • Tổng ${amt} VIN`);
      // Gợi ý: bạn có thể mở explorer để xem log chi tiết
      console.log("OrderPlaced", { orderId: orderId.toString(), productId: productId.toString(), buyer, vinAmountTotal: amt, tx: ev.transactionHash });
    }
  });
}

/* ====================================================================
   muaban • app.js  (Front-end thuần, dùng ethers v5)
   Logic UI:
   - Khách (chưa kết nối): xem sản phẩm, tìm kiếm, xem giá VIN≈USD. Không có nút Mua.
   - Đã kết nối:
       + Hiện địa chỉ, số dư VIN/VIC.
       + Nếu chưa đăng ký: thêm nút "Đăng ký người bán".
       + Nếu đã đăng ký: có nút "Đăng sản phẩm".
   - Nút trên thẻ:
       + Chủ sản phẩm: chỉ "Cập nhật".
       + Ví khác: "Mua".
   - Tabs: Sản phẩm / Đơn mua / Đơn bán
==================================================================== */

/* -------------------- 0) SELECTORS & HELPERS -------------------- */
const $ = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show = (el)=>{ if(!el) return; el.classList.remove("hidden"); };
const hide = (el)=>{ if(!el) return; el.classList.add("hidden"); };
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

function fmt2(n){ return Number(n).toFixed(2); }
function fmt4(n){ return Number(n).toFixed(4); }
function shorten(addr){ if(!addr) return ""; return addr.slice(0,6)+"…"+addr.slice(-4); }
function toHttpFromCID(cid){
  if(!cid) return "";
  if(/^https?:\/\//i.test(cid)) return cid;
  if(/^ipfs:\/\//i.test(cid)) return cid.replace(/^ipfs:\/\//,'https://ipfs.io/ipfs/');
  return `https://ipfs.io/ipfs/${cid}`;
}
function mediaElFromCID(cid){
  const url = toHttpFromCID(cid);
  if (!url) return document.createTextNode("");
  const isVideo = /\.(mp4|webm|ogg)$/i.test(url);
  const el = isVideo ? document.createElement('video') : document.createElement('img');
  if (isVideo){ el.src=url; el.controls=true; el.playsInline=true; }
  else { el.src=url; el.alt="media"; }
  return el;
}
function toast(msg){
  const t = $("#toast");
  if(!t) return alert(msg);
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>t.classList.add("hidden"), 2700);
}

/* -------------------- 1) CHUẨN BỊ ETHERS -------------------- */
const MUABAN = "0xe01e2213A899E9B3b1921673D2d13a227a8df638"; // Contract trên Viction
const VIN = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4";   // VIN token

let provider, signer, user;
let muaban, vin;
let abiMuaban, abiVin;
let isReg = false;

let vinPerUSD_BN = null;   // 1 USD -> bao nhiêu VIN (wei), dựa trên VIC/USDT*100
let connectedOrderListener = false;

async function loadABIs(){
  if (abiMuaban && abiVin) return;
  abiMuaban = await (await fetch("Muaban_ABI.json")).json();
  abiVin = await (await fetch("VinToken_ABI.json")).json();
}

async function ensureProvider(){
  if (!window.ethereum) { toast("Cần ví EVM (VD: Coin98, MetaMask)"); return null; }
  provider = new ethers.providers.Web3Provider(window.ethereum, "any");
  return provider;
}

/* -------------------- 2) KẾT NỐI / NGẮT VÍ -------------------- */
async function connectWallet(){
  try{
    await ensureProvider();
    if(!provider) return;
    await provider.send("eth_requestAccounts", []);
    signer = provider.getSigner();
    user = await signer.getAddress();
    await bindContracts();
    await updateAccountUI();
    bindOrderPlacedListener();
  }catch(e){
    console.error(e); toast("Kết nối ví bị huỷ");
  }
}
async function disconnectWallet(){
  signer = null; user = null; isReg = false;
  $("#walletInfo").classList.add("hidden");
  $("#btnConnect").classList.remove("hidden");
  $("#btnRegister").classList.add("hidden");
  $("#btnCreateProduct").classList.add("hidden");
  renderProductsUI(); // để ẩn nút Mua/Cập nhật cho khách
}

async function bindContracts(){
  await loadABIs();
  const base = signer || provider;
  muaban = new ethers.Contract(MUABAN, abiMuaban, base);
  vin    = new ethers.Contract(VIN, abiVin, base);
}

/* -------------------- 3) HIỂN THỊ ACCOUNT + QUYỀN -------------------- */
async function updateAccountUI(){
  try{
    await bindContracts();
    if (!signer || !user){
      $("#walletInfo").classList.add("hidden");
      $("#btnConnect").classList.remove("hidden");
      $("#btnRegister").classList.add("hidden");
      $("#btnCreateProduct").classList.add("hidden");
      renderProductsUI();
      return;
    }

    // Addr & balances
    const accShort = $("#accountShort");
    accShort.textContent = shorten(user);
    accShort.href = `https://vicscan.xyz/address/${user}`;
    const vinBal = await vin.balanceOf(user);
    const vicBal = await provider.getBalance(user); // VIC là native coin
    $("#vinBalance").textContent = fmt4(ethers.utils.formatUnits(vinBal, 18));
    $("#vicBalance").textContent = fmt4(ethers.utils.formatEther(vicBal));

    // Registered?
    isReg = await muaban.isRegistered(user);
    if (!isReg){
      show($("#btnRegister"));
      hide($("#btnCreateProduct"));
    }else{
      hide($("#btnRegister"));
      show($("#btnCreateProduct"));
    }

    $("#btnConnect").classList.add("hidden");
    $("#walletInfo").classList.remove("hidden");

    // Re-render cards theo vai trò
    renderProductsUI();
  }catch(e){
    console.error(e); toast("Không đọc được trạng thái ví");
  }
}

/* -------------------- 4) GIÁ VIN≈USD -------------------- */
/** 
 * Quy ước: 1 USD = (VIC/USDT * 100) VIN
 * Lưu ở kiểu BigNumber, scale = 18 (wei) cho VIN.
 */
async function refreshVinPrice(){
  try{
    // Lấy giá VIC/USDT từ Binance
    const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT", {cache:"no-store"});
    const j = await r.json();
    const vicUsd = Number(j.price || "0"); // USD
    if (vicUsd > 0){
      // 1 USD = (1 / USD/VIN) VIN; USD/VIN = 1/(VIC*100) => 1 USD = VIC*100 VIN
      const vinPerUsd = vicUsd * 100; // số VIN cho 1 USD
      $("#vinPriceUsd").textContent = fmt2(vinPerUsd);
      vinPerUSD_BN = ethers.utils.parseUnits(String(vinPerUsd), 18);
      return;
    }
    throw new Error("invalid price");
  }catch(e){
    console.warn("Price API error", e);
    if (!vinPerUSD_BN){
      $("#vinPriceUsd").textContent = "—";
    }
  }
}
setInterval(refreshVinPrice, 30_000);

/* -------------------- 5) TẢI SẢN PHẨM & HIỂN THỊ -------------------- */
let productIdsCache = [];  // có thể load từ event ProductCreated; tạm thời quét từ 1..N
let productsMap = new Map(); // id -> raw tuple

async function loadProducts(){
  try{
    await bindContracts();
    // Chiến lược: lấy từ sự kiện ProductCreated -> biết id tối đa
    const filter = muaban.filters.ProductCreated();
    const logs = await muaban.queryFilter(filter, 0, "latest");
    // lấy id từ event
    const ids = [...new Set(logs.map(l=>l.args.productId.toNumber()))].sort((a,b)=>a-b);
    productIdsCache = ids;

    // Lấy detail cho từng id
    productsMap.clear();
    for (const id of ids){
      const p = await muaban.getProduct(id);
      productsMap.set(id, p);
    }
    renderProductsUI();
  }catch(e){
    console.error(e);
    toast("Không tải được sản phẩm");
  }
}

// Tạo 1 card HTML cho 1 sản phẩm
function renderOneProductCard(id, p, q, userAddr){
  const tpl = $("#tplProductCard").content.cloneNode(true);
  const card = tpl.querySelector(".card");

  // media
  const media = tpl.querySelector(".p-media");
  media.innerHTML = "";
  media.appendChild(mediaElFromCID(p.imageCID));

  // title + price
  tpl.querySelector(".p-title").textContent = p.name;
  const vinPrice = quoteVinForUsdCents(p.priceUsdCents);
  tpl.querySelector(".p-price-vin").textContent = `≈ ${fmt4(vinPrice)} VIN / ${p.descriptionCID ? p.descriptionCID : (p.unit||"đv")}`;

  // stock
  const badge = tpl.querySelector(".stock-badge");
  if (p.active && p.stock.toString() !== "0"){
    badge.className = "stock-badge badge ok";
    badge.textContent = "Còn hàng";
  }else{
    badge.className = "stock-badge badge out";
    badge.textContent = "Hết hàng";
  }

  // Buttons by role/state
  const buyBtn = tpl.querySelector(".buy-btn");
  const updBtn = tpl.querySelector(".update-btn");
  const isOwner = userAddr && (String(userAddr).toLowerCase() === String(p.seller).toLowerCase());
  const canBuy = !isOwner && p.active && p.stock.toString() !== "0";

  if (!userAddr){
    // khách chưa connect: ẩn hết để tránh mở modal
    hide(buyBtn); hide(updBtn);
  }else if (isOwner){
    hide(buyBtn); show(updBtn);
    updBtn.dataset.productId = String(id);
  }else{
    if (canBuy){ show(buyBtn); } else { hide(buyBtn); }
    hide(updBtn);
    buyBtn.dataset.productId = String(id);
  }

  // Lọc theo ô tìm kiếm
  if (q){
    const t = (p.name||"").toLowerCase() + " " + (p.descriptionCID||"").toLowerCase();
    if (!t.includes(q.toLowerCase())){ card.classList.add("hidden"); }
  }
  return tpl;
}

function quoteVinForUsdCents(usdCents){
  // usdCents (integer) -> USD float
  const usd = Number(ethers.BigNumber.from(usdCents).toString()) / 100;
  // 1 USD ≈ (vinPerUSD_BN / 1e18) VIN; nếu chưa có giá, để "--"
  if (!vinPerUSD_BN) return 0;
  const vinPerUsd = Number(ethers.utils.formatUnits(vinPerUSD_BN, 18));
  return usd * vinPerUsd;
}

function renderProductsUI(){
  const list = $("#productList");
  list.innerHTML = "";
  const q = ($("#searchInput").value||"").trim();

  let count = 0;
  for (const id of productIdsCache){
    const p = productsMap.get(id);
    if (!p) continue;
    const cardFrag = renderOneProductCard(id, p, q, user);
    list.appendChild(cardFrag);
    count++;
  }
  if (count===0){ show($("#emptyProducts")); } else { hide($("#emptyProducts")); }
}

/* -------------------- 6) TẠO / CẬP NHẬT SẢN PHẨM -------------------- */
async function openCreateModal(){
  if (!user || !signer) { toast("Kết nối ví trước"); await connectWallet(); if(!user) return; }
  if (!isReg){ toast("Ví chưa đăng ký người bán"); return; }
  // reset form
  $("#pName").value="";
  $("#pImageCID").value="";
  $("#pUnit").value="";
  $("#pPriceUsd").value="";
  $("#pRevenueWallet").value=user;
  $("#pDeliveryDays").value="7";
  show($("#createModal"));
}
async function submitCreate(){
  try{
    if (!user || !signer) return toast("Kết nối ví");
    if (!isReg) return toast("Ví chưa đăng ký");

    const name = $("#pName").value.trim().slice(0,500);
    const imageCID = $("#pImageCID").value.trim();
    const unit = $("#pUnit").value.trim() || "đv";
    const priceUsd = Number($("#pPriceUsd").value);
    const revenueWallet = $("#pRevenueWallet").value.trim();
    const delivery = parseInt($("#pDeliveryDays").value||"7",10);

    if (!name || !imageCID || !(priceUsd>0) || !ethers.utils.isAddress(revenueWallet) || delivery<1){
      return toast("Điền đúng: Tên/Ảnh/Giá/Ví/Ngày");
    }

    // Lấy public key mã hoá của người bán (MetaMask/Coin98)
    let sellerPubB64 = "";
    try{
      sellerPubB64 = await ethereum.request({ method: 'eth_getEncryptionPublicKey', params: [user] });
    }catch(e){ console.warn("No enc pub key", e); }

    const priceC = Math.round(priceUsd*100);
    const shippingC = 0; // gộp vào giá
    const taxBps = 0;    // đã gộp vào giá
    const descCID = unit; // dùng trường descriptionCID để hiển thị 'đơn vị tính'

    const tx = await muaban.createProduct(
      name, descCID, imageCID,
      priceC, shippingC, taxBps, delivery,
      revenueWallet, ethers.constants.AddressZero, ethers.constants.AddressZero,
      sellerPubB64 ? ethers.utils.toUtf8Bytes(sellerPubB64) : "0x",
      1, true
    );
    toast("Đang đăng sản phẩm…");
    await tx.wait();
    hide($("#createModal"));
    await loadProducts();
    renderProductsUI();
  }catch(e){
    console.error(e); toast("Đăng sản phẩm thất bại");
  }
}

let updatingId = null;
async function openUpdateModal(pid){
  try{
    if (!user || !signer) { toast("Kết nối ví"); await connectWallet(); if(!user) return; }
    const p = await muaban.getProduct(pid);
    if (String(p.seller).toLowerCase() !== String(user).toLowerCase()){
      return toast("Bạn không phải chủ sản phẩm");
    }
    updatingId = pid;
    $("#uProductId").value = pid;
    $("#uPriceUsd").value = (Number(p.priceUsdCents)/100).toFixed(2);
    $("#uRevenueWallet").value = p.revenueWallet;
    $("#uDeliveryDays").value = p.deliveryDaysMax;
    $("#uStock").value = p.stock.toString();
    $("#uActive").checked = p.active;
    show($("#updateModal"));
  }catch(e){
    console.error(e); toast("Không mở được form cập nhật");
  }
}
async function submitUpdate(){
  try{
    if (!user || !signer || updatingId===null) return;
    const priceUsd = Number($("#uPriceUsd").value);
    const priceC = Math.round(priceUsd*100);
    const revenueWallet = $("#uRevenueWallet").value.trim();
    const delivery = parseInt($("#uDeliveryDays").value||"7",10);
    const stock = parseInt($("#uStock").value||"0",10);
    const active = $("#uActive").checked;

    if (!(priceC>=0) || !ethers.utils.isAddress(revenueWallet) || delivery<1 || stock<0){
      return toast("Dữ liệu không hợp lệ");
    }

    // cập nhật khóa mã hoá (có thể thay đổi ví → khác khóa)
    let sellerPubB64 = "";
    try{ sellerPubB64 = await ethereum.request({ method: 'eth_getEncryptionPublicKey', params: [user] }); }catch(_e){}
    const tx = await muaban.updateProduct(
      updatingId, priceC, 0, 0, delivery,  // shippingC=0, tax=0 (đã gộp)
      revenueWallet, ethers.constants.AddressZero, ethers.constants.AddressZero,
      stock,
      sellerPubB64 ? ethers.utils.toUtf8Bytes(sellerPubB64) : "0x"
    );
    toast("Đang cập nhật…"); await tx.wait();

    // active on/off
    const want = active;
    const p = await muaban.getProduct(updatingId);
    if (p.active !== want){
      const tx2 = await muaban.setProductActive(updatingId, want);
      toast("Đang đổi trạng thái…"); await tx2.wait();
    }

    hide($("#updateModal"));
    await loadProducts();
  }catch(e){
    console.error(e); toast("Cập nhật thất bại");
  }
}

/* -------------------- 7) MUA HÀNG (MÃ HOÁ NGẦM) -------------------- */
// Tải NaCl khi cần
async function ensureNacl(){
  if (window.nacl) return;
  await import("https://cdn.jsdelivr.net/npm/tweetnacl-util@0.15.1/nacl-util.js");
  await import("https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js");
}
// Mã hoá shipping JSON bằng publicKey (base64) của seller
async function encryptForSeller_base64Pub(pubB64, plaintext){
  await ensureNacl();
  const pubBytes = nacl.util.decodeBase64(pubB64);
  const eph   = nacl.box.keyPair(); // ephemeral
  const nonce = nacl.randomBytes(24);
  const msg   = nacl.util.decodeUTF8(plaintext);
  const ct    = nacl.box(msg, nonce, pubBytes, eph.secretKey);
  const packed = new Uint8Array(1+eph.publicKey.length+nonce.length+ct.length);
  let o=0; packed[o++]=1; // version
  packed.set(eph.publicKey,o); o+=eph.publicKey.length;
  packed.set(nonce,o); o+=nonce.length;
  packed.set(ct,o);
  return "0x"+Array.from(packed).map(b=>b.toString(16).padStart(2,"0")).join("");
}

let buying = { id:null, p:null };
async function startBuy(productId){
  if (!user || !signer){ toast("Hãy kết nối ví để mua"); await connectWallet(); if(!user) return; }
  const p = await muaban.getProduct(productId);
  if (!p.active || p.stock.toString() === "0"){ return toast("Sản phẩm tạm hết hàng"); }
  buying = { id: productId, p };
  // reset form
  $("#shipName").value="";
  $("#shipPhone").value="";
  $("#shipAddress").value="";
  $("#shipNote").value="";
  show($("#buyModal"));
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
      const sellerPubBytes = buying.p.sellerEncryptPubKey; // bytes
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

    // VIN cần trả (gọi quote hoặc tự tính từ USD)
    const priceC = buying.p.priceUsdCents.toNumber ? buying.p.priceUsdCents.toNumber() : Number(buying.p.priceUsdCents);
    const { vinTotal } = await quoteFromContract(buying.id, 1);
    const need = vinTotal || usdCentsToVinWei_BN(priceC, vinPerUSD_BN);

    // Approve VIN
    const allowance = await vin.allowance(user, MUABAN);
    if (allowance.lt(need)){ const tx1 = await vin.approve(MUABAN, need); toast("Đang ký approve VIN…"); await tx1.wait(); }

    // placeOrder(quantity=1)
    const tx2 = await muaban.placeOrder(buying.id, 1, vinPerUSD_BN, shipHex);
    toast("Đang gửi đơn hàng…"); await tx2.wait();
    toast("Đặt hàng thành công");
    hide($("#buyModal"));
    await updateAccountUI();
    await loadBuyerOrders(); // cập nhật tab
  }catch(e){ console.error(e); toast("Đặt hàng thất bại"); }
}
function usdCentsToVinWei_BN(usdCents, vinPerUSD_BN){
  // (usdCents/100) * vinPerUSD
  const usd = ethers.BigNumber.from(usdCents);
  // vin = vinPerUSD_BN * usd / 100
  return vinPerUSD_BN.mul(usd).div(100);
}
async function quoteFromContract(productId, qty){
  if (!vinPerUSD_BN){ await refreshVinPrice(); }
  try{
    const out = await muaban.quoteVinForProduct(productId, qty, vinPerUSD_BN);
    return { vinRevenue: out.vinRevenue, vinShipping: out.vinShipping, vinTax: out.vinTax, vinTotal: out.vinTotal };
  }catch(_e){ return {}; }
}

/* -------------------- 8) LẮNG NGHE ĐƠN HÀNG MỚI (CHO NGƯỜI BÁN) -------------------- */
function bindOrderPlacedListener(){
  if (!muaban || !user || connectedOrderListener) return;
  connectedOrderListener = true;
  muaban.on("OrderPlaced", (orderId, productId, buyer, seller, quantity, vinAmountTotal, placedAt, deadline, shippingInfoCiphertext, ev) => {
    if (String(seller).toLowerCase() === String(user).toLowerCase()){
      const amt = fmt4(ethers.utils.formatUnits(vinAmountTotal, 18));
      toast(`Có đơn hàng mới #${orderId.toString()} • Tổng ${amt} VIN`);
      console.log("OrderPlaced", { orderId: orderId.toString(), productId: productId.toString(), buyer, vinAmountTotal: amt, tx: ev.transactionHash });
      // nạp lại danh sách đơn bán
      loadSellerOrders().catch(console.error);
    }
  });
}

/* -------------------- 9) ĐƠN CỦA TÔI (NGƯỜI MUA / NGƯỜI BÁN) -------------------- */
// Buyer: query event OrderPlaced với topic buyer = user
async function loadBuyerOrders(){
  if (!user){ show($("#emptyBuyerOrders")); return; }
  const wrap = $("#buyerOrders"); wrap.innerHTML = "";
  const filter = muaban.filters.OrderPlaced(null, null, user);
  const logs = await muaban.queryFilter(filter, 0, "latest");
  if (logs.length===0){ show($("#emptyBuyerOrders")); return; } else hide($("#emptyBuyerOrders"));
  for (const lg of logs.reverse()){ // đơn mới lên đầu
    const oId = lg.args.orderId.toNumber();
    const od = await muaban.getOrder(oId);
    const card = renderBuyerOrderCard(od, lg);
    wrap.appendChild(card);
  }
}
function renderBuyerOrderCard(od, lg){
  const tpl = $("#tplBuyerOrder").content.cloneNode(true);
  tpl.querySelector(".p-title").textContent = `Đơn #${od.orderId.toString()} • SP #${od.productId.toString()}`;
  tpl.querySelector(".p-price-vin").textContent = `Tổng: ${fmt4(ethers.utils.formatUnits(od.vinAmountTotal,18))} VIN`;
  tpl.querySelector(".muted.mono").textContent = `Trạng thái: ${orderStatusText(od.status)} • Hạn: ${new Date(od.deadline*1000).toLocaleString()}`;
  const btnC = tpl.querySelector(".confirm-btn");
  const btnR = tpl.querySelector(".refund-btn");

  // enable theo trạng thái
  const now = Date.now()/1000|0;
  if (Number(od.status)===0){ // Active
    btnC.onclick = ()=>confirmReceived(od.orderId);
    if (now > Number(od.deadline)){
      btnR.onclick = ()=>refundIfExpired(od.orderId);
      btnR.classList.remove("disabled");
    }else{
      btnR.classList.add("disabled");
    }
  }else{
    btnC.classList.add("disabled");
    btnR.classList.add("disabled");
  }
  return tpl;
}

// Seller: lấy danh sách productId của seller → quét event OrderPlaced(productId indexed)
async function loadSellerOrders(){
  if (!user){ show($("#emptySellerOrders")); return; }
  const wrap = $("#sellerOrders"); wrap.innerHTML = "";
  const ids = await muaban.getSellerProductIds(user);
  let has = false;
  for (const pid of ids){
    const filter = muaban.filters.OrderPlaced(null, pid, null);
    const logs = await muaban.queryFilter(filter, 0, "latest");
    for (const lg of logs.reverse()){
      const oId = lg.args.orderId.toNumber();
      const od = await muaban.getOrder(oId);
      // chỉ hiển thị đơn còn active/chưa confirm hoặc vừa mới tạo
      if (Number(od.status)===0){
        has = true;
        wrap.appendChild(renderSellerOrderCard(od, lg));
      }
    }
  }
  if (!has) show($("#emptySellerOrders")); else hide($("#emptySellerOrders"));
}
function renderSellerOrderCard(od, lg){
  const tpl = $("#tplSellerOrder").content.cloneNode(true);
  tpl.querySelector(".p-title").textContent = `Đơn #${od.orderId.toString()} • SP #${od.productId.toString()}`;
  tpl.querySelector(".p-price-vin").textContent = `Tổng: ${fmt4(ethers.utils.formatUnits(od.vinAmountTotal,18))} VIN`;
  tpl.querySelector(".muted.mono").textContent = `Người mua: ${shorten(od.buyer)} • Hạn: ${new Date(od.deadline*1000).toLocaleString()}`;
  // decrypt
  const btnD = tpl.querySelector(".decrypt-btn");
  const pre = tpl.querySelector(".shipping-plain");
  btnD.onclick = async ()=>{
    try{
      const hex = od.shippingInfoCiphertext;
      // thử eth_decrypt nếu ciphertext thuộc định dạng ECIES/MetaMask
      try{
        const plain = await ethereum.request({ method: 'eth_decrypt', params: [hex, user] });
        pre.textContent = plain; pre.classList.remove("hidden"); return;
      }catch(_e){}
      // nếu là định dạng NaCl custom (v1), giải mã dùng eth_getEncryptionPublicKey không giúp được;
      // seller cần secret-key tương ứng → không có API truy xuất; vì vậy shipping lưu dạng:
      // packed: [1][ephPub32][nonce24][cipherN]; không có secretKey để giải, chỉ MetaMask/ECIES mới giải được.
      // Do submitBuy dùng NaCl với sellerPub (base64) -> Nacl.box cần secretKey của người bán (không xuất ra được).
      // Ở trình duyệt hiện tại không có, nên fallback: để seller mở ví hỗ trợ giải (tùy ví).
      toast("Không giải mã được bằng ví hiện tại");
    }catch(e){ console.error(e); toast("Giải mã thất bại"); }
  };
  // link tx
  const a = tpl.querySelector(".tx-link");
  a.href = `https://vicscan.xyz/tx/${lg.transactionHash}`;
  return tpl;
}

function orderStatusText(s){
  // enum OrderStatus { Active, Released, Refunded }
  const n = Number(s);
  if (n===0) return "Đang ký quỹ";
  if (n===1) return "Đã xả tiền";
  if (n===2) return "Đã hoàn";
  return "—";
}

async function confirmReceived(orderId){
  try{
    if (!signer) return toast("Kết nối ví");
    const tx = await muaban.confirmReceipt(orderId);
    toast("Xác nhận nhận hàng…"); await tx.wait();
    toast("Đã xả tiền cho người bán");
    await loadBuyerOrders();
    await loadSellerOrders();
  }catch(e){ console.error(e); toast("Xác nhận thất bại"); }
}
async function refundIfExpired(orderId){
  try{
    if (!signer) return toast("Kết nối ví");
    const tx = await muaban.refundIfExpired(orderId);
    toast("Yêu cầu hoàn VIN…"); await tx.wait();
    toast("Đã hoàn VIN nếu đơn quá hạn");
    await loadBuyerOrders();
    await loadSellerOrders();
  }catch(e){ console.error(e); toast("Hoàn tiền thất bại"); }
}

/* -------------------- 10) ĐĂNG KÝ NGƯỜI BÁN -------------------- */
async function payRegistration(){
  try{
    if (!user || !signer) return toast("Kết nối ví");
    // Lấy PLATFORM_FEE từ on-chain nếu cần
    const fee = await muaban.PLATFORM_FEE(); // 0.001 VIN
    // Approve trước
    const allowance = await vin.allowance(user, MUABAN);
    if (allowance.lt(fee)){ const tx1 = await vin.approve(MUABAN, fee); toast("Approve phí đăng ký…"); await tx1.wait(); }
    const tx2 = await muaban.payRegistration();
    toast("Đang đăng ký…"); await tx2.wait();
    toast("Đăng ký thành công");
    await updateAccountUI();
  }catch(e){ console.error(e); toast("Đăng ký thất bại"); }
}

/* -------------------- 11) SỰ KIỆN GIAO DIỆN -------------------- */
function bindUI(){
  $("#btnConnect").onclick = connectWallet;
  $("#btnDisconnect").onclick = disconnectWallet;
  $("#btnReload").onclick = ()=>renderProductsUI();
  $("#searchInput").oninput = ()=>renderProductsUI();

  $("#btnRegister").onclick = payRegistration;
  $("#btnCreateProduct").onclick = openCreateModal;

  $("#createClose").onclick = ()=>hide($("#createModal"));
  $("#createCancel").onclick = ()=>hide($("#createModal"));
  $("#createSubmit").onclick = submitCreate;

  $("#updateClose").onclick = ()=>hide($("#updateModal"));
  $("#updateCancel").onclick = ()=>hide($("#updateModal"));
  $("#updateSubmit").onclick = submitUpdate;

  $("#buyClose").onclick = ()=>hide($("#buyModal"));
  $("#buyCancel").onclick = ()=>hide($("#buyModal"));
  $("#buySubmit").onclick = submitBuy;

  // Click trong grid sản phẩm
  $("#productList").addEventListener("click", async (ev)=>{
    const buy = ev.target.closest(".buy-btn");
    const upd = ev.target.closest(".update-btn");
    if (buy){
      const id = parseInt(buy.dataset.productId,10);
      if (!user || !signer){ toast("Hãy kết nối ví để mua"); await connectWallet(); if(!user) return; }
      await startBuy(id);
      return;
    }
    if (upd){
      const id = parseInt(upd.dataset.productId,10);
      if (!user || !signer){ toast("Kết nối ví của người bán để cập nhật"); await connectWallet(); if(!user) return; }
      await openUpdateModal(id);
      return;
    }
  });

  // Tabs
  $("#btnViewProducts").onclick = ()=>{ showTab("products"); };
  $("#btnBuyerOrders").onclick  = async ()=>{ showTab("buyer"); await loadBuyerOrders(); };
  $("#btnSellerOrders").onclick = async ()=>{ showTab("seller"); await loadSellerOrders(); };
}
function showTab(which){
  const m = {
    products: { s:"#tabProducts", b:"#btnViewProducts" },
    buyer:    { s:"#tabBuyer",    b:"#btnBuyerOrders" },
    seller:   { s:"#tabSeller",   b:"#btnSellerOrders" },
  };
  for (const k of Object.keys(m)){
    const sec = $(m[k].s), btn = $(m[k].b);
    if (k===which){ show(sec); btn.classList.add("outline","active"); }
    else{ hide(sec); btn.classList.remove("active"); }
  }
}

/* -------------------- 12) KHỞI ĐỘNG -------------------- */
window.addEventListener("DOMContentLoaded", async ()=>{
  bindUI();
  showTab("products");
  hide($("#createModal")); hide($("#updateModal")); hide($("#buyModal")); // force-hide
  await ensureProvider(); await bindContracts();
  await refreshVinPrice();
  await loadProducts();

  // Nếu ví sẵn có (đã kết nối trước đó), hiển thị ngay
  if (window.ethereum){
    window.ethereum.on('accountsChanged', ()=>{ disconnectWallet(); });
    window.ethereum.on('chainChanged', ()=>{ window.location.reload(); });
  }
});

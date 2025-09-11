/* ====================================================================
   muaban • app.js (ethers v5) — SAFE INIT
   Sửa lỗi: không gọi ethers ở cấp file; chờ thư viện sẵn sàng.
   Quy đổi CHUẨN:
   - USD per VIN = VICUSDT * 100  (hiển thị)
   - VIN per USD = 1 / (VICUSDT * 100)  (tính VIN phải trả & truyền placeOrder)
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

/* -------------------- Hằng số không phụ thuộc ethers -------------------- */
const RPC = "https://rpc.viction.xyz";
const EXPLORER = "https://vicscan.xyz";
const MUABAN = "0xe01e2213A899E9B3b1921673D2d13a227a8df638";
const VIN    = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4";

/* -------------------- Biến toàn cục -------------------- */
let roProv, provider, signer, user;
let muaban, vin;
let abiMuaban, abiVin;
let isRegistered = false;

let USDperVIN_BN = null; // 1 VIN = ? USD (BN 18)
let vinPerUSD_BN = null; // 1 USD = ? VIN (BN 18)

/* -------------------- Tiện ích phụ thuộc ethers (khởi tạo muộn) -------------------- */
function ONEe18(){ return window.ethers.BigNumber.from("1000000000000000000"); }

/** chuyển chuỗi thập phân -> BigNumber *10^decimals */
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

/* -------------------- Load ABI & Contracts -------------------- */
async function loadABIs(){
  if (abiMuaban && abiVin) return;
  abiMuaban = await (await fetch("Muaban_ABI.json")).json();   // ABI Muaban
  abiVin    = await (await fetch("VinToken_ABI.json")).json(); // ABI VIN
}
async function bindRO(){
  await loadABIs();
  roProv = new window.ethers.providers.JsonRpcProvider(RPC);
  muaban = new window.ethers.Contract(MUABAN, abiMuaban, roProv);
  vin    = new window.ethers.Contract(VIN,    abiVin,    roProv);
}
async function bindRW(){
  await loadABIs();
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
    const usdPerVin = Number(price) * 100;           // 1 VIN = (VICUSDT*100) USD
    $("#vinPriceUsd").textContent = fmt2(usdPerVin); // hiển thị 2 số thập phân

    // BigNumber:
    USDperVIN_BN = toUnitsBN(String(usdPerVin), 18);      // ví dụ: 22.05e18
    vinPerUSD_BN = ONEe18().mul(ONEe18()).div(USDperVIN_BN); // = 1 / usdPerVin (chuẩn 18)
  }catch(e){
    console.warn("Price fetch failed", e);
    if (!USDperVIN_BN) $("#vinPriceUsd").textContent = "—";
  }
}
// USD cents -> VIN wei  (vinWei = vinPerUSD * usdCents / 100)
function usdCentsToVinWei(usdCents){
  if (!vinPerUSD_BN) return window.ethers.BigNumber.from(0);
  return vinPerUSD_BN.mul(window.ethers.BigNumber.from(usdCents)).div(100);
}

/* -------------------- Wallet UI -------------------- */
async function connectWallet(){
  if (!window.ethereum){ toast("Vui lòng cài ví EVM (MetaMask/Coin98)"); return; }
  await bindRW();

  const vic = await provider.getBalance(user);
  const vvin= await vin.balanceOf(user);
  $("#accountShort").textContent = short(user);
  $("#accountShort").href = `${EXPLORER}/address/${user}`;
  $("#vicBalance").textContent = fmt4(window.ethers.utils.formatEther(vic));
  $("#vinBalance").textContent = fmt4(window.ethers.utils.formatUnits(vvin,18));
  hide($("#btnConnect")); show($("#walletInfo"));

  isRegistered = await muaban.isRegistered(user);
  if (isRegistered){ hide($("#btnRegister")); show($("#btnCreateProduct")); }
  else { show($("#btnRegister")); hide($("#btnCreateProduct")); }

  renderProducts(); // cập nhật nút Mua/Cập nhật theo vai trò
}
function disconnectWallet(){
  signer=null; user=null; isRegistered=false;
  show($("#btnConnect")); hide($("#walletInfo"));
  hide($("#btnRegister")); hide($("#btnCreateProduct"));
  renderProducts(); // trở lại chế độ khách
}
async function payRegistration(){
  try{
    if (!signer || !user) return toast("Hãy kết nối ví");
    const fee = await muaban.PLATFORM_FEE(); // 0.001 VIN
    const allow = await vin.allowance(user, MUABAN);
    if (allow.lt(fee)){ const t1=await vin.approve(MUABAN, fee); toast("Approve phí…"); await t1.wait(); }
    const t2=await muaban.payRegistration(); toast("Đăng ký…"); await t2.wait();
    toast("Đăng ký thành công");
    isRegistered = true; hide($("#btnRegister")); show($("#btnCreateProduct"));
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

    // USD cents -> VIN wei -> số VIN (đÃ SỬA CHUẨN)
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
    const taxWallet = revenueWallet; // hợp đồng yêu cầu taxWallet != 0x0
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
  $("#shipName").value=""; $("#shipPhone").value=""; $("#shipAddress").value=""; $("#shipNote").value="";
  show($("#buyModal"));
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

    const priceC = Number(buying.p.priceUsdCents ?? (buying.p[5].toNumber ? buying.p[5].toNumber() : buying.p[5]));
    const vinNeed = usdCentsToVinWei(priceC);

    const allow = await vin.allowance(user, MUABAN);
    if (allow.lt(vinNeed)){ const t1=await vin.approve(MUABAN, vinNeed); toast("Approve VIN…"); await t1.wait(); }

    // placeOrder(productId, qty=1, vinPerUSD_BN, shippingCiphertext)
    const t2 = await muaban.placeOrder(buying.id, 1, vinPerUSD_BN, shipHex);
    toast("Đặt hàng…"); await t2.wait();
    toast("Đặt hàng thành công");
    hide($("#buyModal"));
  }catch(e){ console.error(e); toast("Đặt hàng thất bại"); }
}

/* -------------------- Đơn của tôi (khung cơ bản) -------------------- */
function statusText(s){ const n=Number(s); if(n===1) return "Đang ký quỹ"; if(n===2) return "Đã xả tiền"; if(n===3) return "Đã hoàn"; return "—"; }

/* (Có thể bổ sung phần tải đơn mua/bán như bản trước; không ảnh hưởng tới nút kết nối & giá VIN.) */

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
  $("#btnBuyerOrders").onclick  = ()=>{ showTab("buyer"); };
  $("#btnSellerOrders").onclick = ()=>{ showTab("seller"); };
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

/* -------------------- Bootstrap an toàn (đợi Ethers) -------------------- */
window.addEventListener("DOMContentLoaded", async ()=>{
  bindUI();
  showTab("products");
  hide($("#createModal")); hide($("#updateModal")); hide($("#buyModal"));

  // Chờ ethers sẵn sàng (tránh 'ethers is not defined' trên GitHub Pages)
  const waitEthers = async ()=>{
    const t0 = Date.now();
    while (!window.ethers){
      if (Date.now()-t0 > 5000) { alert("Không tải được thư viện Ethers. Kiểm tra mạng/CDN."); return false; }
      await new Promise(r=>setTimeout(r,50));
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

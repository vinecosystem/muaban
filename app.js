/* ====================================================================
   muaban • app.js (ethers v5)
   - Tính VIN CHÍNH XÁC: 1 USD = (VICUSDT * 100) VIN
   - Khách: chỉ xem giá VIN≈USD + danh sách + tìm kiếm (không có nút Mua)
   - Đã kết nối:
       + Hiện ví + số dư VIN/VIC
       + Nếu chưa đăng ký: chỉ hiện nút "Đăng ký người bán"
       + Nếu đã đăng ký: hiện "Đăng sản phẩm"
   - Sản phẩm:
       + Chủ sản phẩm: chỉ "Cập nhật"
       + Ví khác: có "Mua" → nhập địa chỉ nhận (mã hoá ngầm) → placeOrder
   - Tabs: Sản phẩm / Đơn mua / Đơn bán (khung & hàm nạp cơ bản)
==================================================================== */

/* -------------------- 0) Helper DOM -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show=(el)=>el && el.classList.remove("hidden");
const hide=(el)=>el && el.classList.add("hidden");
const toast=(m)=>{ const t=$("#toast"); if(!t) return alert(m); t.textContent=m; t.classList.remove("hidden"); clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.add("hidden"),2600); };
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`:"";
const fmt2=(x)=>Number(x).toFixed(2);
const fmt4=(x)=>Number(x).toFixed(4);

/* -------------------- 1) Chain & Contracts -------------------- */
const RPC = "https://rpc.viction.xyz";
const EXPLORER = "https://vicscan.xyz";
const MUABAN = "0xe01e2213A899E9B3b1921673D2d13a227a8df638";
const VIN    = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4";

let provider, signer, user;
let muaban, vin;
let abiMuaban, abiVin;
let isRegistered = false;

async function loadABIs(){
  if (abiMuaban && abiVin) return;
  abiMuaban = await (await fetch("Muaban_ABI.json")).json();
  abiVin    = await (await fetch("VinToken_ABI.json")).json();
}
async function bindRO(){
  await loadABIs();
  const ro = new ethers.providers.JsonRpcProvider(RPC);
  muaban = new ethers.Contract(MUABAN, abiMuaban, ro);
  vin    = new ethers.Contract(VIN, abiVin, ro);
}
async function bindRW(){
  await loadABIs();
  provider = new ethers.providers.Web3Provider(window.ethereum,"any");
  signer   = provider.getSigner();
  muaban   = muaban.connect(signer);
  vin      = vin.connect(signer);
  user     = await signer.getAddress();
}

/* -------------------- 2) Giá: 1 USD = (VICUSDT * 100) VIN -------------------- */
/** Chuyển chuỗi thập phân → BigNumber với `decimals` chữ số sau dấu .  */
function decimalToBN(str, decimals){
  const s = String(str);
  const [ip, fp=""] = s.split(".");
  const cleanIp = ip.replace(/\D/g,"") || "0";
  let cleanFp = fp.replace(/\D/g,"");
  if (cleanFp.length > decimals) cleanFp = cleanFp.slice(0,decimals);
  while (cleanFp.length < decimals) cleanFp += "0";
  const full = cleanIp + cleanFp;
  return ethers.BigNumber.from(full || "0");
}
/** Tạo BigNumber = value * 10^decimals từ chuỗi thập phân */
function toUnitsBN(str, decimals){
  return decimalToBN(str, decimals);
}

let vinPerUSD_BN = null; // wei VIN per 1 USD
async function refreshVinPrice(){
  try{
    const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",{cache:"no-store"});
    const { price } = await r.json(); // "0.123456"
    // 1 USD = (VICUSDT * 100) VIN  -> BigNumber(18)
    const vinPerUsdStr = (Number(price) * 100).toString();
    vinPerUSD_BN = toUnitsBN(vinPerUsdStr, 18);
    $("#vinPriceUsd").textContent = fmt2(Number(price)*100); // hiển thị 2 số thập phân
  }catch(e){
    console.warn("Price fetch failed", e);
    if (!vinPerUSD_BN) $("#vinPriceUsd").textContent = "—";
  }
}
// USD cents -> VIN wei  (vinWei = vinPerUSD * usdCents / 100)
function usdCentsToVinWei(usdCents){
  if (!vinPerUSD_BN) return ethers.BigNumber.from(0);
  const centsBN = ethers.BigNumber.from(usdCents);
  return vinPerUSD_BN.mul(centsBN).div(100);
}
setInterval(refreshVinPrice, 30000);

/* -------------------- 3) UI trạng thái ví -------------------- */
async function connectWallet(){
  if (!window.ethereum) return toast("Vui lòng cài ví EVM (MetaMask/Coin98)");
  await provider.send("eth_requestAccounts", []);
  await bindRW();

  // hiển thị ví + số dư
  const vic = await provider.getBalance(user);
  const vvin= await vin.balanceOf(user);
  $("#accountShort").textContent = short(user);
  $("#accountShort").href = `${EXPLORER}/address/${user}`;
  $("#vicBalance").textContent = fmt4(ethers.utils.formatEther(vic));
  $("#vinBalance").textContent = fmt4(ethers.utils.formatUnits(vvin,18));
  hide($("#btnConnect")); show($("#walletInfo"));

  // isRegistered → show/hide nút
  isRegistered = await muaban.isRegistered(user);
  if (isRegistered){ hide($("#btnRegister")); show($("#btnCreateProduct")); }
  else { show($("#btnRegister")); hide($("#btnCreateProduct")); }

  renderProducts(); // để set nút Mua/Cập nhật đúng chủ sở hữu
}
function disconnectWallet(){
  signer=null; user=null; isRegistered=false;
  show($("#btnConnect")); hide($("#walletInfo"));
  hide($("#btnRegister")); hide($("#btnCreateProduct"));
  renderProducts(); // khách: ẩn nút
}
async function payRegistration(){
  try{
    if (!signer || !user) { toast("Hãy kết nối ví"); return; }
    const fee = await muaban.PLATFORM_FEE(); // 0.001 VIN
    const allow = await vin.allowance(user, MUABAN);
    if (allow.lt(fee)){ const t1=await vin.approve(MUABAN, fee); toast("Approve phí…"); await t1.wait(); }
    const t2=await muaban.payRegistration(); toast("Đăng ký…"); await t2.wait();
    toast("Đăng ký thành công");
    isRegistered = true;
    hide($("#btnRegister")); show($("#btnCreateProduct"));
  }catch(e){ console.error(e); toast("Đăng ký thất bại"); }
}

/* -------------------- 4) Sản phẩm: tải & hiển thị -------------------- */
// getProduct trả về tuple:
// [0]id,[1]seller,[2]name,[3]descriptionCID(=unit),[4]imageCID,[5]priceUsdCents,
// [6]shipCents,[7]taxBps,[8]deliveryDays,[9]revenueWallet,[10]taxWallet,[11]shippingWallet,
// [12]sellerEncryptPubKey(bytes),[13]active(bool),[14]createdAt,[15]updatedAt,[16]stock
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
  }catch(e){
    console.error(e); toast("Không tải được sản phẩm");
  }
}
function mediaNode(url){
  const u = String(url||"");
  const http = u.startsWith("http://")||u.startsWith("https://") ? u : (u.startsWith("ipfs://")? u.replace("ipfs://","https://ipfs.io/ipfs/") : `https://ipfs.io/ipfs/${u}`);
  const isVid = /\.(mp4|webm|ogg)$/i.test(http);
  const el = isVid ? document.createElement("video"):document.createElement("img");
  if (isVid){ el.src=http; el.controls=true; el.playsInline=true; } else { el.src=http; el.alt="media"; }
  return el;
}
function renderProducts(){
  const wrap = $("#productList"); wrap.innerHTML="";
  const q = ($("#searchInput").value||"").trim().toLowerCase();
  let shown = 0;

  for (const id of productIds.slice().reverse()){ // mới lên trước
    const p = products.get(id); if (!p) continue;
    const active = p[13]; if (!active) continue;

    const name = p[2]; const unit = p[3]; const media = p[4];
    const priceC = p[5].toNumber ? p[5].toNumber() : Number(p[5]);
    const stock  = p[16]; const seller = p[1];

    // Filter
    const text = ((name||"") + " " + (unit||"")).toLowerCase();
    if (q && !text.includes(q)) continue;

    const tpl = $("#tplProductCard").content.cloneNode(true);
    const mediaWrap = tpl.querySelector(".p-media");
    mediaWrap.innerHTML=""; mediaWrap.appendChild(mediaNode(media));

    const titleEl = tpl.querySelector(".p-title");
    titleEl.textContent = unit ? `${name} (${unit})` : name;

    // Giá: USD cents → VIN wei → VIN number
    const vinWei = usdCentsToVinWei(priceC);
    const vinNum = Number(ethers.utils.formatUnits(vinWei,18));
    tpl.querySelector(".p-price-vin").textContent = `≈ ${fmt4(vinNum)} VIN / ${unit||"đv"}`;

    // Tồn kho
    const badge = tpl.querySelector(".stock-badge");
    const inStock = active && (String(stock) !== "0");
    if (inStock){ badge.classList.add("badge","ok"); badge.textContent="Còn hàng"; }
    else { badge.classList.add("badge","out"); badge.textContent="Hết hàng"; }

    // Nút theo vai trò
    const buyBtn = tpl.querySelector(".buy-btn");
    const updBtn = tpl.querySelector(".update-btn");
    if (!user){
      hide(buyBtn); hide(updBtn);
    }else if (String(user).toLowerCase() === String(seller).toLowerCase()){
      show(updBtn); updBtn.dataset.productId = String(id); hide(buyBtn);
    }else{
      if (inStock){ show(buyBtn); buyBtn.dataset.productId = String(id); } else hide(buyBtn);
      hide(updBtn);
    }

    wrap.appendChild(tpl);
    shown++;
  }
  if (shown===0) show($("#emptyProducts")); else hide($("#emptyProducts"));
}

/* -------------------- 5) Đăng / Cập nhật sản phẩm -------------------- */
function openCreateModal(){
  if (!user){ toast("Kết nối ví trước"); return; }
  if (!isRegistered){ toast("Ví chưa đăng ký người bán"); return; }
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
    if (!name || !media || !(priceUsd>0) || !ethers.utils.isAddress(revenueWallet) || delivery<1){
      return toast("Điền đúng: Tên/Ảnh/Giá/Ví/Ngày");
    }
    let sellerPubB64 = "";
    try{ sellerPubB64 = await ethereum.request({ method:"eth_getEncryptionPublicKey", params:[user] }); }catch(_){}

    const priceC = Math.round(priceUsd*100);
    const shippingC=0, taxBps=0;
    const taxWallet = revenueWallet;          // BẮT BUỘC != 0x0
    const shippingWallet = ethers.constants.AddressZero;
    const stock = 1, active = true;

    const tx = await muaban.connect(signer).createProduct(
      name, unit, media,
      priceC, shippingC, taxBps, delivery,
      revenueWallet, taxWallet, shippingWallet,
      sellerPubB64 ? ethers.utils.toUtf8Bytes(sellerPubB64) : "0x",
      stock, active
    );
    toast("Đăng sản phẩm…"); await tx.wait();
    hide($("#createModal"));
    await loadProducts();
  }catch(e){ console.error(e); toast("Đăng sản phẩm thất bại"); }
}

let updatingId = null;
async function openUpdateModal(pid){
  if (!user){ toast("Kết nối ví"); return; }
  await bindRW();
  const p = await muaban.getProduct(pid);
  if (String(p[1]).toLowerCase() !== String(user).toLowerCase()) return toast("Không phải chủ sản phẩm");
  updatingId = pid;
  $("#uProductId").value = String(pid);
  $("#uPriceUsd").value  = (Number(p[5])/100).toFixed(2);
  $("#uRevenueWallet").value = p[9];
  $("#uDeliveryDays").value  = p[8];
  $("#uStock").value = p[16].toString();
  $("#uActive").checked = !!p[13];
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
    if (!(priceUsd>=0) || !ethers.utils.isAddress(revenueWallet) || delivery<1 || stock<0) return toast("Dữ liệu không hợp lệ");

    let sellerPubB64 = "";
    try{ sellerPubB64 = await ethereum.request({ method:"eth_getEncryptionPublicKey", params:[user] }); }catch(_){}

    const priceC = Math.round(priceUsd*100);
    const tx = await muaban.updateProduct(
      updatingId, priceC, 0, 0, delivery,
      revenueWallet, revenueWallet, ethers.constants.AddressZero,
      stock,
      sellerPubB64 ? ethers.utils.toUtf8Bytes(sellerPubB64) : "0x"
    );
    toast("Cập nhật…"); await tx.wait();

    // bật/tắt
    const cur = await muaban.getProduct(updatingId);
    if (!!cur[13] !== active){
      const t2 = await muaban.setProductActive(updatingId, active);
      await t2.wait();
    }
    hide($("#updateModal"));
    await loadProducts();
  }catch(e){ console.error(e); toast("Cập nhật thất bại"); }
}

/* -------------------- 6) Mua hàng (mã hoá ngầm) -------------------- */
let buying = { id:null, p:null };
async function startBuy(pid){
  if (!user){ toast("Kết nối ví để mua"); return; }
  const p = await muaban.getProduct(pid);
  if (!p[13] || String(p[16])==="0") return toast("Sản phẩm tạm hết hàng");
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
  const pk = nacl.util.decodeBase64(pubB64);
  const eph=nacl.box.keyPair(), nonce=nacl.randomBytes(24), msg=nacl.util.decodeUTF8(plainJSON);
  const ct = nacl.box(msg, nonce, pk, eph.secretKey);
  // Gói MetaMask-compatible
  const payload = {
    version:"x25519-xsalsa20-poly1305",
    ephemPublicKey: nacl.util.encodeBase64(eph.publicKey),
    nonce:          nacl.util.encodeBase64(nonce),
    ciphertext:     nacl.util.encodeBase64(ct)
  };
  return ethers.utils.hexlify(ethers.utils.toUtf8Bytes(JSON.stringify(payload)));
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

    // Mã hoá shipping info bằng pubkey người bán (nếu có)
    let shipHex;
    try{
      let sellerPubB64="";
      try{ sellerPubB64 = ethers.utils.toUtf8String(buying.p[12]); }catch(_){}
      const plain = JSON.stringify(ship);
      shipHex = sellerPubB64 ? await encryptForSellerBase64(sellerPubB64, plain)
                             : ethers.utils.hexlify(ethers.utils.toUtf8Bytes(plain));
    }catch(e){ console.warn("encrypt fail", e); shipHex = ethers.utils.hexlify(ethers.utils.toUtf8Bytes(JSON.stringify(ship))); }

    // Tính VIN cần trả từ USD cents (đÃ SỬA CHÍNH XÁC)
    const priceC = buying.p[5].toNumber ? buying.p[5].toNumber() : Number(buying.p[5]);
    const vinNeed = usdCentsToVinWei(priceC); // = vinPerUSD * priceC / 100

    // Approve nếu thiếu
    const allow = await vin.allowance(user, MUABAN);
    if (allow.lt(vinNeed)){ const t1=await vin.approve(MUABAN, vinNeed); toast("Approve VIN…"); await t1.wait(); }

    // Gọi placeOrder(productId, qty=1, vinPerUSD_BN, shippingCipher)
    const t2 = await muaban.placeOrder(buying.id, 1, vinPerUSD_BN, shipHex);
    toast("Đặt hàng…"); await t2.wait();
    toast("Đặt hàng thành công");
    hide($("#buyModal"));
  }catch(e){ console.error(e); toast("Đặt hàng thất bại"); }
}

/* -------------------- 7) Đơn của tôi (khung cơ bản) -------------------- */
// Lưu ý: Enum (ví dụ) NONE=0, PLACED=1, RELEASED=2, REFUNDED=3
function statusText(s){
  const n=Number(s); if(n===1) return "Đang ký quỹ"; if(n===2) return "Đã xả tiền"; if(n===3) return "Đã hoàn"; return "—";
}
async function loadBuyerOrders(){
  if (!user){ show($("#emptyBuyerOrders")); return; }
  const wrap = $("#buyerOrders"); wrap.innerHTML="";
  try{
    const logs = await muaban.queryFilter(muaban.filters.OrderPlaced(null,null,user));
    if (!logs.length){ show($("#emptyBuyerOrders")); return; } else hide($("#emptyBuyerOrders"));
    for (const lg of logs.reverse()){
      const od = await muaban.getOrder(lg.args.orderId);
      const card = $("#tplBuyerOrder").content.cloneNode(true);
      card.querySelector(".p-title").textContent = `Đơn #${od.orderId} • SP #${od.productId}`;
      card.querySelector(".p-price-vin").textContent = `Tổng: ${fmt4(ethers.utils.formatUnits(od.vinAmountTotal,18))} VIN`;
      card.querySelector(".muted.mono").textContent = `Trạng thái: ${statusText(od.status)} • Hạn: ${new Date(Number(od.deadline)*1000).toLocaleString()}`;

      const btnC = card.querySelector(".confirm-btn");
      const btnR = card.querySelector(".refund-btn");
      const now = Date.now()/1000|0;

      if (Number(od.status)===1){ // PLACED
        btnC.onclick = async()=>{ try{ const tx=await muaban.confirmReceipt(od.orderId); toast("Xác nhận…"); await tx.wait(); await loadBuyerOrders(); }catch(e){toast("Lỗi xác nhận");} };
        if (now > Number(od.deadline)){
          btnR.onclick = async()=>{ try{ const tx=await muaban.refundIfExpired(od.orderId); toast("Yêu cầu hoàn…"); await tx.wait(); await loadBuyerOrders(); }catch(e){toast("Lỗi hoàn");} };
        }else{ btnR.classList.add("disabled"); }
      }else{
        btnC.classList.add("disabled");
        btnR.classList.add("disabled");
      }
      wrap.appendChild(card);
    }
  }catch(e){ console.error(e); toast("Không tải được đơn mua"); }
}
async function loadSellerOrders(){
  if (!user){ show($("#emptySellerOrders")); return; }
  const wrap = $("#sellerOrders"); wrap.innerHTML="";
  try{
    const ids = await muaban.getSellerProductIds(user);
    let has=false;
    for (const pid of ids){
      const logs = await muaban.queryFilter(muaban.filters.OrderPlaced(null,pid,null));
      for (const lg of logs.reverse()){
        const od = await muaban.getOrder(lg.args.orderId);
        if (Number(od.status)!==1) continue; // chỉ đơn đang hiệu lực
        has=true;
        const card = $("#tplSellerOrder").content.cloneNode(true);
        card.querySelector(".p-title").textContent = `Đơn #${od.orderId} • SP #${od.productId}`;
        card.querySelector(".p-price-vin").textContent = `Tổng: ${fmt4(ethers.utils.formatUnits(od.vinAmountTotal,18))} VIN`;
        card.querySelector(".muted.mono").textContent = `Người mua: ${short(od.buyer)} • Hạn: ${new Date(Number(od.deadline)*1000).toLocaleString()}`;
        card.querySelector(".tx-link").href = `${EXPLORER}/tx/${lg.transactionHash}`;
        const btnD = card.querySelector(".decrypt-btn");
        const pre  = card.querySelector(".shipping-plain");
        btnD.onclick = async()=>{
          try{
            const hex = od.shippingInfoCiphertext;
            const plain = await ethereum.request({ method:"eth_decrypt", params:[hex, user] });
            pre.textContent = plain; pre.classList.remove("hidden");
          }catch(_){ toast("Không giải mã được với ví hiện tại"); }
        };
        wrap.appendChild(card);
      }
    }
    if (!has) show($("#emptySellerOrders")); else hide($("#emptySellerOrders"));
  }catch(e){ console.error(e); toast("Không tải được đơn bán"); }
}

/* -------------------- 8) Sự kiện UI -------------------- */
function bindUI(){
  $("#btnConnect").onclick = async()=>{ if(!window.ethereum){toast("Cài ví EVM");return;} provider=new ethers.providers.Web3Provider(window.ethereum,"any"); await connectWallet(); };
  $("#btnDisconnect").onclick = disconnectWallet;
  $("#btnRegister").onclick   = payRegistration;
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

  // Grid click
  $("#productList").addEventListener("click", async (ev)=>{
    const buy = ev.target.closest(".buy-btn");
    const upd = ev.target.closest(".update-btn");
    if (buy){
      const id = parseInt(buy.dataset.productId,10);
      if (!user){ toast("Kết nối ví để mua"); return; }
      await startBuy(id);
    }
    if (upd){
      const id = parseInt(upd.dataset.productId,10);
      await openUpdateModal(id);
    }
  });

  // Tabs
  $("#btnViewProducts").onclick = ()=>{ showTab("products"); };
  $("#btnBuyerOrders").onclick  = async()=>{ showTab("buyer"); await loadBuyerOrders(); };
  $("#btnSellerOrders").onclick = async()=>{ showTab("seller"); await loadSellerOrders(); };
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

/* -------------------- 9) Khởi động -------------------- */
window.addEventListener("DOMContentLoaded", async ()=>{
  bindUI();
  showTab("products");
  hide($("#createModal")); hide($("#updateModal")); hide($("#buyModal")); // force hide
  await bindRO();
  await refreshVinPrice();
  await loadProducts();

  if (window.ethereum){
    window.ethereum.on("accountsChanged", ()=>{ disconnectWallet(); });
    window.ethereum.on("chainChanged", ()=>{ location.reload(); });
  }
});

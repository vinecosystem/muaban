/* ======================================================================
   muaban — app.js (ethers v5)
   - Connect wallet (+ switch/add Viction 88)
   - Show VIN/VIC balance (4 decimals), 1 VIN ≈ USD (2 decimals)
   - Create product (6 trường đơn giản):
       name, image/link (CID/ipfs://https://), unit (lưu vào descriptionCID),
       price USD (TOTAL đã gồm thuế+ship), revenueWallet, deliveryDays
     => on-chain: priceUsdCents = tổng; shippingUsdCents=0; taxRateBps=0;
        taxWallet = revenueWallet; shippingWallet = 0x0; stock=999999; active=true
   - List: media + name (unit) + ≈ X VIN/đơn vị + badge stock + nút theo quyền
   - Buy: qty=1; nhập shipping info; approve VIN → placeOrder(productId, 1, vinPerUSD, bytes)
   ====================================================================== */

/* -------------------- 0) CONFIG -------------------- */
const RPC_URL = "https://rpc.viction.xyz";
const CHAIN_ID_HEX = "0x58";               // 88
const EXPLORER = "https://vicscan.xyz";
const MUABAN = "0xe01e2213A899E9B3b1921673D2d13a227a8df638"; // Muaban
const VIN    = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4"; // VIN token

// Minimal ABIs (đủ dùng)
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
  "function getProduct(uint256) view returns (tuple(uint256,address,string,string,string,uint256,uint256,uint16,uint32,address,address,address,bytes,bool,uint64,uint64,uint256))",
  "event ProductCreated(uint256 indexed productId,address indexed seller,string,string,string,uint256,uint256,uint16,uint32,address,address,address,bytes,uint256)"
];

/* -------------------- 1) STATE -------------------- */
let provider, signer, user;
let muaban, vin;
let vinPerUSD_BN = null;   // BigNumber (VIN wei / USD)

/* -------------------- 2) HELPERS -------------------- */
const $ = (q) => document.querySelector(q);
function show(el){ el.classList.remove("hidden"); }
function hide(el){ el.classList.add("hidden"); }
function short(addr){ return addr ? addr.slice(0,6)+"…"+addr.slice(-4) : ""; }
function toast(msg, ms=2800){ const t=$("#toast"); t.textContent=msg; t.classList.remove("hidden"); setTimeout(()=>t.classList.add("hidden"), ms); }

// Chuẩn hoá media URL: CID / ipfs:// / https:// → https gateway
function toDisplayUrl(input){
  if (!input) return "";
  const s = String(input).trim();
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("ipfs://")) return s.replace("ipfs://","https://ipfs.io/ipfs/");
  return "https://ipfs.io/ipfs/" + s; // assume CID
}
function isVideoUrl(u){
  const x = u.toLowerCase();
  return x.endsWith(".mp4") || x.endsWith(".webm") || x.endsWith(".ogg");
}

// Định dạng số
function fmt2(x){ return Number(x).toFixed(2); }
function fmt4(x){ return Number(x).toFixed(4); }

/* -------------------- 3) STARTUP -------------------- */
window.addEventListener("DOMContentLoaded", () => {
  $("#btnConnect").addEventListener("click", connectWallet);
  $("#btnDisconnect").addEventListener("click", disconnectWallet);
  $("#btnRegister").addEventListener("click", doRegister);

  // Create product modal
  $("#btnCreateProduct").addEventListener("click", ()=>show($("#createModal")));
  $("#createClose").addEventListener("click", ()=>hide($("#createModal")));
  $("#createCancel").addEventListener("click", ()=>hide($("#createModal")));
  $("#createSubmit").addEventListener("click", submitCreate);

  // Buy modal
  $("#buyClose").addEventListener("click", ()=>hide($("#buyModal")));
  $("#buyCancel").addEventListener("click", ()=>hide($("#buyModal")));
  $("#buySubmit").addEventListener("click", submitBuy);

  // Product list
  $("#productList").addEventListener("click", onProductClick);

  refreshVinPrice().then(loadProducts);
});

/* -------------------- 4) PRICE (no BigInt; dùng BigNumber an toàn) -------------------- */
function computeVinPerUSD_BN(vicUsdStr){
  // vicUsdStr: "0.42" USD/VIC
  // 1 VIN = 100 VIC → VIN(USD) = vicUsd * 100
  // vinPerUSD (VIN wei / USD) = 1e18 / (VIN(USD))
  // Tránh float: scale 1e8  → vinPerUSD = floor(1e26 / (vicUsdInt*100))
  const SCALE = 8;
  const parts = String(vicUsdStr).split(".");
  const ip = parts[0] || "0";
  let fp = (parts[1] || "").slice(0, SCALE);
  while (fp.length < SCALE) fp += "0";
  const vicUsdInt = (parseInt(ip,10) * Math.pow(10, SCALE)) + parseInt(fp||"0",10); // USD*1e8/VIC
  const vinUsdInt = vicUsdInt * 100; // USD*1e8/VIN
  const numerator = ethers.BigNumber.from("100000000000000000000000000"); // 1e26
  return numerator.div(String(vinUsdInt)); // floor
}

function usdCentsToVinWei_BN(usdCents, vinPerUSD){
  // ceil(usdCents * vinPerUSD / 100)
  const num = vinPerUSD.mul(usdCents);
  return num.add(ethers.BigNumber.from(99)).div(100);
}

async function refreshVinPrice(){
  try{
    $("#vinPriceUsd").textContent = "Loading…";
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT");
    const { price } = await res.json(); // string
    const vinUsd = Number(price) * 100;
    $("#vinPriceUsd").textContent = fmt2(vinUsd); // 2 decimals
    vinPerUSD_BN = computeVinPerUSD_BN(price);
  }catch(e){
    console.error(e);
    $("#vinPriceUsd").textContent = "—";
  }
}

/* -------------------- 5) WALLET -------------------- */
async function connectWallet(){
  if (!window.ethereum){ toast("Vui lòng cài MetaMask / ví EVM"); return; }

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
    }else{
      console.error(err); toast("Không thể chuyển mạng Viction"); return;
    }
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

  if (window.ethereum && window.ethereum.on){
    window.ethereum.on("accountsChanged", ()=>connectWallet());
    window.ethereum.on("chainChanged", ()=>window.location.reload());
  }
}

function disconnectWallet(){
  user = null; signer = null; provider = null;
  hide($("#walletInfo")); show($("#btnConnect"));
}

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

async function doRegister(){
  try{
    if (!signer) return toast("Hãy kết nối ví");
    const platformFee = await (new ethers.Contract(MUABAN, ABI_MUABAN, provider)).PLATFORM_FEE();
    const allowance = await vin.allowance(user, MUABAN);
    if (allowance.lt(platformFee)){
      const tx1 = await vin.approve(MUABAN, platformFee);
      toast("Đang ký approve 0.001 VIN…"); await tx1.wait();
    }
    const tx2 = await muaban.payRegistration();
    toast("Đang gửi đăng ký…"); await tx2.wait();
    toast("Đăng ký thành công");
    await checkRegistration();
    await updateAccountUI();
  }catch(e){ console.error(e); toast("Đăng ký thất bại"); }
}

async function checkRegistration(){
  if (!provider || !user){ hide($("#btnRegister")); hide($("#btnCreateProduct")); return; }
  const reg = await (new ethers.Contract(MUABAN, ABI_MUABAN, provider)).isRegistered(user);
  if (reg){ hide($("#btnRegister")); show($("#btnCreateProduct")); }
  else { show($("#btnRegister")); hide($("#btnCreateProduct")); }
}

/* -------------------- 6) CREATE PRODUCT (6 trường) -------------------- */
async function submitCreate(){
  try{
    if (!signer) return toast("Hãy kết nối ví");

    const name = $("#pName").value.trim();
    const media = $("#pImageCID").value.trim();   // CID/ipfs://https://
    const unit = $("#pUnit").value.trim();
    const priceUsd = parseFloat($("#pPriceUsd").value);   // tổng đã gồm mọi phí
    const revenueWallet = $("#pRevenueWallet").value.trim();
    const deliveryDays = parseInt($("#pDeliveryDays").value, 10);

    if (!name || !media || !unit || !priceUsd || !revenueWallet || !deliveryDays){
      return toast("Điền đầy đủ 6 mục");
    }

    const priceCents = Math.round(priceUsd * 100);
    const shipCents = 0;           // tổng đã gồm mọi phí → ship=0
    const taxBps = 0;              // thuế đã gồm trong tổng → 0
    const taxWallet = revenueWallet;
    const shippingWallet = "0x0000000000000000000000000000000000000000";
    const sellerPubKeyHex = "0x";  // phase sau mới bật mã hoá
    const stock = 999999;          // mặc định lớn
    const active = true;

    const tx = await muaban.createProduct(
      name,
      unit,            // reuse descriptionCID để lưu "đơn vị tính"
      media,           // imageCID (nhận CID/url)
      priceCents,
      shipCents,
      taxBps,
      deliveryDays,
      revenueWallet,
      taxWallet,
      shippingWallet,
      sellerPubKeyHex,
      stock,
      active
    );
    toast("Đang đăng sản phẩm…"); await tx.wait();
    toast("Đăng sản phẩm thành công");
    hide($("#createModal"));
    await loadProducts(true);
  }catch(e){
    console.error(e); toast("Tạo sản phẩm thất bại");
  }
}

/* -------------------- 7) LIST & RENDER -------------------- */
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

    const cards = [];
    for (const id of ids){
      const p = await _muaban.getProduct(id);
      const active = p[13];
      if (!active) continue;
      cards.push({ id, p });
    }
    renderProducts(cards);
  }catch(e){
    console.error(e);
    $("#productList").innerHTML = "";
    $("#emptyProducts").textContent = "Không tải được danh sách sản phẩm.";
  }
}

function renderProducts(list){
  const wrap = $("#productList");
  wrap.innerHTML = "";
  if (!list.length){ $("#emptyProducts").textContent = "Chưa có sản phẩm."; return; }
  $("#emptyProducts").textContent = "";
  const tpl = $("#tplProductCard").content;

  for (const { id, p } of list){
    const el = document.importNode(tpl, true);

    const name = p[2];            // name
    const unit = p[3];            // descriptionCID (dùng làm "đơn vị")
    const media = p[4];           // imageCID (CID/url)
    const priceC = p[5].toNumber();
    const stock  = p[16];
    const seller = p[1];

    // Media
    const url = toDisplayUrl(media);
    const mediaWrap = el.querySelector(".p-media");
    mediaWrap.innerHTML = "";
    if (isVideoUrl(url)){
      const v = document.createElement("video");
      v.src = url; v.controls = true; v.playsInline = true;
      mediaWrap.appendChild(v);
    }else{
      const img = document.createElement("img");
      img.src = url; img.alt = name;
      mediaWrap.appendChild(img);
    }

    // Title + unit
    el.querySelector(".p-title").textContent = unit ? `${name} (${unit})` : name;

    // Stock badge
    const badge = el.querySelector(".stock-badge");
    if (String(stock) === "0"){
      badge.textContent = "Hết hàng";
      badge.classList.add("badge","out");
    }else{
      badge.textContent = "Còn hàng";
      badge.classList.add("badge","ok");
    }

    // Giá ≈ X VIN/đơn vị (priceCents đã là tổng)
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

/* -------------------- 8) BUY FLOW -------------------- */
let buying = null;

function onProductClick(ev){
  const buy = ev.target.closest(".buy-btn");
  const upd = ev.target.closest(".update-btn");
  if (buy){
    const id = parseInt(buy.dataset.productId,10);
    startBuy(id);
    return;
  }
  if (upd){
    toast("Chức năng Cập nhật sản phẩm sẽ bổ sung sau.");
    return;
  }
}

async function startBuy(productId){
  try{
    const _prov = provider ? provider : new ethers.providers.JsonRpcProvider(RPC_URL);
    const _muaban = new ethers.Contract(MUABAN, ABI_MUABAN, _prov);
    const p = await _muaban.getProduct(productId);
    buying = { id: productId, p };

    // Mở modal nhập shipping info (không cần hiển thị giá ở đây vì card đã hiển thị)
    show($("#buyModal"));
  }catch(e){ console.error(e); toast("Không tải được sản phẩm"); }
}

async function submitBuy(){
  try{
    if (!signer || !user) return toast("Hãy kết nối ví");
    if (!vinPerUSD_BN) await refreshVinPrice();

    // Validate shipping info
    const shipInfo = {
      name: $("#shipName").value.trim(),
      phone: $("#shipPhone").value.trim(),
      address: $("#shipAddress").value.trim(),
      note: $("#shipNote").value.trim()
    };
    if (!shipInfo.name || !shipInfo.phone || !shipInfo.address){
      return toast("Điền đủ Tên / SĐT / Địa chỉ");
    }
    const shipHex = ethers.utils.hexlify(ethers.utils.toUtf8Bytes(JSON.stringify(shipInfo)));

    // Tính VIN cần trả (qty = 1; tổng = priceCents)
    const p = buying.p;
    const priceC = p[5].toNumber();     // tổng đã gồm phí/thuế
    const vinTotal = usdCentsToVinWei_BN(priceC, vinPerUSD_BN);

    // Approve VIN đủ cho contract
    const allowance = await vin.allowance(user, MUABAN);
    if (allowance.lt(vinTotal)){
      const tx1 = await vin.approve(MUABAN, vinTotal);
      toast("Đang ký approve VIN…"); await tx1.wait();
    }

    // placeOrder(productId, quantity=1, vinPerUSD, shippingInfoCiphertext)
    const tx2 = await muaban.placeOrder(buying.id, 1, vinPerUSD_BN, shipHex);
    toast("Đang gửi đơn hàng…"); await tx2.wait();
    toast("Đặt hàng thành công");
    hide($("#buyModal"));
    await updateAccountUI();
  }catch(e){
    console.error(e); toast("Đặt hàng thất bại");
  }
}

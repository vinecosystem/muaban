/* ======================================================================
   muaban — app.js (ethers v5)
   - Connect wallet (+ switch/add Viction 88)
   - Show VIN/VIC balance, VIN price ≈ USD (from Binance VICUSDT * 100)
   - Registration: approve VIN(0.001) → payRegistration()   [✅ đúng chuẩn ERC-20]
   - Create product: gửi giá bằng USD cents, bps, …          [✅ đúng đơn vị]
   - Buy: tính vinPerUSD (VIN wei / USD), tính tổng VIN (ceil) → approve → placeOrder
   ====================================================================== */

/* -------------------- 0) CONFIG -------------------- */
const RPC_URL = "https://rpc.viction.xyz";
const CHAIN_ID_DEC = 88;
const CHAIN_ID_HEX = "0x58"; // 88
const EXPLORER = "https://vicscan.xyz";

const MUABAN = "0xe01e2213A899E9B3b1921673D2d13a227a8df638"; // Muaban contract
const VIN = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4";     // VIN token

// ABIs (tối giản đủ dùng)
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
let vinDecimals = 18;
let vinPriceUsd = null;      // number
let vinPerUSD_BI = null;     // BigInt (VIN wei / 1 USD)
let lastProducts = [];       // cached list

/* -------------------- 2) UTIL -------------------- */
const $ = (q) => document.querySelector(q);
const $$ = (q) => Array.from(document.querySelectorAll(q));
const short = (a) => a ? `${a.slice(0,6)}…${a.slice(-4)}` : "";
const toWei = (n) => ethers.utils.parseUnits(String(n), 18);
const fromWei = (x) => Number(ethers.utils.formatUnits(x, 18));
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");
function toast(msg, ms=2800){ const t=$("#toast"); t.textContent=msg; t.classList.remove("hidden"); setTimeout(()=>t.classList.add("hidden"), ms); }

/** Parse decimal string to scaled integer using BigInt */
function toScaledInt(str, scale=8){
  if (typeof str !== "string") str = String(str);
  const [i, f=""] = str.split(".");
  const frac = (f + "0".repeat(scale)).slice(0, scale);
  return BigInt(i) * (10n**BigInt(scale)) + BigInt(frac);
}

/** Compute vinPerUSD (VIN wei per 1 USD) from VICUSDT:
 *  vinUSD = vicUSD * 100  (1 VIN = 100 VIC)
 *  vinPerUSD = 1e18 / vinUSD
 *  to avoid FP, use scale = 8
 */
function computeVinPerUSD(vicUsdStr){
  const SCALE = 8n;
  const vicScaled = toScaledInt(vicUsdStr, Number(SCALE)); // USD * 1e8 / VIC
  const vinUsdScaled = vicScaled * 100n;                    // USD * 1e8 / VIN
  // vinPerUSD = 1e18 / (vinUsdScaled / 1e8) = 1e26 / vinUsdScaled
  const numerator = 10n**26n;
  return numerator / vinUsdScaled; // BigInt (wei/USD), floor — sẽ được ceil ở bước usdCents→VIN
}

/** Ceil(usdCents * vinPerUSD / 100) (y hệt trong contract) */
function usdCentsToVinWei(usdCents, vinPerUSD_BI){
  const num = BigInt(usdCents) * vinPerUSD_BI;
  return (num + 99n) / 100n;
}

/* -------------------- 3) INIT -------------------- */
window.addEventListener("DOMContentLoaded", async () => {
  $("#btnConnect").addEventListener("click", connectWallet);
  $("#btnDisconnect").addEventListener("click", disconnectWallet);
  $("#btnReload").addEventListener("click", loadProducts);
  $("#createCancel").addEventListener("click", () => hide($("#createModal")));
  $("#createClose").addEventListener("click", () => hide($("#createModal")));
  $("#buyCancel").addEventListener("click", closeBuy);
  $("#buyClose").addEventListener("click", closeBuy);
  $("#btnCreateProduct").addEventListener("click", () => show($("#createModal")));
  $("#createSubmit").addEventListener("click", submitCreate);
  $("#btnRegister").addEventListener("click", doRegister);
  $("#buySubmit").addEventListener("click", submitBuy);
  $("#productList").addEventListener("click", onProductClick);

  // Fetch giá VICUSDT → hiển thị VIN≈USD & chuẩn bị vinPerUSD
  await refreshVinPrice();
  await loadProducts(); // load public list khi chưa connect
});

/* -------------------- 4) PRICE -------------------- */
async function refreshVinPrice(){
  try{
    $("#vinPriceUsd").textContent = "Loading…";
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT");
    const { price } = await res.json(); // string
    const vinUsd = Number(price) * 100;
    vinPriceUsd = vinUsd;
    vinPerUSD_BI = computeVinPerUSD(String(price));
    $("#vinPriceUsd").textContent = vinUsd.toFixed(4);
  }catch(e){
    console.error("Price fetch failed", e);
    $("#vinPriceUsd").textContent = "—";
  }
}

/* -------------------- 5) WALLET -------------------- */
async function connectWallet(){
  if (!window.ethereum){ toast("Vui lòng cài MetaMask / ví EVM"); return; }

  // Switch / add chain
  try{
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
  }catch(err){
    if (err.code === 4902){ // not added
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

  // React khi chain/account đổi
  window.ethereum.on?.("accountsChanged", async () => { await connectWallet(); });
  window.ethereum.on?.("chainChanged", async () => { window.location.reload(); });
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
  $("#vicBalance").textContent = ethers.utils.formatEther(vicBal);
  $("#vinBalance").textContent = ethers.utils.formatUnits(vinBal, 18);

  hide($("#btnConnect")); show($("#walletInfo"));
}

/* -------------------- 6) REGISTRATION -------------------- */
/** payRegistration: contract sẽ transferFrom 0.001 VIN từ ví user → owner.
 *  => Cần approve VIN cho contract Muaban trước. (Sửa lỗi bản cũ gửi value) */
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
  }catch(e){
    console.error(e); toast("Đăng ký thất bại");
  }
}

async function checkRegistration(){
  if (!provider || !user){
    hide($("#btnRegister")); hide($("#btnCreateProduct"));
    return;
  }
  const reg = await (new ethers.Contract(MUABAN, ABI_MUABAN, provider)).isRegistered(user);
  if (reg){ hide($("#btnRegister")); show($("#btnCreateProduct")); }
  else { show($("#btnRegister")); hide($("#btnCreateProduct")); }
}

/* -------------------- 7) CREATE PRODUCT -------------------- */
// Lưu ý: contract yêu cầu GIÁ bằng USD cents; thuế bps; … (đúng theo Muaban.sol)
async function submitCreate(){
  try{
    if (!signer) return toast("Hãy kết nối ví");

    const name = $("#pName").value.trim();
    const imageCID = $("#pImageCID").value.trim();
    const descCID = $("#pDescCID").value.trim();
    const priceUsd = parseFloat($("#pPriceUsd").value);          // USD
    const shippingUsd = parseFloat($("#pShippingUsd").value);    // USD
    const taxPercent = parseFloat($("#pTaxPercent").value);      // %
    const deliveryDays = parseInt($("#pDeliveryDays").value, 10);
    const stock = parseInt($("#pStock").value, 10);
    const revenueWallet = $("#pRevenueWallet").value.trim();
    const taxWallet = $("#pTaxWallet").value.trim();
    const shippingWallet = $("#pShippingWallet").value.trim();
    const sellerPubKeyHex = $("#pSellerPubKey").value.trim();
    const active = $("#pActive").value === "true";

    if (!name || !imageCID || !descCID) return toast("Hãy điền đủ tên/ảnh/mô tả");
    const priceCents = Math.round(priceUsd * 100);
    const shipCents = Math.round(shippingUsd * 100);
    const taxBps = Math.round(taxPercent * 100);

    const tx = await muaban.createProduct(
      name,
      descCID,
      imageCID,
      priceCents,
      shipCents,
      taxBps,
      deliveryDays,
      revenueWallet,
      taxWallet,
      shippingWallet || "0x0000000000000000000000000000000000000000",
      sellerPubKeyHex,
      stock,
      active
    );
    toast("Đang đăng sản phẩm…");
    await tx.wait();
    toast("Đăng sản phẩm thành công");
    hide($("#createModal"));
    await loadProducts(true);
  }catch(e){
    console.error(e); toast("Tạo sản phẩm thất bại");
  }
}

/* -------------------- 8) LIST / SEARCH PRODUCTS -------------------- */
async function loadProducts(force=false){
  try{
    const _prov = provider ?? new ethers.providers.JsonRpcProvider(RPC_URL);
    const _muaban = new ethers.Contract(MUABAN, ABI_MUABAN, _prov);

    // Lấy danh sách productId qua event (public, không cần ví)
    const logs = await _muaban.queryFilter(_muaban.filters.ProductCreated(), 0, "latest");
    const ids = [...new Set(logs.map(l => l.args.productId.toNumber()).reverse())];

    const q = ($("#searchInput").value || "").toLowerCase();
    const cards = [];
    for (const id of ids){
      const p = await _muaban.getProduct(id);
      // p tuple theo ABI: [productId,seller,name,descriptionCID,imageCID,priceUsdCents,shippingUsdCents,taxRateBps,deliveryDaysMax,revenueWallet,taxWallet,shippingWallet,sellerEncryptPubKey,active,createdAt,updatedAt,stock]
      const active = p[13];
      if (!active || p[16].toString() === "0") continue; // phải còn hàng và active
      const name = p[2];
      if (q && !name.toLowerCase().includes(q)) continue;
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
    const name = p[2], descCID = p[3], imageCID = p[4];
    const priceC = p[5].toNumber(), shipC = p[6].toNumber(), taxBps = p[7];
    const days = p[8]; const seller = p[1];

    el.querySelector(".p-img").src = `https://ipfs.io/ipfs/${imageCID}`;
    el.querySelector(".p-img").alt = name;
    el.querySelector(".p-title").textContent = name;
    el.querySelector(".p-desc").textContent = `ipfs://${descCID}`;
    el.querySelector(".p-price").textContent = `Giá: ${(priceC/100).toFixed(2)} USD`;
    el.querySelector(".p-tax").textContent = `Thuế: ${(taxBps/100).toFixed(2)}%`;
    el.querySelector(".p-delivery").textContent = `Giao tối đa: ${days} ngày`;
    const a = el.querySelector(".p-seller-addr");
    a.textContent = short(seller);
    a.href = `${EXPLORER}/address/${seller}`;

    const buyBtn = el.querySelector(".buy-btn");
    buyBtn.dataset.productId = String(id);
    show(buyBtn);

    wrap.appendChild(el);
  }
}

/* -------------------- 9) BUY FLOW -------------------- */
let buying = null; // { id, p }
function onProductClick(ev){
  const btn = ev.target.closest(".buy-btn");
  if (!btn) return;
  const id = parseInt(btn.dataset.productId, 10);
  startBuy(id);
}

async function startBuy(productId){
  try{
    const _prov = provider ?? new ethers.providers.JsonRpcProvider(RPC_URL);
    const _muaban = new ethers.Contract(MUABAN, ABI_MUABAN, _prov);
    const p = await _muaban.getProduct(productId);
    buying = { id: productId, p };

    $("#buyName").value = p[2];
    $("#buyPriceUsd").value = (p[5].toNumber()/100).toFixed(2);
    $("#buyShipUsd").value = (p[6].toNumber()/100).toFixed(2);
    $("#buyTaxRate").value = (p[7]/100).toFixed(2);
    $("#buyQty").value = 1;

    await updateBuyTotals();
    show($("#buyModal"));
  }catch(e){
    console.error(e); toast("Không tải được sản phẩm");
  }
}

function closeBuy(){ hide($("#buyModal")); buying = null; }

async function updateBuyTotals(){
  if (!buying) return;
  const qty = Math.max(1, parseInt($("#buyQty").value, 10) || 1);
  const priceC = buying.p[5].toNumber() * qty;
  const shipC = buying.p[6].toNumber();
  const taxBps = buying.p[7];

  // tax on price only, ceil bps: (price * bps + 9999)/10000
  const taxC = Math.floor((priceC * taxBps + 9999) / 10000);
  const totalUSD = (priceC + shipC + taxC) / 100;

  $("#buyTotalUsd").value = totalUSD.toFixed(2);

  if (!vinPerUSD_BI) await refreshVinPrice();
  const vinRev = usdCentsToVinWei(priceC, vinPerUSD_BI);
  const vinShip = usdCentsToVinWei(shipC, vinPerUSD_BI);
  const vinTax = usdCentsToVinWei(taxC, vinPerUSD_BI);
  const vinTotal = vinRev + vinShip + vinTax;
  $("#buyTotalVin").value = (Number(vinTotal) / 1e18).toFixed(6);
}

$("#buyQty").addEventListener("input", updateBuyTotals);

/** Mua hàng: approve VIN = vinTotal → placeOrder(productId, qty, vinPerUSD, ciphertext) */
async function submitBuy(){
  try{
    if (!signer || !user) return toast("Hãy kết nối ví");

    const qty = Math.max(1, parseInt($("#buyQty").value, 10) || 1);
    if (!vinPerUSD_BI) await refreshVinPrice();

    // Re-calc totals (y hệt modal)
    const p = buying.p;
    const priceC = p[5].toNumber() * qty;
    const shipC = p[6].toNumber();
    const taxBps = p[7];
    const taxC = Math.floor((priceC * taxBps + 9999) / 10000);

    const vinRev = usdCentsToVinWei(priceC, vinPerUSD_BI);
    const vinShip = usdCentsToVinWei(shipC, vinPerUSD_BI);
    const vinTax = usdCentsToVinWei(taxC, vinPerUSD_BI);
    const vinTotalBI = vinRev + vinShip + vinTax;

    // Approve VIN cho contract Muaban
    const allowance = await vin.allowance(user, MUABAN);
    if (allowance.lt(ethers.BigNumber.from(vinTotalBI.toString()))){
      const tx1 = await vin.approve(MUABAN, vinTotalBI.toString());
      toast("Đang ký approve VIN…"); await tx1.wait();
    }

    // shipping info → bytes (UTF-8 JSON → hex)
    const shipInfo = {
      name: $("#shipName").value.trim(),
      phone: $("#shipPhone").value.trim(),
      address: $("#shipAddress").value.trim(),
      note: $("#shipNote").value.trim()
    };
    if (!shipInfo.name || !shipInfo.phone || !shipInfo.address) return toast("Điền đủ thông tin giao hàng");
    const shipHex = ethers.utils.hexlify(ethers.utils.toUtf8Bytes(JSON.stringify(shipInfo)));

    // Gọi placeOrder
    const tx2 = await muaban.placeOrder(
      buying.id,
      qty,
      vinPerUSD_BI.toString(),   // VIN wei per 1 USD
      shipHex
    );
    toast("Đang gửi đơn hàng…"); await tx2.wait();
    toast("Đặt hàng thành công");
    closeBuy();
    await updateAccountUI();
  }catch(e){
    console.error(e); toast("Đặt hàng thất bại");
  }
}

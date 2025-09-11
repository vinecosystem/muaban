/* ======================================================================
   muaban — app.js (ethers v5) — with Update Product + Search + E2E shipping info
   ====================================================================== */

/* -------------------- 0) CONFIG -------------------- */
const RPC_URL = "https://rpc.viction.xyz";
const CHAIN_ID_HEX = "0x58"; // 88
const EXPLORER = "https://vicscan.xyz";
const MUABAN = "0xe01e2213A899E9B3b1921673D2d13a227a8df638";
const VIN    = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4";

// ABIs (tối giản + hàm update)
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
  "function placeOrder(uint256,uint256,uint256,bytes) returns (uint256)",

  "event ProductCreated(uint256 indexed productId,address indexed seller,string,string,string,uint256,uint256,uint16,uint32,address,address,address,bytes,uint256)",
  "event ProductUpdated(uint256 indexed productId,uint256,uint256,uint16,uint32,address,address,address,uint256,bytes)",
  "event ProductStatusChanged(uint256 indexed productId,bool)",
  "event OrderPlaced(uint256 indexed orderId,uint256 indexed productId,address indexed buyer,address seller,uint256 quantity,uint256 vinAmountTotal,uint256 placedAt,uint256 deadline,bytes shippingInfoCiphertext)"
];

/* -------------------- 1) STATE -------------------- */
let provider, signer, user;
let muaban, vin;
let vinPerUSD_BN = null;
let allProducts = [];       // cache để tìm kiếm
let currentUpdate = null;   // {id, p}

/* -------------------- 2) HELPERS -------------------- */
const $ = (q) => document.querySelector(q);
function show(el){ el.classList.remove("hidden"); }
function hide(el){ el.classList.add("hidden"); }
function short(addr){ return addr ? addr.slice(0,6)+"…"+addr.slice(-4) : ""; }
function toast(msg, ms=2800){ const t=$("#toast"); t.textContent=msg; t.classList.remove("hidden"); setTimeout(()=>t.classList.add("hidden"), ms); }

function toDisplayUrl(input){
  if (!input) return "";
  const s = String(input).trim();
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("ipfs://")) return s.replace("ipfs://","https://ipfs.io/ipfs/");
  return "https://ipfs.io/ipfs/" + s;
}
function isVideoUrl(u){ const x=u.toLowerCase(); return x.endsWith(".mp4")||x.endsWith(".webm")||x.endsWith(".ogg"); }

const fmt2 = (x) => Number(x).toFixed(2);
const fmt4 = (x) => Number(x).toFixed(4);

async function loadScript(src){
  if (document.querySelector(`script[src="${src}"]`)) return;
  await new Promise((res,rej)=>{ const s=document.createElement("script"); s.src=src; s.async=true; s.onload=res; s.onerror=rej; document.head.appendChild(s); });
}

/* -------------------- 3) STARTUP -------------------- */
window.addEventListener("DOMContentLoaded", () => {
  $("#btnConnect").addEventListener("click", connectWallet);
  $("#btnDisconnect").addEventListener("click", disconnectWallet);
  $("#btnRegister").addEventListener("click", doRegister);

  // Create
  $("#btnCreateProduct").addEventListener("click", ()=>show($("#createModal")));
  $("#createClose").addEventListener("click", ()=>hide($("#createModal")));
  $("#createCancel").addEventListener("click", ()=>hide($("#createModal")));
  $("#createSubmit").addEventListener("click", submitCreate);

  // Buy
  $("#buyClose").addEventListener("click", ()=>hide($("#buyModal")));
  $("#buyCancel").addEventListener("click", ()=>hide($("#buyModal")));
  $("#buySubmit").addEventListener("click", submitBuy);

  // Update
  $("#updateClose").addEventListener("click", ()=>hide($("#updateModal")));
  $("#updateCancel").addEventListener("click", ()=>hide($("#updateModal")));
  $("#updateSubmit").addEventListener("click", submitUpdate);

  // Search
  $("#searchBtn").addEventListener("click", () => doSearch($("#searchInput").value));
  $("#clearSearchBtn").addEventListener("click", () => { $("#searchInput").value=""; renderProducts(allProducts); });
  $("#searchInput").addEventListener("keydown", (e)=>{ if(e.key==="Enter"){ doSearch(e.target.value); }});

  // Product list
  $("#productList").addEventListener("click", onProductClick);

  refreshVinPrice().then(loadProducts);
});

/* -------------------- 4) PRICE utils -------------------- */
function computeVinPerUSD_BN(vicUsdStr){
  const SCALE = 8;
  const parts = String(vicUsdStr).split(".");
  const ip = parts[0] || "0";
  let fp = (parts[1] || "").slice(0, SCALE);
  while (fp.length < SCALE) fp += "0";
  const vicUsdInt = (parseInt(ip,10) * Math.pow(10, SCALE)) + parseInt(fp||"0",10);
  const vinUsdInt = vicUsdInt * 100;
  const numerator = ethers.BigNumber.from("100000000000000000000000000"); // 1e26
  return numerator.div(String(vinUsdInt));
}
function usdCentsToVinWei_BN(usdCents, vinPerUSD){ return vinPerUSD.mul(usdCents).add(99).div(100); }

async function refreshVinPrice(){
  try{
    $("#vinPriceUsd").textContent = "Loading…";
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT", {cache:"no-store"});
    const { price } = await res.json();
    $("#vinPriceUsd").textContent = fmt2(Number(price)*100);
    vinPerUSD_BN = computeVinPerUSD_BN(price);
  }catch(e){ console.error(e); $("#vinPriceUsd").textContent = "—"; }
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
  subscribeOrderPlaced(); // lắng nghe đơn mới cho seller

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
async function checkRegistration(){
  if (!provider || !user){ hide($("#btnRegister")); hide($("#btnCreateProduct")); return; }
  const reg = await (new ethers.Contract(MUABAN, ABI_MUABAN, provider)).isRegistered(user);
  if (reg){ hide($("#btnRegister")); show($("#btnCreateProduct")); }
  else { show($("#btnRegister")); hide($("#btnCreateProduct")); }
}

/* -------------------- 6) CRYPTO (MetaMask + tweetnacl) -------------------- */
async function ensureNacl(){ await loadScript("https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl.min.js"); await loadScript("https://cdn.jsdelivr.net/npm/tweetnacl-util@0.15.1/nacl-util.min.js"); }
async function getWalletEncryptionPublicKey(address){ return window.ethereum.request({ method:"eth_getEncryptionPublicKey", params:[address] }); }
async function encryptForSeller_base64Pub(sellerPubBase64, jsonStr){
  await ensureNacl();
  const pubKey = nacl.util.decodeBase64(sellerPubBase64);
  const ephem = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);
  const msg   = nacl.util.decodeUTF8(jsonStr);
  const cipher= nacl.box(msg, nonce, pubKey, ephem.secretKey);
  const payload = {
    version: "x25519-xsalsa20-poly1305",
    nonce: nacl.util.encodeBase64(nonce),
    ephemPublicKey: nacl.util.encodeBase64(ephem.publicKey),
    ciphertext: nacl.util.encodeBase64(cipher)
  };
  return ethers.utils.hexlify(ethers.utils.toUtf8Bytes(JSON.stringify(payload)));
}

/* -------------------- 7) CREATE PRODUCT -------------------- */
async function submitCreate(){
  try{
    if (!signer) return toast("Hãy kết nối ví");

    const name = $("#pName").value.trim();            // up to 500 chars
    const media = $("#pImageCID").value.trim();
    const unit = $("#pUnit").value.trim();            // lưu vào descriptionCID
    const priceUsd = parseFloat($("#pPriceUsd").value);
    const revenueWallet = $("#pRevenueWallet").value.trim();
    const deliveryDays = parseInt($("#pDeliveryDays").value, 10);

    if (!name || !media || !unit || !priceUsd || !revenueWallet || !deliveryDays){
      return toast("Điền đầy đủ 6 mục");
    }

    // public key của seller (ngầm)
    let sellerPubB64 = "";
    try{ sellerPubB64 = await getWalletEncryptionPublicKey(user); }catch(_e){ sellerPubB64 = ""; }

    const priceCents = Math.round(priceUsd*100);
    const shipCents = 0, taxBps = 0;
    const taxWallet = revenueWallet;
    const shippingWallet = "0x0000000000000000000000000000000000000000";
    const stock = 999999, active = true;

    const sellerPubBytes = sellerPubB64 ? ethers.utils.toUtf8Bytes(sellerPubB64) : new Uint8Array([]);

    const tx = await muaban.createProduct(
      name, unit, media,
      priceCents, shipCents, taxBps, deliveryDays,
      revenueWallet, taxWallet, shippingWallet,
      sellerPubBytes, stock, active
    );
    toast("Đang đăng sản phẩm…"); await tx.wait();
    toast("Đăng sản phẩm thành công");
    hide($("#createModal"));
    await loadProducts(true);
  }catch(e){ console.error(e); toast("Tạo sản phẩm thất bại"); }
}

/

/* ======================================================================
   muaban — app.js (ethers v5, no BigInt, no SRI)
   - Connect wallet (+ switch/add Viction 88)
   - Show VIN/VIC balance, VIN price ≈ USD (from Binance VICUSDT * 100)
   - Registration: approve VIN(0.001) → payRegistration()   [ERC-20 transferFrom]
   - Create product: USD cents, bps, stock, wallets
   - Buy: vinPerUSD (BN) + ceil(usdCents * vinPerUSD / 100) → approve → placeOrder
   ====================================================================== */

/* -------------------- 0) CONFIG -------------------- */
const RPC_URL = "https://rpc.viction.xyz";
const CHAIN_ID_HEX = "0x58";               // 88
const EXPLORER = "https://vicscan.xyz";
const MUABAN = "0xe01e2213A899E9B3b1921673D2d13a227a8df638"; // Muaban
const VIN    = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4"; // VIN token

// Minimal ABIs
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
  "event ProductCreated(uint256 indexed productId,address indexed seller,string,string,string,uint256,uint256,uint16,uint32,address,address,address,bytes,uint256)"
];

/* -------------------- 1) STATE -------------------- */
let provider, signer, user;
let muaban, vin;
let vinPerUSD_BN = null;   // ethers.BigNumber (VIN wei / USD)

/* -------------------- 2) DOM HELPERS -------------------- */
var $ = function(q){ return document.querySelector(q); };
function show(el){ el.classList.remove("hidden"); }
function hide(el){ el.classList.add("hidden"); }
function short(addr){ return addr ? addr.slice(0,6)+"…"+addr.slice(-4) : ""; }
function toast(msg, ms){ if(ms===undefined) ms=2800; var t=$("#toast"); t.textContent=msg; t.classList.remove("hidden"); setTimeout(function(){t.classList.add("hidden");}, ms); }

/* -------------------- 3) STARTUP -------------------- */
window.addEventListener("DOMContentLoaded", function(){
  $("#btnConnect").addEventListener("click", connectWallet);
  $("#btnDisconnect").addEventListener("click", disconnectWallet);
  $("#btnReload").addEventListener("click", loadProducts);
  $("#createCancel").addEventListener("click", function(){ hide($("#createModal")); });
  $("#createClose").addEventListener("click", function(){ hide($("#createModal")); });
  $("#buyCancel").addEventListener("click", closeBuy);
  $("#buyClose").addEventListener("click", closeBuy);
  $("#btnCreateProduct").addEventListener("click", function(){ show($("#createModal")); });
  $("#createSubmit").addEventListener("click", submitCreate);
  $("#btnRegister").addEventListener("click", doRegister);
  $("#buySubmit").addEventListener("click", submitBuy);
  $("#productList").addEventListener("click", onProductClick);
  $("#buyQty").addEventListener("input", updateBuyTotals);

  refreshVinPrice().then(loadProducts);
});

/* -------------------- 4) PRICE (no BigInt) -------------------- */
// Convert "0.4258" VIC/USD  → vinPerUSD = floor(1e18 / (vicUSD * 100))
// Avoid float: use scaled integers (1e8)
function computeVinPerUSD_BN(vicUsdStr){
  var SCALE = 8;
  var parts = String(vicUsdStr).split('.');
  var ip = parts[0] || "0";
  var fp = (parts[1] || "").slice(0, SCALE);
  while (fp.length < SCALE) fp += "0";
  var vicUsdInt = (parseInt(ip,10) * Math.pow(10, SCALE)) + parseInt(fp||"0",10); // USD * 1e8 / VIC
  var vinUsdInt = vicUsdInt * 100; // USD * 1e8 / VIN  (1 VIN = 100 VIC)
  // vinPerUSD = 1e26 / vinUsdInt   (because 1e18 / (vinUsdInt/1e8))
  var numerator = ethers.BigNumber.from("100000000000000000000000000"); // 1e26
  return numerator.div(String(vinUsdInt)); // BigNumber
}

function usdCentsToVinWei_BN(usdCents, vinPerUSD){
  // ceil(usdCents * vinPerUSD / 100)
  var num = vinPerUSD.mul(usdCents);
  return num.add(ethers.BigNumber.from(99)).div(100);
}

async function refreshVinPrice(){
  try{
    $("#vinPriceUsd").textContent = "Loading…";
    var res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT");
    var data = await res.json();
    var price = data.price; // string
    var vinUsd = Number(price) * 100; // for display only
    $("#vinPriceUsd").textContent = vinUsd.toFixed(4);
    vinPerUSD_BN = computeVinPerUSD_BN(price);
  }catch(e){
    console.error(e);
    $("#vinPriceUsd").textContent = "—";
  }
}

/* -------------------- 5) WALLET -------------------- */
async function connectWallet(){
  if (!window.ethereum){ toast("Vui lòng cài MetaMask / ví EVM"); return; }

  // Switch / add chain Viction
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

  // phản ứng khi user đổi account/chain
  try{
    if (window.ethereum && window.ethereum.on){
      window.ethereum.on("accountsChanged", function(){ connectWallet(); });
      window.ethereum.on("chainChanged", function(){ window.location.reload(); });
    }
  }catch(e){}
}

function disconnectWallet(){
  user = null; signer = null; provider = null;
  hide($("#walletInfo")); show($("#btnConnect"));
}

async function updateAccountUI(){
  if (!signer || !user) return;
  var vicBal = await signer.getBalance();
  var vinBal = await vin.balanceOf(user);

  $("#accountShort").textContent = short(user);
  $("#accountShort").href = EXPLORER + "/address/" + user;
  $("#vicBalance").textContent = ethers.utils.formatEther(vicBal);
  $("#vinBalance").textContent = ethers.utils.formatUnits(vinBal, 18);

  hide($("#btnConnect")); show($("#walletInfo"));
}

/* -------------------- 6) REGISTRATION -------------------- */
async function doRegister(){
  try{
    if (!signer) return toast("Hãy kết nối ví");
    var platformFee = await (new ethers.Contract(MUABAN, ABI_MUABAN, provider)).PLATFORM_FEE();
    var allowance = await vin.allowance(user, MUABAN);
    if (allowance.lt(platformFee)){
      var tx1 = await vin.approve(MUABAN, platformFee);
      toast("Đang ký approve 0.001 VIN…"); await tx1.wait();
    }
    var tx2 = await muaban.payRegistration();
    toast("Đang gửi đăng ký…"); await tx2.wait();
    toast("Đăng ký thành công");
    await checkRegistration();
    await updateAccountUI();
  }catch(e){ console.error(e); toast("Đăng ký thất bại"); }
}

async function checkRegistration(){
  if (!provider || !user){ hide($("#btnRegister")); hide($("#btnCreateProduct")); return; }
  var reg = await (new ethers.Contract(MUABAN, ABI_MUABAN, provider)).isRegistered(user);
  if (reg){ hide($("#btnRegister")); show($("#btnCreateProduct")); }
  else { show($("#btnRegister")); hide($("#btnCreateProduct")); }
}

/* -------------------- 7) CREATE PRODUCT -------------------- */
async function submitCreate(){
  try{
    if (!signer) return toast("Hãy kết nối ví");

    var name = $("#pName").value.trim();
    var imageCID = $("#pImageCID").value.trim();
    var descCID = $("#pDescCID").value.trim();
    var priceUsd = parseFloat($("#pPriceUsd").value);
    var shippingUsd = parseFloat($("#pShippingUsd").value);
    var taxPercent = parseFloat($("#pTaxPercent").value);
    var deliveryDays = parseInt($("#pDeliveryDays").value, 10);
    var stock = parseInt($("#pStock").value, 10);
    var revenueWallet = $("#pRevenueWallet").value.trim();
    var taxWallet = $("#pTaxWallet").value.trim();
    var shippingWallet = $("#pShippingWallet").value.trim();
    var sellerPubKeyHex = $("#pSellerPubKey").value.trim();
    var active = $("#pActive").value === "true";

    if (!name || !imageCID || !descCID) return toast("Hãy điền đủ tên/ảnh/mô tả");
    var priceCents = Math.round(priceUsd * 100);
    var shipCents = Math.round(shippingUsd * 100);
    var taxBps = Math.round(taxPercent * 100);

    var tx = await muaban.createProduct(
      name, descCID, imageCID,
      priceCents, shipCents, taxBps, deliveryDays,
      revenueWallet, taxWallet,
      shippingWallet || "0x0000000000000000000000000000000000000000",
      sellerPubKeyHex, stock, active
    );
    toast("Đang đăng sản phẩm…"); await tx.wait();
    toast("Đăng sản phẩm thành công");
    hide($("#createModal")); await loadProducts(true);
  }catch(e){ console.error(e); toast("Tạo sản phẩm thất bại"); }
}

/* -------------------- 8) LIST PRODUCTS -------------------- */
async function loadProducts(){
  try{
    var _prov = provider ? provider : new ethers.providers.JsonRpcProvider(RPC_URL);
    var _muaban = new ethers.Contract(MUABAN, ABI_MUABAN, _prov);

    // Duyệt event để lấy productId
    var logs = await _muaban.queryFilter(_muaban.filters.ProductCreated(), 0, "latest");
    var ids = [];
    for (var i=logs.length-1; i>=0; i--){
      var id = logs[i].args.productId.toNumber();
      if (ids.indexOf(id) === -1) ids.push(id);
    }

    var q = ($("#searchInput").value || "").toLowerCase();
    var cards = [];
    for (var k=0; k<ids.length; k++){
      var id2 = ids[k];
      var p = await _muaban.getProduct(id2);
      var active = p[13];
      var stock = p[16];
      if (!active || String(stock) === "0") continue;
      var name2 = p[2];
      if (q && name2 && name2.toLowerCase().indexOf(q) === -1) continue;
      cards.push({ id: id2, p: p });
    }
    renderProducts(cards);
  }catch(e){
    console.error(e);
    $("#productList").innerHTML = "";
    $("#emptyProducts").textContent = "Không tải được danh sách sản phẩm.";
  }
}

function renderProducts(list){
  var wrap = $("#productList");
  wrap.innerHTML = "";
  if (!list.length){ $("#emptyProducts").textContent = "Chưa có sản phẩm."; return; }
  $("#emptyProducts").textContent = "";
  var tpl = document.getElementById("tplProductCard").content;
  for (var i=0; i<list.length; i++){
    var id = list[i].id;
    var p = list[i].p;
    var name = p[2], descCID = p[3], imageCID = p[4];
    var priceC = p[5].toNumber(), shipC = p[6].toNumber(), taxBps = p[7];
    var days = p[8]; var seller = p[1];

    var el = document.importNode(tpl, true);
    el.querySelector(".p-img").src = "https://ipfs.io/ipfs/" + imageCID;
    el.querySelector(".p-img").alt = name;
    el.querySelector(".p-title").textContent = name;
    el.querySelector(".p-desc").textContent = "ipfs://" + descCID;
    el.querySelector(".p-price").textContent = "Giá: " + (priceC/100).toFixed(2) + " USD";
    el.querySelector(".p-tax").textContent = "Thuế: " + (taxBps/100).toFixed(2) + "%";
    el.querySelector(".p-delivery").textContent = "Giao tối đa: " + days + " ngày";
    var a = el.querySelector(".p-seller-addr");
    a.textContent = short(seller);
    a.href = EXPLORER + "/address/" + seller;

    var buyBtn = el.querySelector(".buy-btn");
    buyBtn.setAttribute("data-product-id", String(id));
    el.querySelector(".buy-btn").classList.remove("hidden");
    wrap.appendChild(el);
  }
}

/* -------------------- 9) BUY FLOW -------------------- */
var buying = null;
function onProductClick(ev){
  var btn = ev.target.closest ? ev.target.closest(".buy-btn") : null;
  if (!btn) return;
  var id = parseInt(btn.getAttribute("data-product-id"), 10);
  startBuy(id);
}

async function startBuy(productId){
  try{
    var _prov = provider ? provider : new ethers.providers.JsonRpcProvider(RPC_URL);
    var _muaban = new ethers.Contract(MUABAN, ABI_MUABAN, _prov);
    var p = await _muaban.getProduct(productId);
    buying = { id: productId, p: p };

    $("#buyName").value = p[2];
    $("#buyPriceUsd").value = (p[5].toNumber()/100).toFixed(2);
    $("#buyShipUsd").value = (p[6].toNumber()/100).toFixed(2);
    $("#buyTaxRate").value = (p[7]/100).toFixed(2);
    $("#buyQty").value = 1;

    await updateBuyTotals();
    show($("#buyModal"));
  }catch(e){ console.error(e); toast("Không tải được sản phẩm"); }
}

function closeBuy(){ hide($("#buyModal")); buying = null; }

async function updateBuyTotals(){
  if (!buying) return;
  var qty = Math.max(1, parseInt($("#buyQty").value||"1", 10));
  var priceC = buying.p[5].toNumber() * qty;
  var shipC = buying.p[6].toNumber();
  var taxBps = buying.p[7];
  var taxC = Math.floor((priceC * taxBps + 9999) / 10000); // bps ceil

  var totalUSD = (priceC + shipC + taxC) / 100;
  $("#buyTotalUsd").value = totalUSD.toFixed(2);

  if (!vinPerUSD_BN) await refreshVinPrice();
  var vinRev = usdCentsToVinWei_BN(priceC, vinPerUSD_BN);
  var vinShip = usdCentsToVinWei_BN(shipC, vinPerUSD_BN);
  var vinTax = usdCentsToVinWei_BN(taxC, vinPerUSD_BN);
  var vinTotal = vinRev.add(vinShip).add(vinTax);
  $("#buyTotalVin").value = ethers.utils.formatUnits(vinTotal, 18);
}

async function submitBuy(){
  try{
    if (!signer || !user) return toast("Hãy kết nối ví");

    var qty = Math.max(1, parseInt($("#buyQty").value||"1", 10));
    if (!vinPerUSD_BN) await refreshVinPrice();

    var p = buying.p;
    var priceC = p[5].toNumber() * qty;
    var shipC = p[6].toNumber();
    var taxBps = p[7];
    var taxC = Math.floor((priceC * taxBps + 9999) / 10000);

    var vinRev = usdCentsToVinWei_BN(priceC, vinPerUSD_BN);
    var vinShip = usdCentsToVinWei_BN(shipC, vinPerUSD_BN);
    var vinTax = usdCentsToVinWei_BN(taxC, vinPerUSD_BN);
    var vinTotal = vinRev.add(vinShip).add(vinTax);

    // Approve VIN đủ cho contract
    var allowance = await vin.allowance(user, MUABAN);
    if (allowance.lt(vinTotal)){
      var tx1 = await vin.approve(MUABAN, vinTotal);
      toast("Đang ký approve VIN…"); await tx1.wait();
    }

    // Shipping info JSON → bytes hex
    var shipInfo = {
      name: $("#shipName").value.trim(),
      phone: $("#shipPhone").value.trim(),
      address: $("#shipAddress").value.trim(),
      note: $("#shipNote").value.trim()
    };
    if (!shipInfo.name || !shipInfo.phone || !shipInfo.address) return toast("Điền đủ thông tin giao hàng");
    var shipHex = ethers.utils.hexlify(ethers.utils.toUtf8Bytes(JSON.stringify(shipInfo)));

    var tx2 = await muaban.placeOrder(buying.id, qty, vinPerUSD_BN, shipHex);
    toast("Đang gửi đơn hàng…"); await tx2.wait();
    toast("Đặt hàng thành công");
    closeBuy(); await updateAccountUI();
  }catch(e){ console.error(e); toast("Đặt hàng thất bại"); }
}

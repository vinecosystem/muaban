/* ============================================================
   app.js — muaban dApp (Viction)
   Contract: 0xe01e2213A899E9B3b1921673D2d13a227a8df638
   VIN:      0x941F63807401efCE8afe3C9d88d368bAA287Fac4
   ============================================================ */

const MUABAN_ADDRESS = "0xe01e2213A899E9B3b1921673D2d13a227a8df638";
const VIN_ADDRESS    = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4";
const EXPLORER       = "https://vicscan.xyz";

let provider, signer, account;
let muaban, vin;
let ABI_MUABAN, ABI_VIN;

// ---------------- UI elements ----------------
const ui = {
  connect:       document.getElementById("btnConnect"),
  disconnect:    document.getElementById("btnDisconnect"),
  walletInfo:    document.getElementById("walletInfo"),
  accountShort:  document.getElementById("accountShort"),
  vinBalance:    document.getElementById("vinBalance"),
  vicBalance:    document.getElementById("vicBalance"),
  statusLine:    document.getElementById("statusLine"),
  registerBtn:   document.getElementById("btnRegister"),
  tabs:          document.getElementById("appTabs"),
  buySection:    document.getElementById("buySection"),
  sellSection:   document.getElementById("sellSection"),
  ordersSection: document.getElementById("ordersSection"),
  productList:   document.getElementById("productList"),
  emptyProducts: document.getElementById("emptyProducts"),
  tplProduct:    document.getElementById("tplProductCard"),
  toast:         document.getElementById("toast"),
};

// ---------------- Helpers ----------------
const shortAddr = a => a ? a.slice(0,6)+"…"+a.slice(-4) : "";
const fmt = (x,d=4) => Number(x).toFixed(d);
function show(e){ e && e.classList.remove("hidden"); }
function hide(e){ e && e.classList.add("hidden"); }
function toast(msg,ms=2500){
  if(!ui.toast) return;
  ui.toast.textContent = msg;
  ui.toast.classList.remove("hidden");
  setTimeout(()=>ui.toast.classList.add("hidden"),ms);
}
function linkAddress(addr){ return `${EXPLORER}/address/${addr}`; }

// ---------------- Init ----------------
async function init(){
  [ABI_MUABAN, ABI_VIN] = await Promise.all([
    fetch("Muaban_ABI.json").then(r=>r.json()),
    fetch("VinToken_ABI.json").then(r=>r.json())
  ]);

  ui.connect.onclick = connectWallet;
  ui.disconnect.onclick = ()=>disconnectWallet(true);
  ui.registerBtn.onclick = registerPlatform;

  // tab switching
  document.getElementById("tabBuy").onclick   = ()=>switchTab("buy");
  document.getElementById("tabSell").onclick  = ()=>switchTab("sell");
  document.getElementById("tabOrders").onclick= ()=>switchTab("orders");

  if(window.ethereum){
    window.ethereum.on("accountsChanged", ()=>location.reload());
    window.ethereum.on("chainChanged", ()=>location.reload());
  }
}
document.addEventListener("DOMContentLoaded", init);

// ---------------- Wallet ----------------
async function connectWallet(){
  if(!window.ethereum){ toast("Hãy cài MetaMask/OKX wallet"); return; }
  provider = new ethers.providers.Web3Provider(window.ethereum);
  await provider.send("eth_requestAccounts",[]);
  signer   = provider.getSigner();
  account  = await signer.getAddress();
  muaban   = new ethers.Contract(MUABAN_ADDRESS, ABI_MUABAN, signer);
  vin      = new ethers.Contract(VIN_ADDRESS, ABI_VIN, signer);

  hide(ui.connect); show(ui.disconnect); show(ui.walletInfo); show(ui.tabs);
  ui.accountShort.textContent = shortAddr(account);
  ui.accountShort.href = linkAddress(account);

  await refreshBalances();
  await refreshRegistration();
  await loadMarket();
}

function disconnectWallet(show=true){
  provider=null; signer=null; account=null; muaban=null; vin=null;
  show(ui.connect); hide(ui.disconnect); hide(ui.walletInfo); hide(ui.tabs);
  if(show) toast("Đã ngắt ví");
}

// ---------------- Balances ----------------
async function refreshBalances(){
  try{
    const [vinBal, vicBal] = await Promise.all([
      vin.balanceOf(account),
      provider.getBalance(account)
    ]);
    ui.vinBalance.textContent = fmt(ethers.utils.formatUnits(vinBal,18))+" VIN";
    ui.vicBalance.textContent = fmt(ethers.utils.formatEther(vicBal))+" VIC";
  }catch(e){ console.error(e); }
}

// ---------------- Registration ----------------
async function refreshRegistration(){
  try{
    const ok = await muaban.isRegistered(account);
    if(ok){ ui.statusLine.textContent="Đã đăng ký"; ui.registerBtn.disabled=true; }
    else { ui.statusLine.textContent="Chưa đăng ký"; ui.registerBtn.disabled=false; }
  }catch(e){ console.error(e); }
}

async function registerPlatform(){
  try{
    const fee = await muaban.PLATFORM_FEE();
    await ensureAllowance(fee);
    const tx = await muaban.payRegistration();
    ui.statusLine.textContent="Đang ký…";
    await tx.wait(1);
    toast("Đăng ký thành công");
    await refreshBalances(); await refreshRegistration();
  }catch(e){ console.error(e); toast("Lỗi đăng ký"); }
}

async function ensureAllowance(amount){
  const cur = await vin.allowance(account,MUABAN_ADDRESS);
  if(cur.gte(amount)) return;
  const tx = await vin.approve(MUABAN_ADDRESS, ethers.constants.MaxUint256);
  await tx.wait(1);
}

// ---------------- Tabs ----------------
function switchTab(name){
  hide(ui.buySection); hide(ui.sellSection); hide(ui.ordersSection);
  document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));
  if(name==="buy"){ show(ui.buySection); document.getElementById("tabBuy").classList.add("active"); }
  if(name==="sell"){ show(ui.sellSection); document.getElementById("tabSell").classList.add("active"); }
  if(name==="orders"){ show(ui.ordersSection); document.getElementById("tabOrders").classList.add("active"); }
}

// ---------------- Market ----------------
async function loadMarket(){
  try{
    const ids = await muaban.getAllProductIds();
    ui.productList.innerHTML="";
    if(ids.length===0){ show(ui.emptyProducts); return; }
    hide(ui.emptyProducts);
    for(const id of ids){
      const p = await muaban.getProduct(id);
      const node = ui.tplProduct.content.firstElementChild.cloneNode(true);
      node.querySelector(".p-img").src = "https://ipfs.io/ipfs/"+p.imageCID;
      node.querySelector(".p-title").textContent = p.name;
      node.querySelector(".p-desc").textContent  = "CID:"+p.descCID;
      node.querySelector(".p-price").textContent = "$"+fmt(p.priceUsd/100,2);
      node.querySelector(".p-tax").textContent   = "Thuế:"+fmt(p.taxRate/100,2)+"%";
      node.querySelector(".p-seller-addr").textContent=shortAddr(p.seller);
      node.querySelector(".p-seller-addr").href=linkAddress(p.seller);
      node.querySelector(".buy-btn").onclick=()=>openBuyModal(id,p);
      ui.productList.appendChild(node);
    }
  }catch(e){ console.error(e); }
}

// ---------------- Buy ----------------
let currentProductId, currentProduct;
const modal=document.getElementById("buyModal");
const buyClose=document.getElementById("buyClose");
const buyCancel=document.getElementById("buyCancel");
const buySubmit=document.getElementById("buySubmit");
const buyName=document.getElementById("buyName");
const buyPriceUsd=document.getElementById("buyPriceUsd");
const buyShipUsd=document.getElementById("buyShipUsd");
const buyTaxRate=document.getElementById("buyTaxRate");
const buyQty=document.getElementById("buyQty");
const buyTotalUsd=document.getElementById("buyTotalUsd");
const buyTotalVin=document.getElementById("buyTotalVin");

[buyClose,buyCancel].forEach(b=>b.onclick=()=>hide(modal));

function openBuyModal(id,p){
  currentProductId=id; currentProduct=p;
  buyName.textContent=p.name;
  buyPriceUsd.textContent="$"+fmt(p.priceUsd/100,2);
  buyShipUsd.textContent="$"+fmt(p.shippingUsd/100,2);
  buyTaxRate.textContent=fmt(p.taxRate/100,2)+"%";
  buyQty.value=1;
  recalcBuy();
  show(modal);
}
buyQty.oninput=recalcBuy;

function recalcBuy(){
  const qty=Math.max(parseInt(buyQty.value||"1"),1);
  const subtotal=(currentProduct.priceUsd/100)*qty;
  const tax=subtotal*(currentProduct.taxRate/100);
  const total=subtotal+tax+(currentProduct.shippingUsd/100);
  buyTotalUsd.textContent="$"+fmt(total,2);
  // VIN/USD từ footer
  const chip=document.getElementById("vinUsd").textContent;
  const m=chip.match(/([\d.]+)/);
  if(m){ const vinUsd=parseFloat(m[1]); buyTotalVin.textContent=fmt(total/vinUsd,6)+" VIN"; }
}

buySubmit.onclick=async ()=>{
  try{
    const qty=parseInt(buyQty.value);
    const vinPerUSD=await getVinPerUSDWei();
    const info={
      name: document.getElementById("shipName").value,
      phone:document.getElementById("shipPhone").value,
      address:document.getElementById("shipAddress").value,
      note:document.getElementById("shipNote").value
    };
    const ciphertext="0x"; // TODO: mã hoá info bằng pubkey người bán
    const tx=await muaban.placeOrder(currentProductId,qty,vinPerUSD,ciphertext);
    await tx.wait(1);
    toast("Đặt hàng thành công");
    hide(modal);
  }catch(e){ console.error(e); toast("Lỗi mua hàng"); }
};

// ---------------- VIN/USD helper ----------------
async function getVinPerUSDWei(){
  const res=await fetch("https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT");
  const data=await res.json();
  const vicUsd=parseFloat(data.price);
  const vinUsd=vicUsd*100;
  const vinPerUsd=1/vinUsd;
  return ethers.utils.parseUnits(vinPerUsd.toString(),18);
}

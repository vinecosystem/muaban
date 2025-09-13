/* ====================================================================
   muaban.vin — app.js (ethers v5)
   Phiên bản đầy đủ với các chức năng: kết nối ví, đăng ký, đăng sản phẩm,
   mua sản phẩm, cập nhật sản phẩm, quản lý đơn hàng.
==================================================================== */

/* -------------------- DOM helpers -------------------- */
const $ = (q) => document.querySelector(q);
const $$ = (q) => document.querySelectorAll(q);
const show = (el) => el && el.removeAttribute('hidden');
const hide = (el) => el && el.setAttribute('hidden', '');
const short = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
const fmt = (n) => new Intl.NumberFormat('vi-VN').format(Number(n || 0));
const fmtVIN = (x) => Number(x).toFixed(6);

/* -------------------- Config -------------------- */
const CONFIG = window.__MUABAN_CONFIG__ || {
  CHAIN_ID: 88,
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR: "0x941F63807401efCE8afe3C9d88d368bAA287Fac4"
};
const RPC = "https://rpc.viction.xyz";
const BINANCE_VICUSDT = "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT";
const COINGECKO_USDT_VND = "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd";

/* -------------------- ABI -------------------- */
// ABI của Muaban
const MUABAN_ABI = [
  {"inputs":[{"internalType":"address","name":"vinToken","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},
  {"inputs":[],"name":"payRegistration","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"string","name":"name","type":"string"},{"internalType":"string","name":"descriptionCID","type":"string"},{"internalType":"string","name":"imageCID","type":"string"},{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"bool","name":"active","type":"bool"}],"name":"createProduct","outputs":[{"internalType":"uint256","name":"pid","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"}],"name":"getProduct","outputs":[{"components":[{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"address","name":"seller","type":"address"},{"internalType":"string","name":"name","type":"string"},{"internalType":"string","name":"descriptionCID","type":"string"},{"internalType":"string","name":"imageCID","type":"string"},{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"bool","name":"active","type":"bool"}],"internalType":"struct MuabanVND.Product","name":"","type":"tuple"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"},{"internalType":"uint256","name":"quantity","type":"uint256"},{"internalType":"uint256","name":"vinPerVND","type":"uint256"},{"internalType":"string","name":"buyerInfoCipher","type":"string"}],"name":"placeOrder","outputs":[{"internalType":"uint256","name":"oid","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],"name":"confirmReceipt","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],"name":"refundIfExpired","outputs":[],"stateMutability":"nonpayable","type":"function"},
];

// ABI của Vin Token
const VIN_ABI = [
  {"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"owner","type":"address"}],"name":"allowance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"decimals","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"}
];

/* -------------------- State -------------------- */
let providerRead, providerWrite, signer, account;
let muaban, vin;
let vinPerVNDWei = null;
let productsCache = new Map();
let ordersCache = new Map();

/* -------------------- Init provider -------------------- */
async function ensureProviders(){
  if (window.ethereum){
    providerWrite = new ethers.providers.Web3Provider(window.ethereum, 'any');
    providerRead = providerWrite;
  } else {
    providerRead = new ethers.providers.JsonRpcProvider(RPC);
  }
  muaban = new ethers.Contract(CONFIG.MUABAN_ADDR, MUABAN_ABI, providerRead);
  vin = new ethers.Contract(CONFIG.VIN_ADDR, VIN_ABI, providerRead);
}

/* -------------------- Tỷ giá VIN/VND -------------------- */
async function updateRate(){
  try {
    const vic = await fetch(BINANCE_VICUSDT).then(r => r.json());
    const usdt = await fetch(COINGECKO_USDT_VND).then(r => r.json());
    const vinVnd = Math.floor(Number(vic.price) * 100 * usdt.tether.vnd);
    $("#vin-vnd").innerText = `1 VIN = ${fmt(vinVnd)} VND`;
    vinPerVNDWei = ethers.utils.parseUnits((1e18 / vinVnd).toString(), "wei");
  } catch (e) {
    console.error(e);
  }
}

/* -------------------- Connect/Disconnect -------------------- */
async function connectWallet() {
  await ensureProviders();
  await providerWrite.send("eth_requestAccounts", []);
  signer = providerWrite.getSigner();
  account = await signer.getAddress();

  const balVIN = await vin.balanceOf(account);
  const balVIC = await providerRead.getBalance(account);
  $("#bal-vin").innerText = fmtVIN(ethers.utils.formatUnits(balVIN, 18));
  $("#bal-vic").innerText = fmtVIN(ethers.utils.formatEther(balVIC));
  $("#addr-short").innerText = short(account);

  hide($("#btn-connect"));
  show($("#btn-disconnect"));
  show($("#balances"));

  const isReg = await muaban.registered(account); // Kiểm tra nếu ví đã đăng ký
  if (!isReg) {
    show($("#btn-register"));
  } else {
    hide($("#btn-register"));
    show($("#btn-create"));
    show($("#btn-buyer-orders"));
    show($("#btn-seller-orders"));
  }

  await loadProducts();
  await loadOrders();
}

function disconnectWallet() {
  location.reload();
}

/* -------------------- Đăng ký -------------------- */
async function doRegister() {
  try {
    const muabanW = muaban.connect(signer);
    const tx = await muabanW.payRegistration();
    $("#register-msg").innerText = "Đang gửi giao dịch...";
    await tx.wait();
    $("#register-msg").innerText = "Đăng ký thành công!";
    location.reload();
  } catch (e) {
    alert("Lỗi đăng ký");
  }
}

/* -------------------- Đăng sản phẩm -------------------- */
async function createProduct(form) {
  const f = new FormData(form);
  const name = f.get("name"), imageCID = f.get("imageCID"), descriptionCID = imageCID;
  const priceVND = f.get("priceVND"), days = f.get("deliveryDaysMax");
  const payout = f.get("payoutWallet"), active = f.get("active") === "true";
  const muabanW = muaban.connect(signer);
  const tx = await muabanW.createProduct(name, descriptionCID, imageCID, priceVND, days, payout, active);
  $("#create-msg").innerText = "Đang gửi giao dịch...";
  await tx.wait();
  $("#create-msg").innerText = "Đăng sản phẩm thành công!";
  await loadProducts();
}

/* -------------------- Load sản phẩm -------------------- */
async function loadProducts() {
  // Ở đây giả định contract có event, demo gọi id 1..10
  for (let i = 1; i <= 10; i++) {
    try {
      const p = await muaban.getProduct(i);
      if (p && p.active) productsCache.set(i, p);
    } catch {}
  }
  renderProducts();
}

function renderProducts() {
  const list = $("#product-list");
  list.innerHTML = "";
  productsCache.forEach((p) => {
    const div = document.createElement("div");
    div.className = "card";
    div.innerHTML = `
      <img src="https://ipfs.io/ipfs/${p.imageCID}" alt="">
      <h3>${p.name}</h3>
      <div class="price">${fmt(p.priceVND)} VND</div>
      <button class="btn buy" data-pid="${p.productId}">Mua</button>`;
    list.appendChild(div);
  });
  $$(".buy").forEach(b => b.onclick = () => openBuyDialog(b.dataset.pid));
}

/* -------------------- Mua hàng -------------------- */
function openBuyDialog(pid) {
  $("#buy-pid").value = pid;
  $("#dlg-buy").showModal();
}

async function buyProduct(form) {
  const f = new FormData(form);
  const pid = f.get("productId"), qty = f.get("quantity");
  const info = { fullName: f.get("fullName"), phone: f.get("phone"), address: f.get("address"), note: f.get("note") };
  const cipher = JSON.stringify(info);

  const prod = await muaban.getProduct(pid);
  const vinTotal = ethers.BigNumber.from(prod.priceVND).mul(qty).mul(vinPerVNDWei);

  const vinW = vin.connect(signer);
  const allow = await vin.allowance(account, CONFIG.MUABAN_ADDR);
  if (allow.lt(vinTotal)) {
    const txa = await vinW.approve(CONFIG.MUABAN_ADDR, vinTotal);
    await txa.wait();
  }

  const muabanW = muaban.connect(signer);
  const tx = await muabanW.placeOrder(pid, qty, vinPerVNDWei, cipher);
  $("#buy-msg").innerText = "Đang gửi giao dịch...";
  await tx.wait();
  $("#buy-msg").innerText = "Đặt hàng thành công!";
  $("#dlg-buy").close();
  await loadOrders();
}

/* -------------------- Đơn hàng -------------------- */
async function loadOrders() {
  // demo: lấy 1..10
  for (let i = 1; i <= 10; i++) {
    try {
      const o = await muaban.getOrder(i);
      if (o && o.orderId > 0) ordersCache.set(i, o);
    } catch {}
  }
  renderOrders();
}

function renderOrders() {
  const bList = $("#buyer-orders"), sList = $("#seller-orders");
  bList.innerHTML = "";
  sList.innerHTML = "";
  ordersCache.forEach((o) => {
    const li = document.createElement("li");
    li.textContent = `ĐH#${o.orderId} • SP ${o.productId} • SL ${o.quantity} • VIN ${fmtVIN(ethers.utils.formatUnits(o.vinAmount, 18))}`;
    if (o.buyer.toLowerCase() === account.toLowerCase()) {
      const btn = document.createElement("button"); 
      btn.textContent = "Xác nhận nhận"; 
      btn.onclick = () => confirmReceipt(o.orderId); 
      li.appendChild(btn);
      bList.appendChild(li);
    }
    if (o.seller.toLowerCase() === account.toLowerCase()) {
      const btn = document.createElement("button"); 
      btn.textContent = "Hoàn tiền"; 
      btn.onclick = () => refund(o.orderId); 
      li.appendChild(btn);
      sList.appendChild(li);
    }
  });
}

async function confirmReceipt(id) {
  const muabanW = muaban.connect(signer);
  const tx = await muabanW.confirmReceipt(id);
  await tx.wait();
  await loadOrders();
}

async function refund(id) {
  const muabanW = muaban.connect(signer);
  const tx = await muabanW.refundIfExpired(id);
  await tx.wait();
  await loadOrders();
}

/* -------------------- Events -------------------- */
window.addEventListener("DOMContentLoaded", () => {
  $("#btn-connect").onclick = connectWallet;
  $("#btn-disconnect").onclick = disconnectWallet;
  $("#btn-register").onclick = () => $("#dlg-register").showModal();
  $("#btn-register-confirm").onclick = doRegister;
  $("#form-create").onsubmit = (e) => { e.preventDefault(); createProduct(e.target); };
  $("#form-buy").onsubmit = (e) => { e.preventDefault(); buyProduct(e.target); };
  updateRate();
});

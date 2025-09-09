/* ============================================================
   app.js — muaban dApp (Viction)
   Contract: 0xe01e2213A899E9B3b1921673D2d13a227a8df638
   VIN:      0x941F63807401efCE8afe3C9d88d368bAA287Fac4
   Spec:     VIN/USD = VIC/USDT * 100 ; Escrow + Pre-Confirm
   ============================================================ */

const MUABAN_ADDRESS = "0xe01e2213A899E9B3b1921673D2d13a227a8df638";
const VIN_ADDRESS    = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4";
const VIC_RPC        = "https://rpc.viction.xyz";        // đọc on-chain khi chưa kết nối ví
const EXPLORER       = "https://vicscan.xyz";

// -------------------- Ensure ethers --------------------
(async function ensureEthers(){
  if(!window.ethers){
    await new Promise((resolve, reject)=>{
      const s=document.createElement("script");
      s.src="https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.umd.min.js";
      s.onload=resolve; s.onerror=reject; document.head.appendChild(s);
    });
  }
})().catch(console.error);

// -------------------- State --------------------
const app = {
  provider: null,          // read-only hoặc Web3Provider
  signer: null,            // khi đã kết nối ví
  account: null,
  contracts: { muaban:null, vin:null },
  abis: { muaban:null, vin:null },
  ui: {},
  userRegistered: false
};

// -------------------- UI refs --------------------
const $ = (id)=>document.getElementById(id);
Object.assign(app.ui, {
  // header / wallet
  btnConnect: $("btnConnect"),
  btnDisconnect: $("btnDisconnect"),
  walletBar: $("walletBar"),
  accountShort: $("accountShort"),
  vinBalance: $("vinBalance"),
  vicBalance: $("vicBalance"),
  statusLine: $("statusLine"),
  btnRegister: $("btnRegister"),
  btnCreateProduct: $("btnCreateProduct"),

  // market
  productList: $("productList"),
  emptyProducts: $("emptyProducts"),
  tplProduct: $("tplProductCard"),
  searchInput: $("searchInput"),
  sellerFilter: $("sellerFilter"),
  minPriceUsd: $("minPriceUsd"),
  maxPriceUsd: $("maxPriceUsd"),
  btnReload: $("btnReload"),

  // buy modal
  buyModal: $("buyModal"),
  buyClose: $("buyClose"),
  buyCancel: $("buyCancel"),
  buySubmit: $("buySubmit"),
  buyName: $("buyName"),
  buyPriceUsd: $("buyPriceUsd"),
  buyShipUsd: $("buyShipUsd"),
  buyTaxRate: $("buyTaxRate"),
  buyQty: $("buyQty"),
  buyTotalUsd: $("buyTotalUsd"),
  buyTotalVin: $("buyTotalVin"),
  shipName: $("shipName"),
  shipPhone: $("shipPhone"),
  shipAddress: $("shipAddress"),
  shipNote: $("shipNote"),

  // create modal
  createModal: $("createModal"),
  createClose: $("createClose"),
  createCancel: $("createCancel"),
  createSubmit: $("createSubmit"),
  pName: $("pName"),
  pImageCID: $("pImageCID"),
  pDescCID: $("pDescCID"),
  pPriceUsd: $("pPriceUsd"),
  pShippingUsd: $("pShippingUsd"),
  pTaxPercent: $("pTaxPercent"),
  pDeliveryDays: $("pDeliveryDays"),
  pStock: $("pStock"),
  pRevenueWallet: $("pRevenueWallet"),
  pTaxWallet: $("pTaxWallet"),
  pShippingWallet: $("pShippingWallet"),
  pSellerPubKey: $("pSellerPubKey"),
  pActive: $("pActive"),

  toast: $("toast")
});

// -------------------- Utils --------------------
const short = (a)=>a ? a.slice(0,6)+"…"+a.slice(-4) : "";
const fmt   = (x,d=4)=>Number(x).toFixed(d);
function show(el){ el && el.classList.remove("hidden"); }
function hide(el){ el && el.classList.add("hidden"); }
function toast(msg,ms=2400){ if(!app.ui.toast) return;
  app.ui.toast.textContent=msg; show(app.ui.toast); setTimeout(()=>hide(app.ui.toast), ms);
}
const linkAddress = (addr)=>`${EXPLORER}/address/${addr}`;

// -------------------- Bootstrap --------------------
document.addEventListener("DOMContentLoaded", init);

async function init(){
  // Provider đọc chuỗi khi chưa kết nối ví (xem sản phẩm không cần ví)
  app.provider = new ethers.providers.JsonRpcProvider(VIC_RPC);

  // Load ABI
  [app.abis.muaban, app.abis.vin] = await Promise.all([
    fetch("Muaban_ABI.json").then(r=>r.json()),
    fetch("VinToken_ABI.json").then(r=>r.json()),
  ]);

  // Hợp đồng đọc-only
  app.contracts.muaban = new ethers.Contract(MUABAN_ADDRESS, app.abis.muaban, app.provider);
  app.contracts.vin    = new ethers.Contract(VIN_ADDRESS,    app.abis.vin,    app.provider);

  // wire UI
  app.ui.btnConnect?.addEventListener("click", connectWallet);
  app.ui.btnDisconnect?.addEventListener("click", disconnectWallet);
  app.ui.btnRegister?.addEventListener("click", onRegister);

  app.ui.btnCreateProduct?.addEventListener("click", ()=>show(app.ui.createModal));
  app.ui.createClose?.addEventListener("click", ()=>hide(app.ui.createModal));
  app.ui.createCancel?.addEventListener("click", ()=>hide(app.ui.createModal));
  app.ui.createSubmit?.addEventListener("click", onCreateProduct);

  [app.ui.searchInput, app.ui.sellerFilter, app.ui.minPriceUsd, app.ui.maxPriceUsd]
    .forEach(el=>el?.addEventListener("input", debounce(loadMarket,300)));
  app.ui.btnReload?.addEventListener("click", loadMarket);

  [app.ui.buyClose, app.ui.buyCancel].forEach(b=>b?.addEventListener("click", ()=>hide(app.ui.buyModal)));
  app.ui.buyQty?.addEventListener("input", recalcBuy);
  app.ui.buySubmit?.addEventListener("click", placeOrder);

  if(window.ethereum){
    window.ethereum.on("accountsChanged", ()=>location.reload());
    window.ethereum.on("chainChanged", ()=>location.reload());
  }

  await loadMarket(); // hiển thị sản phẩm dù chưa kết nối ví
}

// -------------------- Connect / Disconnect --------------------
async function connectWallet(){
  if(!window.ethereum){ toast("Cài ví để kết nối (Metamask/OKX…)"); return; }
  const web3 = new ethers.providers.Web3Provider(window.ethereum);
  await web3.send("eth_requestAccounts",[]);
  app.signer  = web3.getSigner();
  app.account = await app.signer.getAddress();
  app.provider = web3;

  // hợp đồng qua signer (giao dịch)
  app.contracts.muaban = new ethers.Contract(MUABAN_ADDRESS, app.abis.muaban, app.signer);
  app.contracts.vin    = new ethers.Contract(VIN_ADDRESS,    app.abis.vin,    app.signer);

  // UI
  hide(app.ui.btnConnect);
  show(app.ui.btnDisconnect);
  show(app.ui.walletBar);
  app.ui.accountShort.textContent = short(app.account);
  app.ui.accountShort.href = linkAddress(app.account);

  await refreshBalances();
  await refreshRegistration();
  await loadMarket(); // để bật nút Mua/Tạo SP nếu đủ điều kiện
}

function disconnectWallet(){
  // trở lại provider đọc-only
  app.signer=null; app.account=null;
  app.provider = new ethers.providers.JsonRpcProvider(VIC_RPC);
  app.contracts.muaban = new ethers.Contract(MUABAN_ADDRESS, app.abis.muaban, app.provider);
  app.contracts.vin    = new ethers.Contract(VIN_ADDRESS,    app.abis.vin,    app.provider);

  show(app.ui.btnConnect);
  hide(app.ui.btnDisconnect);
  hide(app.ui.walletBar);
  app.userRegistered=false;

  loadMarket().catch(()=>{});
}

// -------------------- Balances / Registration --------------------
async function refreshBalances(){
  if(!app.signer || !app.account) return;
  try{
    const [vinBal, vicBal] = await Promise.all([
      app.contracts.vin.balanceOf(app.account),
      app.provider.getBalance(app.account)
    ]);
    app.ui.vinBalance.textContent = `${fmt(ethers.utils.formatUnits(vinBal,18))} VIN`;
    app.ui.vicBalance.textContent = `${fmt(ethers.utils.formatEther(vicBal))} VIC`;
  }catch(e){ console.error(e); }
}

async function refreshRegistration(){
  if(!app.signer || !app.account) return;
  try{
    const ok = await app.contracts.muaban.isRegistered(app.account);
    app.userRegistered = !!ok;
    app.ui.statusLine.textContent = ok ? "Đã đăng ký" : "Chưa đăng ký";
    if(ok){
      hide(app.ui.btnRegister);
      show(app.ui.btnCreateProduct);
    }else{
      show(app.ui.btnRegister);
      hide(app.ui.btnCreateProduct);
    }
  }catch(e){ console.error(e); }
}

async function onRegister(){
  try{
    app.ui.btnRegister.disabled = true;
    app.ui.btnRegister.textContent = "Đang xử lý…";
    const fee = await getPlatformFee();              // 0.001 VIN
    await ensureAllowance(fee);                      // approve đủ
    const tx = await app.contracts.muaban.payRegistration();
    await tx.wait(1);
    toast("Đăng ký thành công");
    await refreshRegistration();
    await refreshBalances();
  }catch(e){
    console.error(e);
    toast("Lỗi đăng ký");
  }finally{
    app.ui.btnRegister.disabled = false;
    app.ui.btnRegister.textContent = "Đăng ký";
  }
}

async function getPlatformFee(){
  try{
    return await app.contracts.muaban.PLATFORM_FEE(); // 1e15 wei
  }catch{
    return ethers.BigNumber.from("1000000000000000");
  }
}

async function ensureAllowance(minWei){
  const cur = await app.contracts.vin.allowance(app.account, MUABAN_ADDRESS);
  if(cur.gte(minWei)) return;
  // VIN là ERC20 có fee sự kiện → approve Max để tránh thiếu do phí nội bộ token
  const tx = await app.contracts.vin.approve(MUABAN_ADDRESS, ethers.constants.MaxUint256);
  await tx.wait(1);
}

// -------------------- Market: load products (events) --------------------
async function fetchAllProductIds(){
  // Duyệt sự kiện ProductCreated để lấy danh sách productId
  const iface = new ethers.utils.Interface(app.abis.muaban);
  const topic = iface.getEventTopic("ProductCreated");
  const latest = await app.provider.getBlockNumber();
  const fromBlock = 0; // nếu cần, đặt block bắt đầu triển khai
  const logs = await app.provider.getLogs({ address: MUABAN_ADDRESS, fromBlock, toBlock: latest, topics:[topic] });
  const ids = new Set();
  for(const lg of logs){
    try{
      const parsed = iface.parseLog(lg);
      ids.add(parsed.args.productId.toString());
    }catch{}
  }
  return Array.from(ids).map(x=>ethers.BigNumber.from(x));
}

async function readProduct(pid){
  // ABI có cả getProduct & products (public); gọi getProduct trước, fallback sang products
  try{ return await app.contracts.muaban.getProduct(pid); }
  catch{ return await app.contracts.muaban.products(pid); }
}

async function loadMarket(){
  const {productList, emptyProducts, tplProduct} = app.ui;
  if(!productList || !tplProduct) return;

  productList.innerHTML = "";
  show(emptyProducts);

  let ids = [];
  try{
    ids = await fetchAllProductIds();
  }catch(e){
    console.warn("Cannot scan events without RPC:", e);
    return;
  }

  const q = (app.ui.searchInput?.value||"").toLowerCase();
  const filterSeller = (app.ui.sellerFilter?.value||"").trim().toLowerCase();
  const minU = parseFloat(app.ui.minPriceUsd?.value||"0") || 0;
  const maxU = parseFloat(app.ui.maxPriceUsd?.value||"0") || 0;

  for(const pid of ids){
    const p = await readProduct(pid);
    if(!p.active) continue;
    if(ethers.BigNumber.from(p.stock||0).isZero()) continue;

    const priceUsd = Number(p.priceUsdCents)/100;
    const shipUsd  = Number(p.shippingUsdCents)/100;
    const taxPct   = Number(p.taxRateBps)/100; // bps → %

    const seller = (p.seller||p[1]||"").toString();
    if(filterSeller && seller.toLowerCase()!==filterSeller) continue;
    if(minU>0 && priceUsd<minU) continue;
    if(maxU>0 && priceUsd>maxU) continue;
    if(q && !String(p.name||"").toLowerCase().includes(q)) continue;

    hide(emptyProducts);
    const node = tplProduct.content.firstElementChild.cloneNode(true);
    node.querySelector(".p-img").src = p.imageCID ? `https://ipfs.io/ipfs/${p.imageCID}` : "";
    node.querySelector(".p-img").alt = p.name || "";
    node.querySelector(".p-title").textContent = p.name || "";
    node.querySelector(".p-desc").textContent = p.descriptionCID ? `IPFS: ${p.descriptionCID}` : "";
    node.querySelector(".p-price").textContent = `$${fmt(priceUsd,2)}`;
    node.querySelector(".p-tax").textContent = `Thuế: ${fmt(taxPct,2)}%`;
    node.querySelector(".p-delivery").textContent = `Giao tối đa: ${p.deliveryDaysMax} ngày`;

    const sellerA = node.querySelector(".p-seller-addr");
    sellerA.textContent = short(seller);
    sellerA.href = linkAddress(seller);

    const btnBuy = node.querySelector(".buy-btn");
    if(app.account && app.userRegistered){
      btnBuy.classList.remove("hidden");
      btnBuy.addEventListener("click", ()=>openBuyModal({
        productId: pid,
        name: p.name,
        priceUsdCents: p.priceUsdCents,
        shippingUsdCents: p.shippingUsdCents,
        taxRateBps: p.taxRateBps
      }));
    }else{
      btnBuy.classList.add("hidden");
    }

    productList.appendChild(node);
  }
}

// -------------------- Buy flow --------------------
let currentBuy=null;

function openBuyModal(data){
  currentBuy = data;
  const priceUsd = Number(data.priceUsdCents)/100;
  const shipUsd  = Number(data.shippingUsdCents)/100;
  const taxRate  = Number(data.taxRateBps)/10000;

  app.ui.buyName.textContent = data.name;
  app.ui.buyPriceUsd.textContent = `$${fmt(priceUsd,2)}`;
  app.ui.buyShipUsd.textContent  = `$${fmt(shipUsd,2)}`;
  app.ui.buyTaxRate.textContent  = `${fmt(taxRate*100,2)}%`;
  app.ui.buyQty.value = 1;

  recalcBuy();
  show(app.ui.buyModal);
}

function recalcBuy(){
  if(!currentBuy) return;
  const qty = Math.max(parseInt(app.ui.buyQty.value||"1",10),1);
  const priceUsd = Number(currentBuy.priceUsdCents)/100;
  const shipUsd  = Number(currentBuy.shippingUsdCents)/100;
  const taxRate  = Number(currentBuy.taxRateBps)/10000;

  const subtotal = priceUsd * qty;
  const taxUsd   = subtotal * taxRate;
  const totalUsd = subtotal + shipUsd + taxUsd;

  app.ui.buyTotalUsd.textContent = `$${fmt(totalUsd,2)}`;

  // tham khảo VIN dựa theo chip ở header
  const chip = document.getElementById("vinUsdTop")?.textContent||"";
  const m = chip.match(/([\d.]+)/);
  if(m){
    const vinUsd = parseFloat(m[1]);
    if(isFinite(vinUsd)&&vinUsd>0){
      app.ui.buyTotalVin.textContent = `${fmt(totalUsd/vinUsd,6)} VIN`;
    }
  }
}

async function placeOrder(){
  try{
    app.ui.buySubmit.disabled = true;
    app.ui.buySubmit.textContent = "Đang đặt…";

    // 1) vinPerUSD (wei/USD) = 1e18 / (vicUsd*100)
    const vinPerUSDWei = await getVinPerUSDWei();

    // 2) đảm bảo allowance lớn (VIN có fee → approve Max)
    await ensureAllowance(ethers.utils.parseUnits("0.01",18)); // trigger approve Max nếu chưa có

    // 3) shipping info (JSON → bytes)
    const ship = collectShippingBytes();

    // 4) Gọi contract
    const pid = currentBuy.productId;
    const qty = Math.max(parseInt(app.ui.buyQty.value||"1",10),1);
    const tx = await app.contracts.muaban.placeOrder(pid, qty, vinPerUSDWei, ship);
    await tx.wait(1);

    toast("Đặt hàng thành công");
    hide(app.ui.buyModal);
    await refreshBalances();
  }catch(e){
    console.error(e);
    toast("Không thể đặt hàng");
  }finally{
    app.ui.buySubmit.disabled = false;
    app.ui.buySubmit.textContent = "Xác nhận thanh toán";
  }
}

function collectShippingBytes(){
  const name = app.ui.shipName.value.trim();
  const phone= app.ui.shipPhone.value.trim();
  const addr = app.ui.shipAddress.value.trim();
  const note = app.ui.shipNote.value.trim();
  if(!name || !phone || !addr) throw new Error("Thiếu thông tin giao hàng");
  const payload = JSON.stringify({name,phone,addr,note});
  return ethers.utils.hexlify(new TextEncoder().encode(payload));
}

// VIN/USD helper: VIN = VIC * 100 (USD/VIN) → vinPerUSD = 1 / (VIC*100)
async function getVinPerUSDWei(){
  const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT", {cache:"no-store"});
  if(!r.ok) throw new Error("Price HTTP "+r.status);
  const {price} = await r.json();
  const vicUsd = parseFloat(price);
  const vinUsd = vicUsd * 100;
  const vinPerUSD = 1 / vinUsd; // VIN cho 1 USD
  return ethers.utils.parseUnits(vinPerUSD.toString(), 18);
}

// -------------------- Create product --------------------
async function onCreateProduct(e){
  e?.preventDefault?.();
  if(!app.userRegistered){ toast("Đăng ký trước khi tạo sản phẩm"); return; }
  try{
    const name = app.ui.pName.value.trim();
    const imgCID = app.ui.pImageCID.value.trim();
    const descCID= app.ui.pDescCID.value.trim();
    const priceCents = Math.round(parseFloat(app.ui.pPriceUsd.value)*100);
    const shipCents  = Math.round(parseFloat(app.ui.pShippingUsd.value||"0")*100);
    const taxBps     = Math.round(parseFloat(app.ui.pTaxPercent.value||"0")*100);
    const days       = parseInt(app.ui.pDeliveryDays.value,10);
    const stock      = parseInt(app.ui.pStock.value,10);
    const revWallet  = app.ui.pRevenueWallet.value.trim();
    const taxWallet  = app.ui.pTaxWallet.value.trim();
    const shipWallet = (app.ui.pShippingWallet.value.trim()||ethers.constants.AddressZero);
    const pubKeyHex  = app.ui.pSellerPubKey.value.trim();
    const active     = !!app.ui.pActive.checked;

    const tx = await app.contracts.muaban.createProduct(
      name, descCID, imgCID,
      priceCents, shipCents, taxBps, days,
      revWallet, taxWallet, shipWallet,
      pubKeyHex, stock, active
    );
    await tx.wait(1);
    toast("Đăng sản phẩm thành công");
    hide(app.ui.createModal);
    await loadMarket();
  }catch(e){
    console.error(e);
    toast("Không thể tạo sản phẩm");
  }
}

// -------------------- Debounce --------------------
function debounce(fn, wait){
  let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn.apply(null,args), wait); };
}

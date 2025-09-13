/* ====================================================================
   muaban.vin — app.js (ethers v5, ABI rút gọn)
   - Hợp đồng: 0x190FD18820498872354eED9C4C080cB365Cd12E0 (Viction 88)
   - VIN token: 0x941F63807401efCE8afe3C9d88d368bAA287Fac4
==================================================================== */

/* -------------------- DOM helpers -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show=(el)=>el && el.removeAttribute('hidden');
const hide=(el)=>el && el.setAttribute('hidden','');
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`:"";
const fmt=(n)=>new Intl.NumberFormat('vi-VN').format(Number(n||0));
const fmtVIN=(x)=>Number(x).toFixed(6);

/* -------------------- Config -------------------- */
const CONFIG = {
  CHAIN_ID: 88,
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR: "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",
  RPC: "https://rpc.viction.xyz",
  EXPLORER: "https://scan.viction.xyz",
  BINANCE_VICUSDT: "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",
  COINGECKO_USDT_VND: "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd"
};

/* -------------------- ABI rút gọn -------------------- */
// VIN Token
const VIN_ABI = [
  {"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"}],"name":"allowance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"}
];

// Muaban
const MUABAN_ABI = [
  {"inputs":[],"name":"REG_FEE","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"registered","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"payRegistration","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"string","name":"name","type":"string"},{"internalType":"string","name":"descriptionCID","type":"string"},{"internalType":"string","name":"imageCID","type":"string"},{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"bool","name":"active","type":"bool"}],"name":"createProduct","outputs":[{"internalType":"uint256","name":"pid","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"},{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"bool","name":"active","type":"bool"}],"name":"updateProduct","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"}],"name":"getProduct","outputs":[{"components":[{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"address","name":"seller","type":"address"},{"internalType":"string","name":"name","type":"string"},{"internalType":"string","name":"descriptionCID","type":"string"},{"internalType":"string","name":"imageCID","type":"string"},{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"bool","name":"active","type":"bool"}],"internalType":"struct MuabanVND.Product","name":"","type":"tuple"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"oid","type":"uint256"}],"name":"getOrder","outputs":[{"components":[{"internalType":"uint256","name":"orderId","type":"uint256"},{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"address","name":"buyer","type":"address"},{"internalType":"address","name":"seller","type":"address"},{"internalType":"uint256","name":"quantity","type":"uint256"},{"internalType":"uint256","name":"vinAmount","type":"uint256"},{"internalType":"uint256","name":"placedAt","type":"uint256"},{"internalType":"uint256","name":"deadline","type":"uint256"},{"internalType":"uint8","name":"status","type":"uint8"},{"internalType":"string","name":"buyerInfoCipher","type":"string"}],"internalType":"struct MuabanVND.Order","name":"","type":"tuple"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"uint256","name":"quantity","type":"uint256"},{"internalType":"uint256","name":"vinPerVND","type":"uint256"},{"internalType":"string","name":"buyerInfoCipher","type":"string"}],"name":"placeOrder","outputs":[{"internalType":"uint256","name":"oid","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],"name":"confirmReceipt","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],"name":"refundIfExpired","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"productId","type":"uint256"},{"indexed":true,"internalType":"address","name":"seller","type":"address"},{"indexed":false,"internalType":"string","name":"name","type":"string"},{"indexed":false,"internalType":"uint256","name":"priceVND","type":"uint256"}],"name":"ProductCreated","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"productId","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"priceVND","type":"uint256"},{"indexed":false,"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"indexed":false,"internalType":"bool","name":"active","type":"bool"}],"name":"ProductUpdated","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"orderId","type":"uint256"},{"indexed":true,"internalType":"uint256","name":"productId","type":"uint256"},{"indexed":true,"internalType":"address","name":"buyer","type":"address"},{"indexed":false,"internalType":"uint256","name":"quantity","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"vinAmount","type":"uint256"}],"name":"OrderPlaced","type":"event"}
];

/* -------------------- State -------------------- */
let providerRead, providerWrite, signer, account;
let muaban, vin;
let vinVnd = null;
let vinPerVNDWei = null;
let productsCache = new Map();
let ordersByBuyer = [];
let ordersBySeller = [];

/* -------------------- Crypto (AES-GCM demo) -------------------- */
async function deriveKeyFromPass(pass){
  const salt = new Uint8Array(16);
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), {name:'PBKDF2'}, false, ['deriveKey']);
  return await crypto.subtle.deriveKey(
    {name:'PBKDF2', salt, iterations: 50000, hash:'SHA-256'},
    baseKey, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']
  );
}
async function encryptBuyerInfo(obj, pass){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKeyFromPass(pass);
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const cipher = await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, data);
  const out = btoa(String.fromCharCode(...iv))+'.'+btoa(String.fromCharCode(...new Uint8Array(cipher)));
  return 'gcm:'+out;
}

/* -------------------- Providers & Wallet -------------------- */
async function ensureProviders(){
  if (window.ethereum){
    providerWrite = new ethers.providers.Web3Provider(window.ethereum, 'any');
    providerRead  = providerWrite;
  }else{
    providerRead = new ethers.providers.JsonRpcProvider(CONFIG.RPC);
  }
  muaban = new ethers.Contract(CONFIG.MUABAN_ADDR, MUABAN_ABI, providerRead);
  vin    = new ethers.Contract(CONFIG.VIN_ADDR, VIN_ABI, providerRead);
}

async function connectWallet(){
  await ensureProviders();
  if (!window.ethereum) throw new Error('Không tìm thấy ví (MetaMask, Rabby…).');
  const [acc] = await window.ethereum.request({ method: 'eth_requestAccounts' });
  signer = providerWrite.getSigner();
  account = ethers.utils.getAddress(acc);

  const net = await providerWrite.getNetwork();
  if (Number(net.chainId) !== Number(CONFIG.CHAIN_ID)){
    await window.ethereum.request({
      method:'wallet_switchEthereumChain',
      params:[{ chainId: '0x' + Number(CONFIG.CHAIN_ID).toString(16) }]
    });
  }

  muaban = muaban.connect(signer);
  vin    = vin.connect(signer);

  $('#addr-short').textContent = short(account);
  show($('#balances'));
  hide($('#btn-connect'));

  await refreshBalances();
  await refreshRegisterUI();
  await loadAllProducts();
  await rebuildOrdersViews();
}

async function refreshBalances(){
  if (!account) return;
  const [vinBal, vicBal] = await Promise.all([
    vin.balanceOf(account),
    providerRead.getBalance(account)
  ]);
  $('#bal-vin').textContent = fmtVIN(ethers.utils.formatUnits(vinBal,18));
  $('#bal-vic').textContent = fmtVIN(ethers.utils.formatEther(vicBal));
}

/* -------------------- Rate: VIN/VND -------------------- */
async function fetchVinRate(){
  try{
    const [r1, r2] = await Promise.all([
      fetch(CONFIG.BINANCE_VICUSDT).then(r=>r.json()),
      fetch(CONFIG.COINGECKO_USDT_VND).then(r=>r.json())
    ]);
    const vicUsdt = Number(r1?.price || 0);
    const usdtVnd = Number(r2?.tether?.vnd || 0);
    if (vicUsdt>0 && usdtVnd>0){
      const raw = vicUsdt * 100 * usdtVnd; // 1 VIN = 100 VIC
      vinVnd = Math.floor(raw);
      $('#vin-vnd').textContent = `1 VIN = ${fmt(vinVnd)} VND`;
      const ONE = ethers.BigNumber.from('1000000000000000000');            // 1e18
      vinPerVNDWei = ONE.div(ethers.BigNumber.from(String(vinVnd)));       // floor(1e18 / vinVnd)
    }
  }catch(e){
    console.error('fetchVinRate', e);
  }
}

/* -------------------- Register -------------------- */
async function isRegistered(addr){
  try{ return await muaban.registered(addr); }catch{ return false; }
}
async function refreshRegisterUI(){
  if (!account) { hide($('#btn-register')); return; }
  const reg = await isRegistered(account);
  if (reg){
    hide($('#btn-register'));
    show($('#btn-create'));
    show($('#btn-buyer-orders'));
    show($('#btn-seller-orders'));
  }else{
    show($('#btn-register'));
    hide($('#btn-create'));
    hide($('#btn-buyer-orders'));
    hide($('#btn-seller-orders'));
  }
}
async function doRegister(){
  const REG_FEE = await muaban.REG_FEE(); // 0.001 VIN on-chain
  const allowance = await vin.allowance(account, CONFIG.MUABAN_ADDR);
  if (allowance.lt(REG_FEE)){
    const txA = await vin.approve(CONFIG.MUABAN_ADDR, REG_FEE);
    $('#register-msg').textContent = 'Đang approve 0.001 VIN...';
    await txA.wait();
  }
  const tx = await muaban.payRegistration();
  $('#register-msg').textContent = 'Đang gửi giao dịch...';
  await tx.wait();
  $('#register-msg').textContent = 'Đăng ký thành công!';
  await refreshRegisterUI();
  await refreshBalances();
}

/* -------------------- Products (read & render) -------------------- */
async function loadAllProducts(){
  productsCache.clear();
  // Lấy qua events để hiện ngay các sản phẩm từng được tạo
  const created = await muaban.queryFilter(muaban.filters.ProductCreated(), 0, 'latest');
  for (const ev of created){
    const pid = ev.args.productId.toString();
    const p = await muaban.getProduct(pid);
    productsCache.set(pid, p);
  }
  // áp dụng cập nhật mới nhất
  const updated = await muaban.queryFilter(muaban.filters.ProductUpdated(), 0, 'latest');
  for (const u of updated){
    const pid = u.args.productId.toString();
    if (productsCache.has(pid)){
      const p = await muaban.getProduct(pid);
      productsCache.set(pid, p);
    }
  }
  renderProducts();
}

function renderProducts(keyword=""){
  const list = $('#list'); list.innerHTML='';
  const empty = $('#empty'); empty.textContent='';
  const kw = keyword.trim().toLowerCase();

  const entries = [...productsCache.values()]
    .filter(p => p && p.productId && p.name)
    .filter(p => !kw || String(p.name).toLowerCase().includes(kw));

  if (!entries.length){
    empty.textContent = 'Chưa có sản phẩm nào hoặc không khớp từ khoá.';
    return;
  }

  for (const p of entries){
    const card = document.createElement('div'); card.className='card';
    const img = document.createElement('img'); img.src = p.imageCID || './logo.png'; img.loading='lazy';
    const body = document.createElement('div'); body.className='card-body';

    const t = document.createElement('div'); t.className='card-title'; t.textContent = p.name;
    const price = document.createElement('div'); price.className='card-price'; price.textContent = `${fmt(p.priceVND)} VND`;
    const meta = document.createElement('div'); meta.className='card-meta';
    meta.textContent = `Trạng thái: ${p.active ? 'Còn hàng' : 'Tạm dừng'}`;

    const row = document.createElement('div'); row.className='row'; row.style.gap='6px';

    const btnBuy = document.createElement('button'); btnBuy.className='btn secondary'; btnBuy.textContent='Mua';
    btnBuy.onclick = ()=> openBuyDialog(p.productId.toString(), p);

    const btnEdit = document.createElement('button'); btnEdit.className='btn ghost'; btnEdit.textContent='Cập nhật';
    btnEdit.onclick = ()=> openUpdateDialog(p);

    if (account){
      if (p.active) row.appendChild(btnBuy);
      if (String(p.seller).toLowerCase() === String(account).toLowerCase()) row.appendChild(btnEdit);
    }

    body.appendChild(t);
    body.appendChild(price);
    body.appendChild(meta);
    body.appendChild(row);

    card.appendChild(img);
    card.appendChild(body);
    list.appendChild(card);
  }
}

/* -------------------- Create / Update -------------------- */
function openCreateDialog(){
  $('#create-msg').textContent='';
  $('#form-create').reset();
  document.getElementById('dlg-create').showModal();
}
async function submitCreate(e){
  e.preventDefault();
  if (!await isRegistered(account)) { alert('Bạn cần đăng ký trước.'); return; }
  const fd = new FormData(e.target);
  const name = String(fd.get('name')||'').trim();
  const descriptionCID = String(fd.get('descriptionCID')||'').trim();
  const imageCID = String(fd.get('imageCID')||'').trim();
  const priceVND = ethers.BigNumber.from(String(fd.get('priceVND')||'0'));
  const deliveryDaysMax = Number(fd.get('deliveryDaysMax')||'0');
  const payoutWallet = String(fd.get('payoutWallet')||'').trim();
  const active = String(fd.get('active')) === 'true';

  try{
    const tx = await muaban.createProduct(
      name, descriptionCID, imageCID, priceVND, deliveryDaysMax, payoutWallet, active
    );
    $('#create-msg').textContent='Đang gửi giao dịch...';
    await tx.wait();
    $('#create-msg').textContent='Đăng sản phẩm thành công!';
    await loadAllProducts();
  }catch(err){
    console.error(err);
    $('#create-msg').textContent='Lỗi khi đăng sản phẩm.';
  }
}

function openUpdateDialog(p){
  $('#update-msg').textContent='';
  const form = $('#form-update');
  form.productId.value = p.productId.toString();
  form.priceVND.value = p.priceVND.toString();
  form.deliveryDaysMax.value = Number(p.deliveryDaysMax);
  form.payoutWallet.value = p.payoutWallet;
  form.active.value = p.active ? 'true' : 'false';
  document.getElementById('dlg-update').showModal();
}
async function submitUpdate(e){
  e.preventDefault();
  const fd = new FormData(e.target);
  const pid = fd.get('productId');
  const priceVND = ethers.BigNumber.from(String(fd.get('priceVND')||'0'));
  const deliveryDaysMax = Number(fd.get('deliveryDaysMax')||'0');
  const payoutWallet = String(fd.get('payoutWallet')||'').trim();
  const active = (String(fd.get('active'))==='true');

  try{
    const tx = await muaban.updateProduct(pid, priceVND, deliveryDaysMax, payoutWallet, active);
    $('#update-msg').textContent='Đang gửi giao dịch...';
    await tx.wait();
    $('#update-msg').textContent='Đã cập nhật sản phẩm!';
    await loadAllProducts();
  }catch(err){
    console.error(err);
    $('#update-msg').textContent='Lỗi khi cập nhật.';
  }
}

/* -------------------- Buy -------------------- */
let currentBuyProduct = null;
function openBuyDialog(pid, p){
  currentBuyProduct = p;
  $('#buy-msg').textContent='';
  const form = $('#form-buy');
  form.reset();
  form.productId.value = pid;
  computeBuyTotal();
  document.getElementById('dlg-buy').showModal();
}
function computeBuyTotal(){
  if (!currentBuyProduct || !vinPerVNDWei) { $('#buy-total-vin').textContent='…'; return; }
  const qty = Math.max(1, parseInt($('#buy-qty').value || '1', 10));
  const priceVND = ethers.BigNumber.from(currentBuyProduct.priceVND.toString());
  const totalVND = priceVND.mul(qty);
  const totalWei = totalVND.mul(vinPerVNDWei); // hợp đồng sẽ ceil bảo vệ seller
  const humanVIN = ethers.utils.formatUnits(totalWei, 18);
  $('#buy-total-vin').textContent = `${fmtVIN(humanVIN)} VIN`;
}
async function submitBuy(e){
  e.preventDefault();
  if (!currentBuyProduct) return;
  if (!vinPerVNDWei) { alert('Chưa có tỷ giá VIN/VND.'); return; }

  const fd = new FormData(e.target);
  const pid = fd.get('productId');
  const qty = Math.max(1, parseInt(fd.get('quantity')||'1', 10));

  const info = {
    fullName: String(fd.get('fullName')||'').trim(),
    phone: String(fd.get('phone')||'').trim(),
    address: String(fd.get('address')||'').trim(),
    note: String(fd.get('note')||'').trim()
  };
  const cipher = await encryptBuyerInfo(info, account.toLowerCase());

  const priceVND = ethers.BigNumber.from(currentBuyProduct.priceVND.toString());
  const totalVND = priceVND.mul(qty);
  const totalVINWei = totalVND.mul(vinPerVNDWei);

  try{
    const allowance = await vin.allowance(account, CONFIG.MUABAN_ADDR);
    if (allowance.lt(totalVINWei)){
      const txA = await vin.approve(CONFIG.MUABAN_ADDR, totalVINWei);
      $('#buy-msg').textContent='Đang approve VIN...';
      await txA.wait();
    }
    const tx = await muaban.placeOrder(pid, qty, vinPerVNDWei, cipher);
    $('#buy-msg').textContent='Đang gửi giao dịch...';
    await tx.wait();
    $('#buy-msg').textContent='Đặt hàng thành công!';
    await refreshBalances();
    await rebuildOrdersViews();
  }catch(err){
    console.error(err);
    $('#buy-msg').textContent='Lỗi khi đặt hàng.';
  }
}

/* -------------------- Orders -------------------- */
async function rebuildOrdersViews(){
  if (!account) return;
  ordersByBuyer = [];
  ordersBySeller = [];

  const evs = await muaban.queryFilter(muaban.filters.OrderPlaced(), 0, 'latest');
  for (const ev of evs){
    const oid = ev.args.orderId.toString();
    const o = await muaban.getOrder(oid);
    const p = await muaban.getProduct(o.productId.toString());
    if (o.buyer.toLowerCase() === account.toLowerCase()){
      ordersByBuyer.push({o, p});
    }
    if (o.seller.toLowerCase() === account.toLowerCase()){
      ordersBySeller.push({o, p});
    }
  }
  renderBuyerOrders();
  renderSellerOrders();
}
function renderBuyerOrders(){
  const tb = $('#buyer-orders-body'); tb.innerHTML='';
  for (const {o, p} of ordersByBuyer){
    const tr = document.createElement('tr');
    const status = ['NONE','PLACED','RELEASED','REFUNDED'][o.status] || o.status;
    const deadline = new Date(Number(o.deadline)*1000).toLocaleString('vi-VN');
    const vin = ethers.utils.formatUnits(o.vinAmount,18);
    tr.innerHTML = `
      <td>${o.orderId}</td>
      <td>${p.name}</td>
      <td>${o.quantity}</td>
      <td>${fmtVIN(vin)}</td>
      <td>${deadline}</td>
      <td>${status}</td>
      <td>${o.status==1?`<button class="btn secondary" data-rcv="${o.orderId}">Xác nhận</button>
        <button class="btn ghost" data-refund="${o.orderId}">Hoàn tiền</button>`:''}
      </td>
    `;
    tb.appendChild(tr);
  }
}
function renderSellerOrders(){
  const tb = $('#seller-orders-body'); tb.innerHTML='';
  for (const {o, p} of ordersBySeller){
    const tr = document.createElement('tr');
    const status = ['NONE','PLACED','RELEASED','REFUNDED'][o.status] || o.status;
    const deadline = new Date(Number(o.deadline)*1000).toLocaleString('vi-VN');
    const vin = ethers.utils.formatUnits(o.vinAmount,18);
    tr.innerHTML = `
      <td>${o.orderId}</td>
      <td>${short(o.buyer)}</td>
      <td>${p.name}</td>
      <td>${o.quantity}</td>
      <td>${fmtVIN(vin)}</td>
      <td>${deadline}</td>
      <td>${status}</td>
    `;
    tb.appendChild(tr);
  }
}

/* -------------------- Actions -------------------- */
async function actionConfirm(orderId){
  try{
    const tx = await muaban.confirmReceipt(orderId);
    await tx.wait();
    await rebuildOrdersViews();
  }catch(e){ console.error(e); alert('Lỗi xác nhận.'); }
}
async function actionRefund(orderId){
  try{
    const tx = await muaban.refundIfExpired(orderId);
    await tx.wait();
    await rebuildOrdersViews();
  }catch(e){ console.error(e); alert('Lỗi hoàn tiền (chưa quá hạn?).'); }
}

/* -------------------- Wiring -------------------- */
document.addEventListener('DOMContentLoaded', async ()=>{
  await ensureProviders();
  await fetchVinRate();

  $('#btn-connect')?.addEventListener('click', ()=>connectWallet().catch(e=>alert(e.message||e)));
  $('#btn-register')?.addEventListener('click', ()=>{ $('#register-msg').textContent=''; document.getElementById('dlg-register').showModal(); });
  $('#btn-register-confirm')?.addEventListener('click', ()=>doRegister().catch(e=>alert(e.message||e)));

  $('#btn-create')?.addEventListener('click', openCreateDialog);
  $('#btn-buyer-orders')?.addEventListener('click', ()=>{ document.getElementById('dlg-buyer-orders').showModal(); });
  $('#btn-seller-orders')?.addEventListener('click', ()=>{ document.getElementById('dlg-seller-orders').showModal(); });

  $('#form-create')?.addEventListener('submit', submitCreate);
  $('#form-update')?.addEventListener('submit', submitUpdate);
  $('#form-buy')?.addEventListener('submit', submitBuy);
  $('#buy-qty')?.addEventListener('input', computeBuyTotal);

  $('#btn-search')?.addEventListener('click', ()=>{
    const kw = $('#q').value||'';
    renderProducts(kw);
  });

  document.body.addEventListener('click', (e)=>{
    const t = e.target;
    if (t && t.getAttribute){
      const oid1 = t.getAttribute('data-rcv');
      const oid2 = t.getAttribute('data-refund');
      if (oid1) actionConfirm(oid1);
      if (oid2) actionRefund(oid2);
    }
  });

  // Load sản phẩm ở chế độ chỉ đọc (chưa cần ví)
  await loadAllProducts();
});

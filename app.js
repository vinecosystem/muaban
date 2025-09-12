/* ========== muaban.vin — app.js ========== */
/* Phụ thuộc: ethers 5.x UMD (đã nhúng trong index.html) */

/* -------------------- CẤU HÌNH -------------------- */
const CONFIG = {
  CHAIN_ID: 88, // Viction mainnet
  RPC_URL: "https://rpc.viction.xyz", // RPC public (đổi nếu bạn dùng RPC khác)
  EXPLORER: "https://scan.viction.xyz",
  MUABAN_ADDR: "0xe01e2213A899E9B3b1921673D2d13a227a8df638",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",
};

/* -------------------- BIẾN TOÀN CỤC -------------------- */
let providerRead, providerWrite, signer, account;
let muaban, vin;
let MUABAN_ABI, VIN_ABI;

let isRegistered = false;
let usdtVND = null;        // 1 USDT ~ ? VND (CoinGecko)
let vicUSDT = null;        // 1 VIC ~ ? USDT (Binance)
let vinVND = null;         // 1 VIN ~ ? VND  (floor int)
let vinPerUSDWei = null;   // VIN wei per 1 USD (VIC/USDT * 100 * 1e18)

/* -------------------- TIỆN ÍCH DOM & ĐỊNH DẠNG -------------------- */
const $   = sel => document.querySelector(sel);
const $$  = sel => document.querySelectorAll(sel);
const fmtVND = v => (v ?? 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const short = a => a ? a.slice(0,6) + "…" + a.slice(-4) : "";
const esc = s => (s||"").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;'}[c]));

/* -------------------- KHỞI TẠO -------------------- */
(async function boot(){
  bindUIBasics();
  await loadABI();
  await initProvidersReadOnly();
  setFooterLinks();

  // tải tỷ giá & danh sách sản phẩm cho khách chưa kết nối ví
  await refreshTicker();
  await listProducts();

  // nếu user kết nối ví -> làm tươi UI
  // (nút kết nối nằm trong index.html)
})();

/* -------------------- TẢI ABI & PROVIDERS -------------------- */
async function loadABI(){
  MUABAN_ABI = await fetch('./Muaban_ABI.json').then(r=>r.json());
  VIN_ABI    = await fetch('./VinToken_ABI.json').then(r=>r.json());
}

async function initProvidersReadOnly(){
  providerRead = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
  muaban = new ethers.Contract(CONFIG.MUABAN_ADDR, MUABAN_ABI, providerRead);
  vin    = new ethers.Contract(CONFIG.VIN_ADDR,    VIN_ABI,    providerRead);
}

async function connectWallet(){
  if(!window.ethereum){ alert("Vui lòng cài MetaMask hoặc ví EVM."); return; }
  const [acc] = await window.ethereum.request({ method:'eth_requestAccounts' });
  providerWrite = new ethers.providers.Web3Provider(window.ethereum);
  signer  = providerWrite.getSigner();
  account = ethers.utils.getAddress(acc);
  muaban  = muaban.connect(signer);
  vin     = vin.connect(signer);

  // chuyển chain nếu cần
  const net = await providerWrite.getNetwork();
  if(net.chainId !== CONFIG.CHAIN_ID){
    try{
      await window.ethereum.request({
        method:'wallet_switchEthereumChain',
        params:[{ chainId: '0x'+CONFIG.CHAIN_ID.toString(16) }]
      });
    }catch(e){
      alert("Hãy thêm/chuyển sang mạng Viction trong ví.");
      console.warn(e);
    }
  }

  await refreshAllForWallet();
}

/* -------------------- TỶ GIÁ -------------------- */
async function refreshTicker(){
  try{
    // 1) USDT->VND (CoinGecko)
    const gecko = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd")
      .then(r=>r.json());
    usdtVND = Number(gecko?.tether?.vnd || 0);

    // 2) VIC->USDT (Binance)
    const bin = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT")
      .then(r=>r.json());
    vicUSDT = Number(bin?.price || 0);

    // 3) 1 VIN ~ floor( VIC/USDT * 100 * USDT/VND )
    vinVND = Math.floor(vicUSDT * 100 * usdtVND);
    $('#vin-vnd').textContent = `1 VIN = ${fmtVND(vinVND)} VND`;

    // VIN per USD (wei) = VIC/USDT * 100 * 1e18
    vinPerUSDWei = ethers.utils.parseUnits((vicUSDT * 100).toString(), 18);
  }catch(e){
    console.warn("refreshTicker error:", e);
    $('#vin-vnd').textContent = `1 VIN = … VND`;
  }
}

/* -------------------- THÔNG TIN VÍ & ĐĂNG KÝ -------------------- */
async function refreshBalances(){
  if(!account) return;
  // VIN
  const balVIN = await vin.balanceOf(account);
  $('#bal-vin').textContent = ethers.utils.formatUnits(balVIN, 18);
  // VIC (native)
  const balVIC = await providerWrite.getBalance(account);
  $('#bal-vic').textContent = ethers.utils.formatEther(balVIC);
  $('#addr-short').textContent = short(account);
}

async function checkRegistered(){
  if(!account){ isRegistered = false; return; }
  isRegistered = await muaban.isRegistered(account);
}

function updateTopButtons(){
  const balances = $('#balances');
  const bConnect = $('#btn-connect');
  const bReg     = $('#btn-register');
  const bCreate  = $('#btn-create');
  const bBuyer   = $('#btn-buyer-orders');
  const bSeller  = $('#btn-seller-orders');

  if(!account){
    balances.hidden = true;
    bReg.hidden = true; bCreate.hidden = true; bBuyer.hidden = true; bSeller.hidden = true;
    bConnect.textContent = "Kết nối ví";
    return;
  }
  balances.hidden = false;
  bConnect.textContent = "Đã kết nối";
  if(!isRegistered){
    bReg.hidden = false; bCreate.hidden = true; bBuyer.hidden = true; bSeller.hidden = true;
  }else{
    bReg.hidden = true; bCreate.hidden = false; bBuyer.hidden = false; bSeller.hidden = false;
  }
}

async function doRegister(){
  try{
    const fee = await muaban.PLATFORM_FEE(); // 0.001 VIN
    const allow = await vin.allowance(account, CONFIG.MUABAN_ADDR);
    if(allow.lt(fee)){
      const tx1 = await vin.approve(CONFIG.MUABAN_ADDR, fee);
      $('#btn-register').textContent = 'Đang duyệt…';
      await tx1.wait();
    }
    const tx2 = await muaban.payRegistration();
    $('#btn-register').textContent = 'Đang đăng ký…';
    await tx2.wait();
    await checkRegistered(); updateTopButtons(); await refreshBalances();
    alert('Đăng ký thành công!');
  }catch(e){
    console.error(e);
    alert('Đăng ký thất bại: ' + (e?.message || e));
  }finally{
    $('#btn-register').textContent = 'Đăng ký (0.001 VIN)';
  }
}

/* -------------------- SẢN PHẨM: LOAD & HIỂN THỊ -------------------- */
async function listProducts(){
  const list = $('#list'); list.innerHTML = '';
  $('#empty').textContent = 'Đang tải sản phẩm…';

  try{
    // Quét event ProductCreated
    const filter = muaban.filters.ProductCreated();
    const logs = await providerRead.getLogs({
      address: CONFIG.MUABAN_ADDR,
      topics: filter.topics,
      fromBlock: 0,
      toBlock: 'latest'
    });

    const ids = [...new Set(logs.map(l => muaban.interface.parseLog(l).args.productId.toString()))];
    if(ids.length === 0){ $('#empty').textContent = 'Chưa có sản phẩm nào.'; return; }
    $('#empty').textContent = '';

    for(const id of ids){
      const p = await muaban.getProduct(id);
      renderProductCard(p);
    }
  }catch(e){
    console.warn('listProducts error:', e);
    $('#empty').textContent = 'Không tải được danh sách sản phẩm (kiểm tra RPC cấu hình).';
  }
}

function renderProductCard(p){
  const id    = p.productId.toString();
  const name  = p.name;
  const unit  = '(đv)'; // UI hiển thị đơn vị người bán nhập trong name/desc (có thể nối chuỗi nếu bạn muốn)
  // Giá VND hiển thị ~ priceUsdCents * (USDT→VND)
  const priceUsdCents = Number(p.priceUsdCents.toString());
  const displayVND = usdtVND ? Math.round((priceUsdCents/100) * usdtVND) : 0;

  const active = Boolean(p.active);
  const stock  = Number(p.stock.toString());
  const seller = (p.seller||'').toLowerCase();
  const mine   = account && (seller === account.toLowerCase());
  const status = (active && stock > 0) ? 'Còn hàng' : 'Hết hàng';

  // media: ảnh/video
  const isVideo = (p.imageCID||'').endsWith('.mp4') || (p.imageCID||'').endsWith('.webm');

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="media">
      ${isVideo ? `<video src="${p.imageCID}" controls></video>` : `<img src="${p.imageCID}" alt="image" />`}
    </div>
    <div class="body">
      <div style="min-height:54px">
        <div style="font-weight:800">${esc(name)} <span class="muted mono">#${id}</span></div>
      </div>
      <div class="price">${fmtVND(displayVND)} VND / <span class="mono">${unit}</span></div>
      <div class="status ${status==='Còn hàng'?'ok':'bad'}" style="margin-top:6px">${status}</div>
      <div class="toolbar">
        ${renderActions({ mine, status, productId:id })}
      </div>
    </div>
  `;
  $('#list').appendChild(card);
  bindCardActions(card, { mine, productId:id, status, product:p });
}

function renderActions({mine,status,productId}){
  if(!account) return '';              // chưa kết nối ví
  if(!isRegistered) return '';         // chưa đăng ký
  if(mine){
    return `<button class="btn secondary" data-act="update" data-id="${productId}">Cập nhật sản phẩm</button>`;
  }else{
    return status==='Còn hàng' ? `<button class="btn" data-act="buy" data-id="${productId}">Mua</button>` : ``;
  }
}

function bindCardActions(card, ctx){
  const btnUpdate = card.querySelector('[data-act="update"]');
  const btnBuy    = card.querySelector('[data-act="buy"]');
  if(btnUpdate){ btnUpdate.addEventListener('click', () => openUpdate(ctx.product)); }
  if(btnBuy){    btnBuy.addEventListener('click', () => openBuy(ctx.product)); }
}

/* -------------------- ĐĂNG SẢN PHẨM -------------------- */
function openCreate(){
  if(!isRegistered) return alert('Bạn cần đăng ký trước.');
  $('#create-msg').textContent = '';
  $('#form-create').reset();
  openDialog('dlg-create');
}

async function submitCreate(ev){
  ev.preventDefault();
  try{
    const fd = new FormData(ev.target);
    const name   = fd.get('name');
    const image  = fd.get('imageCID');
    const unit   = fd.get('unit'); // hiện chỉ hiển thị bên ngoài, không đưa on-chain
    const priceVND = Number(fd.get('priceVND'));
    const wallet  = fd.get('revenueWallet');
    const days    = Number(fd.get('deliveryDaysMax'));

    // VND -> USD cents (xấp xỉ dựa theo usdtVND)
    const usdVND = usdtVND || 25000; // fallback
    const priceUsdCents = Math.max(1, Math.round((priceVND / usdVND) * 100));

    // Map tham số theo ABI: dùng 1 ví duy nhất => taxWallet = revenueWallet, shippingWallet = 0
    const descriptionCID = "";
    const shippingUsdCents = 0;
    const taxRateBps = 0;
    const sellerEncryptPubKey = "0x"; // tạm thời
    const stock = ethers.BigNumber.from("1000000000000000000"); // virtual large
    const active = true;

    const tx = await muaban.createProduct(
      name, descriptionCID, image,
      priceUsdCents, shippingUsdCents, taxRateBps, days,
      wallet, wallet, ethers.constants.AddressZero,
      sellerEncryptPubKey, stock, active
    );
    $('#create-msg').textContent = 'Đang gửi giao dịch…';
    await tx.wait();
    $('#create-msg').textContent = 'Đăng sản phẩm thành công.';
    closeDialog('dlg-create');
    await listProducts();
  }catch(e){
    console.error(e);
    alert('Đăng sản phẩm thất bại: ' + (e?.message || e));
  }
}

/* -------------------- CẬP NHẬT SẢN PHẨM -------------------- */
function openUpdate(p){
  $('#update-msg').textContent = '';
  const f = $('#form-update');
  f.reset();
  f.productId.value = p.productId.toString();
  // người bán nhập lại các trường cần thiết trong form
  openDialog('dlg-update');
}

async function submitUpdate(ev){
  ev.preventDefault();
  try{
    const fd = new FormData(ev.target);
    const id   = fd.get('productId');
    const priceVND = Number(fd.get('priceVND'));
    const days  = Number(fd.get('deliveryDaysMax'));
    const wallet = fd.get('revenueWallet');
    const active = (fd.get('active') === 'true');

    const p = await muaban.getProduct(id);
    const usdVND = usdtVND || 25000;
    const priceUsdCents = Math.max(1, Math.round((priceVND / usdVND) * 100));

    const shippingUsdCents = 0;
    const taxRateBps = 0;
    const stock = p.stock; // giữ nguyên
    const sellerEncryptPubKey = p.sellerEncryptPubKey || "0x";

    const tx1 = await muaban.updateProduct(
      id, priceUsdCents, shippingUsdCents, taxRateBps, days,
      wallet, wallet, ethers.constants.AddressZero, stock, sellerEncryptPubKey
    );
    $('#update-msg').textContent = 'Đang cập nhật…';
    await tx1.wait();

    if (Boolean(p.active) !== active){
      const tx2 = await muaban.setProductActive(id, active);
      await tx2.wait();
    }

    $('#update-msg').textContent = 'Đã lưu thay đổi.';
    closeDialog('dlg-update');
    await listProducts();
  }catch(e){
    console.error(e);
    alert('Cập nhật thất bại: ' + (e?.message || e));
  }
}

/* -------------------- MUA SẢN PHẨM -------------------- */
function openBuy(p){
  const f = $('#form-buy');
  f.reset();
  f.productId.value = p.productId.toString();
  f.estimateVin.value = 'Đang tính…';
  estimateTotalVin(p.productId.toString(), 1).then(v => f.estimateVin.value = v);
  $('#buy-msg').textContent = '';
  openDialog('dlg-buy');
}

$('#form-buy')?.addEventListener('change', async (e)=>{
  if(e.target.name !== 'quantity') return;
  const f = e.currentTarget;
  const id = f.productId.value;
  const qty = Math.max(1, Number(f.quantity.value || 1));
  f.estimateVin.value = 'Đang tính…';
  f.estimateVin.value = await estimateTotalVin(id, qty);
});

async function estimateTotalVin(productId, quantity){
  try{
    await refreshTicker();
    if(!vinPerUSDWei) return 'N/A';
    const q = await muaban.quoteVinForProduct(productId, quantity, vinPerUSDWei);
    return ethers.utils.formatUnits(q.vinTotal, 18) + ' VIN';
  }catch(e){
    console.warn(e);
    return 'N/A';
  }
}

async function submitBuy(ev){
  ev.preventDefault();
  try{
    if(!isRegistered) return alert('Bạn cần đăng ký trước.');
    await refreshTicker();
    if(!vinPerUSDWei) throw new Error('Không lấy được tỷ giá.');

    const fd = new FormData(ev.target);
    const id  = fd.get('productId');
    const qty = Math.max(1, Number(fd.get('quantity')));

    // Mã hóa tối thiểu (UTF-8 -> bytes). Có thể nâng cấp AES-GCM ở phiên sau.
    const payload = {
      name: fd.get('fullName'),
      phone: fd.get('phone'),
      address: fd.get('address'),
      note: fd.get('note') || ""
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const hex   = '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('');

    // Ước tính VIN cần approve đủ
    const q = await muaban.quoteVinForProduct(id, qty, vinPerUSDWei);
    const need = q.vinTotal;

    // Approve
    const allow = await vin.allowance(account, CONFIG.MUABAN_ADDR);
    if(allow.lt(need)){
      const tx1 = await vin.approve(CONFIG.MUABAN_ADDR, need);
      $('#buy-msg').textContent = 'Đang duyệt VIN…';
      await tx1.wait();
    }

    // Thanh toán
    const tx2 = await muaban.placeOrder(id, qty, vinPerUSDWei, hex);
    $('#buy-msg').textContent = 'Đang thanh toán…';
    await tx2.wait();
    $('#buy-msg').textContent = 'Đã đặt hàng thành công.';
    closeDialog('dlg-buy');
    await listProducts();
    if(account) await refreshBalances();
  }catch(e){
    console.error(e);
    alert('Thanh toán thất bại: ' + (e?.message || e));
  }
}

/* -------------------- TIM KIẾM CLIENT-SIDE -------------------- */
function doSearch(){
  const q = ($('#q').value || '').toLowerCase().trim();
  for(const card of $$('#list .card')){
    const name = card.querySelector('.body div div')?.textContent?.toLowerCase() || '';
    card.style.display = (q==='' || name.includes(q)) ? '' : 'none';
  }
}

/* -------------------- DIALOG HELPERS -------------------- */
function openDialog(id){
  const el = document.getElementById(id);
  if(!el.open) el.showModal();
}
function closeDialog(id){
  document.getElementById(id)?.close();
}

/* -------------------- LIÊN KẾT & SỰ KIỆN UI -------------------- */
function setFooterLinks(){
  $('#link-contract').href = `${CONFIG.EXPLORER}/address/${CONFIG.MUABAN_ADDR}`;
  $('#link-vin').href      = `${CONFIG.EXPLORER}/token/${CONFIG.VIN_ADDR}`;
}

function bindUIBasics(){
  $('#btn-connect').addEventListener('click', connectWallet);
  $('#btn-register').addEventListener('click', doRegister);
  $('#btn-create').addEventListener('click', openCreate);
  $('#btn-search').addEventListener('click', doSearch);
  // đóng dialog
  document.addEventListener('click', (e)=>{
    const id = e.target?.getAttribute?.('data-close');
    if(id) closeDialog(id);
  });
  // Submit forms
  $('#form-create')?.addEventListener('submit', submitCreate);
  $('#form-update')?.addEventListener('submit', submitUpdate);
  $('#form-buy')?.addEventListener('submit', submitBuy);
}

/* -------------------- REFRESH KHI KẾT NỐI VÍ -------------------- */
async function refreshAllForWallet(){
  await refreshTicker();
  await refreshBalances();
  await checkRegistered();
  updateTopButtons();
  await listProducts();
}

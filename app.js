/* ========== muaban.vin — app.js (ethers v5 UMD) ========== */
/* Mục tiêu vá lỗi:
   1) Ẩn balances khi CHƯA kết nối ví
   2) Tính VIN khi mua đúng công thức (VIC/USDT * 100; ceil theo contract)
   3) Hoạt động Đơn hàng mua / bán (quét event, hiển thị, xác nhận, hoàn tiền)
*/

/* -------------------- CẤU HÌNH -------------------- */
const CONFIG = {
  CHAIN_ID: 88, // Viction mainnet
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://scan.viction.xyz",
  MUABAN_ADDR: "0xe01e2213A899E9B3b1921673D2d13a227a8df638",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",
};

/* -------------------- TRẠNG THÁI TOÀN CỤC -------------------- */
let providerRead, providerWrite, signer, account;
let muaban, vin;
let MUABAN_ABI, VIN_ABI;

let isRegistered = false;

// Tỷ giá
let usdtVND = null;        // 1 USDT ~ ? VND (CoinGecko)
let vicUSDT = null;        // 1 VIC  ~ ? USDT (Binance)
let vinVND  = null;        // 1 VIN  ~ ? VND (floor)
let vinPerUSDWei = null;   // VIN wei per 1 USD = vicUSDT * 100 * 1e18

/* -------------------- DOM helpers -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show = (el)=> el && el.removeAttribute('hidden');
const hide = (el)=> el && el.setAttribute('hidden','');
const short = (a)=> a ? `${a.slice(0,6)}…${a.slice(-4)}` : '';
const fmtVND = (v)=> (v ?? 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g,'.');
const fmt4 = (x)=> Number(x).toFixed(4);
const esc = (s)=> (s||"").replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

/* ================================================================
   BOOT
================================================================ */
(async function boot(){
  bindUIBasics();
  await loadABI();
  await initProvidersReadOnly();
  setFooterLinks();

  // Chỉ tải tỷ giá và danh sách sản phẩm ở chế độ khách
  await refreshTicker();
  await listProducts();

  // Ẩn mọi thành phần phụ thuộc ví cho tới khi user bấm Kết nối
  updateTopButtons(); // đảm bảo balances ẩn khi account == null
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

/* ================================================================
   KẾT NỐI VÍ
================================================================ */
async function connectWallet(){
  if(!window.ethereum){ alert("Vui lòng cài ví EVM (MetaMask, OKX, Rabby…)."); return; }
  const [acc] = await window.ethereum.request({ method:'eth_requestAccounts' });
  providerWrite = new ethers.providers.Web3Provider(window.ethereum);
  signer  = providerWrite.getSigner();
  account = ethers.utils.getAddress(acc);
  muaban  = muaban.connect(signer);
  vin     = vin.connect(signer);

  // Đảm bảo chain đúng
  const net = await providerWrite.getNetwork();
  if(Number(net.chainId) !== CONFIG.CHAIN_ID){
    try{
      await window.ethereum.request({
        method:'wallet_switchEthereumChain',
        params:[{ chainId: '0x'+CONFIG.CHAIN_ID.toString(16) }]
      });
    }catch(e){
      alert("Hãy thêm/chuyển sang mạng Viction (chainId 88) trong ví.");
      console.warn(e);
      return;
    }
  }

  await refreshAllForWallet();

  // Lắng nghe thay đổi account/chain
  if(window.ethereum && !window._muaban_listeners){
    window._muaban_listeners = true;
    window.ethereum.on('accountsChanged', ()=> location.reload());
    window.ethereum.on('chainChanged', ()=> location.reload());
  }
}

async function refreshAllForWallet(){
  await checkRegistered();
  await refreshBalances(); // chỉ gọi sau khi có account
  updateTopButtons();
  await listProducts(); // render lại để hiện nút Mua/Cập nhật
}

/* ================================================================
   TỶ GIÁ
   - usdtVND: từ CoinGecko
   - vicUSDT: từ Binance
   - vinPerUSDWei = vicUSDT * 100 * 1e18
   - vinVND = floor(vicUSDT * 100 * usdtVND)
================================================================ */
async function refreshTicker(){
  try{
    const gecko = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd").then(r=>r.json());
    usdtVND = Number(gecko?.tether?.vnd || 0);

    const bin = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT").then(r=>r.json());
    vicUSDT = Number(bin?.price || 0);

    vinPerUSDWei = ethers.utils.parseUnits((vicUSDT * 100).toString(), 18);
    vinVND = Math.floor(vicUSDT * 100 * usdtVND);

    $('#vin-vnd').textContent = Number.isFinite(vinVND) && vinVND>0
      ? `1 VIN = ${fmtVND(vinVND)} VND`
      : `1 VIN = … VND`;
  }catch(e){
    console.warn('refreshTicker error', e);
    $('#vin-vnd').textContent = `1 VIN = … VND`;
  }
}

/* ================================================================
   BALANCES & ĐĂNG KÝ
================================================================ */
async function refreshBalances(){
  if(!account || !providerWrite) return;
  const balVIN = await vin.balanceOf(account);
  const balVIC = await providerWrite.getBalance(account);
  $('#bal-vin').textContent = fmt4(ethers.utils.formatUnits(balVIN,18));
  $('#bal-vic').textContent = fmt4(ethers.utils.formatEther(balVIC));
  $('#addr-short').textContent = short(account);
}

async function checkRegistered(){
  isRegistered = account ? await muaban.isRegistered(account) : false;
}

function updateTopButtons(){
  const balances = $('#balances');
  const bConnect = $('#btn-connect');
  const bReg     = $('#btn-register');
  const bCreate  = $('#btn-create');
  const bBuyer   = $('#btn-buyer-orders');
  const bSeller  = $('#btn-seller-orders');

  if(!account){
    hide(balances);
    hide(bReg); hide(bCreate); hide(bBuyer); hide(bSeller);
    if(bConnect) bConnect.textContent = 'Kết nối ví';
    return;
  }
  show(balances);
  if(bConnect) bConnect.textContent = 'Đã kết nối';

  if(!isRegistered){
    show(bReg);
    hide(bCreate); hide(bBuyer); hide(bSeller);
  }else{
    hide(bReg);
    show(bCreate); show(bBuyer); show(bSeller);
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

/* ================================================================
   DANH SÁCH SẢN PHẨM
   - Quét event ProductCreated để lấy ID
   - Lấy getProduct(id) -> render card
================================================================ */
async function listProducts(){
  const wrap = $('#list'); wrap.innerHTML = '';
  $('#empty').textContent = 'Đang tải sản phẩm…';
  try{
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
    console.warn('listProducts error', e);
    $('#empty').textContent = 'Không tải được danh sách sản phẩm.';
  }
}

function renderProductCard(p){
  const id    = p.productId.toString();
  const name  = p.name;
  const priceUsdCents = Number(p.priceUsdCents.toString());
  const displayVND = usdtVND ? Math.round((priceUsdCents/100) * usdtVND) : 0;
  const active = Boolean(p.active);
  const stock  = Number(p.stock.toString());
  const seller = (p.seller||'').toLowerCase();
  const mine   = account && (seller === account.toLowerCase());
  const status = (active && stock > 0) ? 'Còn hàng' : 'Hết hàng';
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
      <div class="price">${fmtVND(displayVND)} VND</div>
      <div class="status ${status==='Còn hàng'?'ok':'bad'}" style="margin-top:6px">${status}</div>
      <div class="toolbar">
        ${renderActions({ mine, status, productId:id })}
      </div>
    </div>
  `;
  $('#list').appendChild(card);
  bindCardActions(card, { mine, product:p, status });
}

function renderActions({ mine, status, productId }){
  if(!account) return '';         // chưa kết nối ví
  if(!isRegistered) return '';    // chưa đăng ký
  if(mine){
    return `<button class="btn secondary" data-act="update" data-id="${productId}">Cập nhật sản phẩm</button>`;
  }else{
    return status==='Còn hàng' ? `<button class="btn" data-act="buy" data-id="${productId}">Mua</button>` : ``;
  }
}

function bindCardActions(card, ctx){
  const btnUpdate = card.querySelector('[data-act="update"]');
  const btnBuy    = card.querySelector('[data-act="buy"]');
  if(btnUpdate) btnUpdate.addEventListener('click', ()=> openUpdate(ctx.product));
  if(btnBuy)    btnBuy.addEventListener('click', ()=> openBuy(ctx.product));
}

/* ================================================================
   TÍNH TOÁN VIN THEO CONTRACT (ước lượng hiển thị)
   - Contract dùng ceil cho từng thành phần USD cents -> VIN
================================================================ */
function ceilDiv(n, d){ return Math.floor((BigInt(n) + BigInt(d-1)) / BigInt(d)); }

function estimateVinTotalWei(p, qty){
  if(!vinPerUSDWei) return null;
  const q = BigInt(qty);
  const priceUsdCentsAll = BigInt(p.priceUsdCents.toString()) * q;
  const shipUsdCents     = BigInt(p.shippingUsdCents.toString());
  const taxUsdCents      = ceilDiv(priceUsdCentsAll * BigInt(p.taxRateBps), 10000n); // bps

  const vpu = BigInt(vinPerUSDWei.toString()); // VIN wei per 1 USD

  // ceil(usdCents * vinPerUSD / 100)
  const vinRevenue = ceilDiv(priceUsdCentsAll * vpu, 100n);
  const vinShip    = ceilDiv(shipUsdCents * vpu, 100n);
  const vinTax     = ceilDiv(taxUsdCents * vpu, 100n);

  return vinRevenue + vinShip + vinTax;
}

/* ================================================================
   ĐĂNG SẢN PHẨM
================================================================ */
function openCreate(){
  if(!isRegistered) return alert('Bạn cần đăng ký trước.');
  $('#create-msg').textContent = '';
  $('#form-create').reset();
  $('#dlg-create').showModal();
}

async function submitCreate(ev){
  ev.preventDefault();
  try{
    const fd = new FormData(ev.target);
    const name   = fd.get('name');
    const image  = fd.get('imageCID');
    const unit   = fd.get('unit'); // hiện chỉ hiển thị ngoài UI nếu bạn muốn kèm vào name
    const priceVND = Number(fd.get('priceVND'));
    const wallet  = fd.get('revenueWallet');
    const days    = Number(fd.get('deliveryDaysMax'));

    // VND -> USD cents (làm tròn, dựa theo usdtVND)
    const usdVND = usdtVND || 25000;
    const priceUsdCents = Math.max(1, Math.round((priceVND / usdVND) * 100));

    // Map tham số theo ABI (đơn giản hoá)
    const descriptionCID = "";
    const shippingUsdCents = 0;
    const taxRateBps = 0;
    const sellerEncryptPubKey = "0x";
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
    $('#create-msg').textContent = 'Đăng sản phẩm thành công!';
    $('#dlg-create').close();
    await listProducts();
  }catch(e){
    console.error(e);
    $('#create-msg').textContent = 'Lỗi: ' + (e?.message || e);
  }
}

/* ================================================================
   CẬP NHẬT SẢN PHẨM
================================================================ */
function openUpdate(p){
  $('#update-msg').textContent = '';
  $('#form-update').reset();
  $('#form-update [name=productId]').value = p.productId.toString();

  // Gợi ý giá & thông số hiện tại
  const usdVND = usdtVND || 25000;
  const curVND = Math.round((Number(p.priceUsdCents)/100) * usdVND);
  $('#form-update [name=priceVND]').value = curVND;
  $('#form-update [name=deliveryDaysMax]').value = Number(p.deliveryDaysMax.toString());
  $('#form-update [name=revenueWallet]').value = p.revenueWallet;
  $('#form-update [name=active]').value = p.active ? 'true' : 'false';

  $('#dlg-update').showModal();
}

async function submitUpdate(ev){
  ev.preventDefault();
  try{
    const fd = new FormData(ev.target);
    const productId = fd.get('productId');
    const priceVND  = Number(fd.get('priceVND'));
    const days      = Number(fd.get('deliveryDaysMax'));
    const wallet    = fd.get('revenueWallet');
    const active    = fd.get('active') === 'true';

    const usdVND = usdtVND || 25000;
    const priceUsdCents = Math.max(1, Math.round((priceVND / usdVND) * 100));

    // Giữ nguyên các trường khác theo hướng tối giản
    const shippingUsdCents = 0;
    const taxRateBps = 0;
    const stock = ethers.BigNumber.from("1000000000000000000");
    const sellerEncryptPubKey = "0x";

    const tx = await muaban.updateProduct(
      productId,
      priceUsdCents, shippingUsdCents, taxRateBps, days,
      wallet, wallet, ethers.constants.AddressZero,
      stock, sellerEncryptPubKey
    );
    $('#update-msg').textContent = 'Đang gửi giao dịch…';
    await tx.wait();

    // Bật/tắt bán nếu cần
    const p = await muaban.getProduct(productId);
    if(Boolean(p.active) !== active){
      const tx2 = await muaban.setProductActive(productId, active);
      $('#update-msg').textContent = 'Đang cập nhật trạng thái…';
      await tx2.wait();
    }

    $('#update-msg').textContent = 'Cập nhật thành công!';
    $('#dlg-update').close();
    await listProducts();
  }catch(e){
    console.error(e);
    $('#update-msg').textContent = 'Lỗi: ' + (e?.message || e);
  }
}

/* ================================================================
   MUA SẢN PHẨM
================================================================ */
function openBuy(p){
  if(!isRegistered) return alert('Bạn cần đăng ký trước.');
  $('#buy-msg').textContent = '';
  $('#form-buy').reset();
  $('#form-buy [name=productId]').value = p.productId.toString();
  $('#dlg-buy').showModal();

  // render tổng VIN theo số lượng
  const qtyInput = $('#buy-qty');
  const totalEl  = $('#buy-total-vin');

  const renderTotal = ()=>{
    const qty = Math.max(1, Number(qtyInput.value || 1));
    const totalWei = estimateVinTotalWei(p, qty);
    if(!totalWei){ totalEl.textContent = '…'; return; }
    totalEl.textContent = ethers.utils.formatUnits(totalWei.toString(), 18);
  };
  qtyInput.addEventListener('input', renderTotal);
  renderTotal();
}

async function submitBuy(ev){
  ev.preventDefault();
  try{
    if(!vinPerUSDWei) await refreshTicker(); // phòng hờ
    const fd = new FormData(ev.target);
    const productId = fd.get('productId');
    const qty       = Math.max(1, Number(fd.get('quantity')||1));

    // Shipping info => mã hoá thực sự sẽ làm ở phiên nâng cấp; tạm gói JSON rồi toBytes
    const shipInfo = {
      fullName: fd.get('fullName'),
      phone:    fd.get('phone'),
      address:  fd.get('address'),
      note:     fd.get('note') || ''
    };
    const ciphertext = ethers.utils.hexlify(ethers.utils.toUtf8Bytes(JSON.stringify(shipInfo)));

    // Approve đủ VIN theo ước lượng (có ceil ở contract, thêm đệm 1%)
    const p = await muaban.getProduct(productId);
    const estWei = estimateVinTotalWei(p, qty);
    if(!estWei) throw new Error('Không có tỷ giá. Vui lòng tải lại trang.');
    const allowance = await vin.allowance(account, CONFIG.MUABAN_ADDR);
    const need = ethers.BigNumber.from(estWei.toString()).mul(101).div(100); // +1%
    if(allowance.lt(need)){
      const tx1 = await vin.approve(CONFIG.MUABAN_ADDR, need);
      $('#buy-msg').textContent = 'Đang duyệt VIN…';
      await tx1.wait();
    }

    // placeOrder(productId, quantity, vinPerUSD, ciphertext)
    const tx2 = await muaban.placeOrder(
      productId,
      qty,
      vinPerUSDWei.toString(),
      ciphertext
    );
    $('#buy-msg').textContent = 'Đang gửi đơn hàng…';
    await tx2.wait();

    $('#buy-msg').textContent = 'Đặt hàng thành công!';
    $('#dlg-buy').close();
    await listBuyerOrders(); // cập nhật bảng đơn mua
  }catch(e){
    console.error(e);
    $('#buy-msg').textContent = 'Lỗi: ' + (e?.message || e);
  }
}

/* ================================================================
   ĐƠN HÀNG — BUYER & SELLER
   - Dùng event OrderPlaced để lấy danh sách orderId liên quan
================================================================ */
async function listBuyerOrders(){
  if(!account) return;
  const body = $('#buyer-orders-body');
  body.innerHTML = '<tr><td colspan="7">Đang tải…</td></tr>';

  try{
    const filter = muaban.filters.OrderPlaced(null, null, account);
    const logs = await providerRead.getLogs({
      address: CONFIG.MUABAN_ADDR,
      topics: filter.topics,
      fromBlock: 0,
      toBlock: 'latest'
    });
    if(logs.length === 0){
      body.innerHTML = '<tr><td colspan="7">Chưa có đơn hàng.</td></tr>';
      return;
    }
    body.innerHTML = '';
    for(const l of logs){
      const ev = muaban.interface.parseLog(l);
      const orderId = ev.args.orderId.toString();
      const o = await muaban.getOrder(orderId);
      const p = await muaban.getProduct(o.productId.toString());
      body.appendChild(renderOrderRowBuyer(o, p));
    }
  }catch(e){
    console.error(e);
    body.innerHTML = '<tr><td colspan="7">Không tải được đơn hàng.</td></tr>';
  }
}

function renderOrderRowBuyer(o, p){
  const tr = document.createElement('tr');
  const deadline = new Date(Number(o.deadline.toString())*1000);
  const statusStr = ['NONE','PLACED','RELEASED','REFUNDED'][Number(o.status)];

  tr.innerHTML = `
    <td class="mono">#${o.orderId}</td>
    <td>${esc(p.name)}</td>
    <td>${o.quantity}</td>
    <td class="mono">${ethers.utils.formatUnits(o.vinAmountTotal,18)}</td>
    <td>${deadline.toLocaleString()}</td>
    <td>${statusStr}</td>
    <td>
      ${Number(o.status)===1 ? `
        <button class="btn secondary" data-act="confirm" data-id="${o.orderId}">Xác nhận đã nhận</button>
        <button class="btn ghost" data-act="refund" data-id="${o.orderId}">Hoàn tiền</button>
      ` : ''}
    </td>
  `;

  // action
  const btnC = tr.querySelector('[data-act="confirm"]');
  const btnR = tr.querySelector('[data-act="refund"]');
  if(btnC) btnC.addEventListener('click', ()=> confirmReceipt(o.orderId.toString(), tr));
  if(btnR) btnR.addEventListener('click', ()=> refundIfExpired(o.orderId.toString(), tr));
  return tr;
}

async function listSellerOrders(){
  if(!account) return;
  const body = $('#seller-orders-body');
  body.innerHTML = '<tr><td colspan="7">Đang tải…</td></tr>';

  try{
    const filter = muaban.filters.OrderPlaced(null, null, null, account);
    const logs = await providerRead.getLogs({
      address: CONFIG.MUABAN_ADDR,
      topics: filter.topics,
      fromBlock: 0,
      toBlock: 'latest'
    });
    if(logs.length === 0){
      body.innerHTML = '<tr><td colspan="7">Chưa có đơn hàng.</td></tr>';
      return;
    }
    body.innerHTML = '';
    for(const l of logs){
      const ev = muaban.interface.parseLog(l);
      const orderId = ev.args.orderId.toString();
      const o = await muaban.getOrder(orderId);
      const p = await muaban.getProduct(o.productId.toString());
      body.appendChild(renderOrderRowSeller(o, p));
    }
  }catch(e){
    console.error(e);
    body.innerHTML = '<tr><td colspan="7">Không tải được đơn hàng.</td></tr>';
  }
}

function renderOrderRowSeller(o, p){
  const tr = document.createElement('tr');
  const deadline = new Date(Number(o.deadline.toString())*1000);
  const statusStr = ['NONE','PLACED','RELEASED','REFUNDED'][Number(o.status)];

  tr.innerHTML = `
    <td class="mono">#${o.orderId}</td>
    <td class="mono">${short(o.buyer)}</td>
    <td>${esc(p.name)}</td>
    <td>${o.quantity}</td>
    <td class="mono">${ethers.utils.formatUnits(o.vinAmountTotal,18)}</td>
    <td>${deadline.toLocaleString()}</td>
    <td>${statusStr}</td>
  `;
  return tr;
}

async function confirmReceipt(orderId, row){
  try{
    const tx = await muaban.confirmReceipt(orderId);
    if(row) row.querySelectorAll('button').forEach(b=> b.disabled = true);
    await tx.wait();
    await listBuyerOrders();
    alert('Đã xác nhận nhận hàng.');
  }catch(e){
    console.error(e);
    alert('Lỗi xác nhận: ' + (e?.message || e));
  }
}

async function refundIfExpired(orderId, row){
  try{
    const tx = await muaban.refundIfExpired(orderId);
    if(row) row.querySelectorAll('button').forEach(b=> b.disabled = true);
    await tx.wait();
    await listBuyerOrders();
    alert('Đã thực hiện hoàn tiền (nếu quá hạn).');
  }catch(e){
    console.error(e);
    alert('Lỗi hoàn tiền: ' + (e?.message || e));
  }
}

/* ================================================================
   TIỆN ÍCH KHÁC
================================================================ */
function setFooterLinks(){
  $('#link-contract').href = `${CONFIG.EXPLORER}/address/${CONFIG.MUABAN_ADDR}`;
  $('#link-vin').href      = `${CONFIG.EXPLORER}/token/${CONFIG.VIN_ADDR}`;
}

/* ================================================================
   BIND UI
================================================================ */
function bindUIBasics(){
  // Connect
  $('#btn-connect')?.addEventListener('click', connectWallet);

  // Register
  $('#btn-register')?.addEventListener('click', doRegister);

  // Create / Update
  $('#btn-create')?.addEventListener('click', openCreate);
  $('#form-create')?.addEventListener('submit', submitCreate);

  $('#form-update')?.addEventListener('submit', submitUpdate);

  // Buy
  $('#form-buy')?.addEventListener('submit', submitBuy);

  // Orders
  $('#btn-buyer-orders')?.addEventListener('click', ()=>{ $('#dlg-buyer-orders').showModal(); listBuyerOrders(); });
  $('#btn-seller-orders')?.addEventListener('click', ()=>{ $('#dlg-seller-orders').showModal(); listSellerOrders(); });

  // Search (đơn giản: filter theo tên đã load)
  $('#btn-search')?.addEventListener('click', ()=>{
    const q = ($('#q')?.value || '').toLowerCase().trim();
    $$('#list .card').forEach(card=>{
      const name = (card.querySelector('.body div[style]')?.textContent || '').toLowerCase();
      card.style.display = name.includes(q) ? '' : 'none';
    });
  });
}

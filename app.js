/* =========================================================
   muaban.vin — app.js  (ethers v5 UMD đã nhúng trong index.html)
   - Contract: MuabanVND (priceVND, pay in VIN by VIN/VND rate)
   - Ẩn số dư khi CHƯA kết nối ví
   - Tính VIN phải trả: vinTotal = ceil(priceVND * qty * vinPerVNDWei / 1)
   - Đơn hàng: liệt kê, xác nhận, hoàn tiền khi quá hạn
   ========================================================= */

/* -------------------- CẤU HÌNH -------------------- */
const CONFIG = {
  CHAIN_ID: 88, // Viction mainnet
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://scan.viction.xyz",

  // ĐÃ DEPLOY (bạn đưa ở phần trước)
  MUABAN_ADDR: "0xcC8bb4278FD8321830450460dE9E2FB743d08368",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",
};

/* -------------------- TRẠNG THÁI TOÀN CỤC -------------------- */
let providerRead, providerWrite, signer, account;
let muaban, vin;
let MUABAN_ABI, VIN_ABI;

// Tỷ giá
let usdtVND = null;          // 1 USDT -> ? VND (Coingecko)
let vicUSDT = null;          // 1 VIC  -> ? USDT (Binance)
let vinVND  = null;          // 1 VIN  -> ? VND (floor)
let vinPerUSDWei = null;     // VIN wei per 1 USD = vicUSDT * 100 * 1e18
let vinPerVNDWei = null;     // VIN wei per 1 VND = vinPerUSDWei / usdtVND

/* -------------------- DOM helpers -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show = (el)=> el && el.removeAttribute('hidden');
const hide = (el)=> el && el.setAttribute('hidden','');
const short = (a)=> a ? `${a.slice(0,6)}…${a.slice(-4)}` : '';
const fmtVND = (n)=> Number(n||0).toLocaleString("vi-VN");
const esc = (s)=> (s||"").replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

/* ================================================================
   BOOT
================================================================ */
(async function boot(){
  bindUIBasics();
  await loadABI();
  await initProvidersReadOnly();
  await refreshTicker();    // lấy 1 VIN = ? VND
  await listProducts();     // hiển thị sản phẩm (giá theo VND đã lưu trong contract)

  // Ẩn/hiện top buttons đúng trạng thái (chưa kết nối ví -> ẩn balances)
  updateTopButtons();
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

  await refreshBalances();  // chỉ sau khi có account
  updateTopButtons();
  await listProducts();     // render lại để hiện nút Mua/Cập nhật theo quyền

  // Lắng nghe thay đổi account/chain
  if(window.ethereum && !window._muaban_listeners){
    window._muaban_listeners = true;
    window.ethereum.on('accountsChanged', ()=> location.reload());
    window.ethereum.on('chainChanged', ()=> location.reload());
  }
}

/* ================================================================
   TỶ GIÁ
   - usdtVND: từ CoinGecko
   - vicUSDT: từ Binance
   - vinPerUSDWei = vicUSDT * 100 * 1e18
   - vinPerVNDWei = vinPerUSDWei / usdtVND
   - vinVND = floor(vicUSDT * 100 * usdtVND)
================================================================ */
async function refreshTicker(){
  try{
    const gecko = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd").then(r=>r.json());
    usdtVND = Number(gecko?.tether?.vnd || 0);

    const bin = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT").then(r=>r.json());
    vicUSDT = Number(bin?.price || 0);

    // VIN = 100 VIC (quy ước của hệ thống này)
    vinPerUSDWei = ethers.utils.parseUnits((vicUSDT * 100).toString(), 18);
    vinVND = Math.floor(vicUSDT * 100 * usdtVND);

    // VIN wei per 1 VND = vinPerUSDWei / usdtVND
    if(usdtVND > 0){
      vinPerVNDWei = vinPerUSDWei.div(ethers.BigNumber.from(Math.round(usdtVND).toString()));
    }else{
      vinPerVNDWei = null;
    }

    $('#vin-vnd').textContent = Number.isFinite(vinVND) && vinVND>0
      ? `1 VIN = ${fmtVND(vinVND)} VND`
      : `1 VIN = … VND`;
  }catch(e){
    console.warn('refreshTicker error', e);
    $('#vin-vnd').textContent = `1 VIN = … VND`;
  }
}

/* ================================================================
   BALANCES
================================================================ */
async function refreshBalances(){
  if(!account || !providerWrite) return;
  const balVIN = await vin.balanceOf(account);
  const balVIC = await providerWrite.getBalance(account);
  $('#bal-vin').textContent = Number(ethers.utils.formatUnits(balVIN,18)).toFixed(4);
  $('#bal-vic').textContent = Number(ethers.utils.formatEther(balVIC)).toFixed(4);
  $('#addr-short').textContent = short(account);
}

function updateTopButtons(){
  const balances = $('#balances');
  const bConnect = $('#btn-connect');
  const bCreate  = $('#btn-create');
  const bBuyer   = $('#btn-buyer-orders');
  const bSeller  = $('#btn-seller-orders');
  const bRegister= $('#btn-register'); // placeholder nếu bạn muốn dùng phí đăng ký

  if(!account){
    hide(balances);
    hide(bCreate); hide(bBuyer); hide(bSeller);
    if(bRegister) hide(bRegister);
    if(bConnect) bConnect.textContent = 'Kết nối ví';
    return;
  }
  show(balances);
  if(bConnect) bConnect.textContent = 'Đã kết nối';

  // Bản hợp đồng mới không yêu cầu đăng ký bắt buộc → ẩn nút
  if(bRegister) hide(bRegister);
  show(bCreate); show(bBuyer); show(bSeller);
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
  const priceVND = Number(p.priceVND.toString());
  const active = Boolean(p.active);
  const stock  = Number(p.stock.toString());
  const seller = (p.seller||'').toLowerCase();
  const mine   = account && (seller === account?.toLowerCase());
  const status = (active && stock > 0) ? 'Còn hàng' : 'Hết hàng';
  const isVideo = (p.imageCID||'').endsWith('.mp4') || (p.imageCID||'').endsWith('.webm');

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    ${isVideo
      ? `<video src="${p.imageCID}" controls style="width:100%;height:180px;object-fit:cover"></video>`
      : `<img src="${p.imageCID}" alt="image" />`}
    <div class="body">
      <h3>${esc(name)} <span class="muted mono">#${id}</span></h3>
      <div class="muted mono" style="word-break:break-all">${esc(p.imageCID)}</div>
      <div class="price">${fmtVND(priceVND)} VND</div>
      <div class="muted">${status} • giao tối đa ${p.deliveryDaysMax} ngày</div>
      <div class="actions">
        ${renderActions({ mine, status, productId:id })}
      </div>
    </div>
  `;
  $('#list').appendChild(card);
  bindCardActions(card, { mine, product:p, status });
}

function renderActions({ mine, status, productId }){
  if(!account) return ''; // chưa kết nối ví
  if(mine){
    return `<button class="btn ghost" data-act="update" data-id="${productId}">Cập nhật</button>`;
  }else{
    return status==='Còn hàng' ? `<button class="btn secondary" data-act="buy" data-id="${productId}">Mua</button>` : ``;
  }
}

function bindCardActions(card, ctx){
  const btnUpdate = card.querySelector('[data-act="update"]');
  const btnBuy    = card.querySelector('[data-act="buy"]');
  if(btnUpdate) btnUpdate.addEventListener('click', ()=> openUpdate(ctx.product));
  if(btnBuy)    btnBuy.addEventListener('click', ()=> openBuy(ctx.product));
}

/* ================================================================
   TÍNH TOÁN VIN (VIN/VND)
   - vinPerVNDWei: VIN wei cho 1 VND (đã tính ở refreshTicker)
   - Tổng VIN wei = ceil(priceVND * qty * vinPerVNDWei)
================================================================ */
function estimateVinTotalWei(priceVND, qty){
  if(!vinPerVNDWei) return null;
  const q = ethers.BigNumber.from(qty.toString());
  const price = ethers.BigNumber.from(priceVND.toString()); // VND
  const perVND = ethers.BigNumber.from(vinPerVNDWei.toString()); // VIN wei / VND

  // vin = price * qty * perVND (đã ở đơn vị wei, không cần chia)
  const wei = price.mul(q).mul(perVND);
  // ceil(…/1) = chính nó, vì perVND đã là wei chính xác; thêm 1% đệm khi approve ở submitBuy
  return wei;
}

/* ================================================================
   ĐĂNG SẢN PHẨM
================================================================ */
function openCreate(){
  $('#create-msg').textContent = '';
  $('#form-create').reset();
  $('#dlg-create').showModal();
}

async function submitCreate(ev){
  ev.preventDefault();
  try{
    if(!account) return alert('Hãy kết nối ví trước.');
    const fd = new FormData(ev.target);
    const name   = fd.get('name');
    const image  = fd.get('imageCID');
    const priceVND = Number(fd.get('priceVND'));
    const wallet  = fd.get('payoutWallet');
    const days    = Number(fd.get('deliveryDaysMax'));

    const descriptionCID = "";
    const stock = ethers.BigNumber.from("1000000000000000000"); // virtual large
    const active = true;

    const tx = await muaban.createProduct(
      name, descriptionCID, image,
      priceVND, days, wallet, stock, active
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
  $('#form-update [name=priceVND]').value = Number(p.priceVND.toString());
  $('#form-update [name=deliveryDaysMax]').value = Number(p.deliveryDaysMax.toString());
  $('#form-update [name=payoutWallet]').value = p.payoutWallet;
  $('#form-update [name=active]').value = p.active ? 'true' : 'false';
  $('#dlg-update').showModal();
}

async function submitUpdate(ev){
  ev.preventDefault();
  try{
    if(!account) return alert('Hãy kết nối ví trước.');
    const fd = new FormData(ev.target);
    const productId = fd.get('productId');
    const priceVND  = Number(fd.get('priceVND'));
    const days      = Number(fd.get('deliveryDaysMax'));
    const wallet    = fd.get('payoutWallet');
    const active    = fd.get('active') === 'true';

    const stock = ethers.BigNumber.from("1000000000000000000");

    const tx = await muaban.updateProduct(
      productId, priceVND, days, wallet, stock, active
    );
    $('#update-msg').textContent = 'Đang gửi giao dịch…';
    await tx.wait();

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
  if(!account) return alert('Hãy kết nối ví trước.');
  if(!vinPerVNDWei) return alert('Chưa có tỷ giá VIN/VND. Vui lòng tải lại trang.');
  $('#buy-msg').textContent = '';
  $('#form-buy').reset();
  $('#form-buy [name=productId]').value = p.productId.toString();
  $('#dlg-buy').showModal();

  // render tổng VIN theo số lượng
  const qtyInput = $('#buy-qty');
  const totalEl  = $('#buy-total-vin');

  const renderTotal = ()=>{
    const qty = Math.max(1, Number(qtyInput.value || 1));
    const estWei = estimateVinTotalWei(Number(p.priceVND.toString()), qty);
    if(!estWei){ totalEl.textContent = '…'; return; }
    totalEl.textContent = ethers.utils.formatUnits(estWei.toString(), 18);
  };
  qtyInput.addEventListener('input', renderTotal);
  renderTotal();
}

async function submitBuy(ev){
  ev.preventDefault();
  try{
    if(!vinPerVNDWei) await refreshTicker();
    const fd = new FormData(ev.target);
    const productId = fd.get('productId');
    const qty       = Math.max(1, Number(fd.get('quantity')||1));

    // Ước lượng VIN & approve (thêm đệm 1%)
    const p = await muaban.getProduct(productId);
    const estWei = estimateVinTotalWei(Number(p.priceVND.toString()), qty);
    if(!estWei) throw new Error('Không có tỷ giá. Vui lòng tải lại trang.');
    const allowance = await vin.allowance(account, CONFIG.MUABAN_ADDR);
    const need = ethers.BigNumber.from(estWei.toString()).mul(101).div(100); // +1%
    if(allowance.lt(need)){
      const tx1 = await vin.approve(CONFIG.MUABAN_ADDR, need);
      $('#buy-msg').textContent = 'Đang duyệt VIN…';
      await tx1.wait();
    }

    // placeOrder(productId, quantity, vinPerVNDWei)
    const tx2 = await muaban.placeOrder(
      productId,
      qty,
      vinPerVNDWei.toString()
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
   - OrderPlaced(orderId indexed, productId indexed, buyer indexed, qty, vinAmount)
   - Buyer: lọc theo buyer = account (topic)
   - Seller: lọc tất cả, sau đó lọc theo product.seller == account
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
    <td class="mono">${Number(ethers.utils.formatUnits(o.vinAmount,18)).toFixed(6)}</td>
    <td>${deadline.toLocaleString()}</td>
    <td>${statusStr}</td>
    <td>
      ${Number(o.status)===1 ? `
        <button class="btn ghost" data-act="confirm" data-id="${o.orderId}">Xác nhận đã nhận</button>
        <button class="btn" data-act="refund" data-id="${o.orderId}">Hoàn tiền</button>
      ` : ''}
    </td>
  `;

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
    // Lấy toàn bộ OrderPlaced, sau đó lọc theo seller
    const filter = muaban.filters.OrderPlaced();
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
      if((p.seller||'').toLowerCase() !== account.toLowerCase()) continue;
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
    <td class="mono">${Number(ethers.utils.formatUnits(o.vinAmount,18)).toFixed(6)}</td>
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
function bindUIBasics(){
  // Connect
  $('#btn-connect')?.addEventListener('click', connectWallet);

  // Create / Update
  $('#btn-create')?.addEventListener('click', openCreate);
  $('#form-create')?.addEventListener('submit', submitCreate);
  $('#form-update')?.addEventListener('submit', submitUpdate);

  // Buy
  $('#form-buy')?.addEventListener('submit', submitBuy);

  // Orders
  $('#btn-buyer-orders')?.addEventListener('click', ()=>{ $('#dlg-buyer-orders').showModal(); listBuyerOrders(); });
  $('#btn-seller-orders')?.addEventListener('click', ()=>{ $('#dlg-seller-orders').showModal(); listSellerOrders(); });

  // Search (lọc theo tên, client-side)
  $('#btn-search')?.addEventListener('click', ()=>{
    const q = ($('#q')?.value || '').toLowerCase().trim();
    $$('#list .card').forEach(card=>{
      const name = (card.querySelector('h3')?.textContent || '').toLowerCase();
      card.style.display = name.includes(q) ? '' : 'none';
    });
  });
}

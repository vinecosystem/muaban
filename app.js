/* muaban app.js — connect/disconnect, balances, registration, escrow */
(() => {
  'use strict';

  // ---------- Helpers ----------
  const $  = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const safeText = (el, t) => { if (el) el.textContent = t; };
  const safeShow = (el, show) => { if (!el) return; el.classList.toggle('hidden', !show); };
  const safeHref = (el, url) => { if (el && url) el.setAttribute('href', url); };
  const short = (a)=> a ? (a.slice(0,6)+'…'+a.slice(-4)) : '—';

  // UI refs (được gán khi DOM ready)
  let ui = {};

  // ---------- Config ----------
  const CFG = (window.MUABAN_CONFIG || {});
  const MUABAN_ADDRESS    = CFG.MUABAN_ADDRESS;
  const VIN_TOKEN_ADDRESS = CFG.VIN_TOKEN;
  const VIC_CHAIN_ID_HEX  = CFG.VIC_CHAIN_ID_HEX || '0x58';
  const VIC_NAME          = CFG.VIC_NAME || 'Viction Mainnet';

  // ethers v5 (UMD) đã được <script defer> trong index.html
  const ethers = window.ethers;

  // ---------- App state ----------
  const app = {
    abis: { muaban: null, vin: null },
    provider: null,
    signer: null,
    account: null,
    chainIdHex: null,
    contracts: { muaban: null, vin: null },
    vinDecimals: 18,
  };
  window.muabanApp = app; // để debug nếu cần

  function fmtToken(raw, decimals=18, maxFrac=4){
    try{
      const s = ethers.utils.formatUnits(raw||0, decimals);
      const [i,f=''] = s.split('.');
      const f4 = f.slice(0, maxFrac);
      return f4 ? `${i}.${f4}` : i;
    }catch{ return '0'; }
  }

  // ---------- Load ABIs ----------
  async function loadAbis(){
    const muabanPath = CFG.MUABAN_ABI_PATH || './Muaban_ABI.json';
    const vinPath    = './VinToken_ABI.json';
    const [r1, r2] = await Promise.all([
      fetch(muabanPath, { cache: 'no-store' }),
      fetch(vinPath,    { cache: 'no-store' }),
    ]);
    app.abis.muaban = await r1.json();
    app.abis.vin    = await r2.json();
  }

  // ---------- Ensure Viction chain ----------
  async function ensureVictionChain(){
    const cur = await window.ethereum.request({ method: 'eth_chainId' });
    app.chainIdHex = cur;
    if (cur === VIC_CHAIN_ID_HEX) return;

    try{
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: VIC_CHAIN_ID_HEX }]
      });
      app.chainIdHex = VIC_CHAIN_ID_HEX;
    }catch(switchErr){
      try{
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: VIC_CHAIN_ID_HEX,
            chainName: VIC_NAME,
            nativeCurrency: { name: 'VIC', symbol: 'VIC', decimals: 18 },
            rpcUrls: ['https://rpc.viction.xyz'],
            blockExplorerUrls: ['https://vicscan.xyz/'],
          }]
        });
        app.chainIdHex = VIC_CHAIN_ID_HEX;
      }catch(addErr){
        throw new Error('Không thể chuyển sang mạng Viction.');
      }
    }
  }

  // ---------- Trạng thái UI ----------
  function setConnectedUI(connected){
    document.body.classList.toggle('connected', connected);
    safeShow(ui.walletInfo, connected);
    updateConnectButton(connected);
  }
  function setRegisteredUI(registered){
    document.body.classList.toggle('registered', registered);
    ui.btnRegister && ui.btnRegister.classList.toggle('hidden', !!registered);
  }

  // ---------- Nút kết nối ↔ ngắt kết nối ----------
  function updateConnectButton(isConnected){
    if (!ui.btnConnect) return;
    if (isConnected){
      ui.btnConnect.textContent = 'Ngắt kết nối';
      ui.btnConnect.onclick = disconnectWallet;
    } else {
      ui.btnConnect.textContent = 'Kết nối ví';
      ui.btnConnect.onclick = async () => {
        try { await connectWallet(); } catch(e){ console.debug(e); }
      };
    }
  }

  function disconnectWallet(){
    try{
      // Tắt auto-connect cho lần tải sau (tuỳ chọn)
      sessionStorage.setItem('muaban:disable_autoconnect', '1');
    }catch{}
    // Reset UI/state
    app.provider = null; app.signer = null; app.account = null;
    setConnectedUI(false);
    safeText(ui.accountShort, '');
    safeText(ui.accountFull,  '');
    safeText(ui.vinBalance,   '—');
    safeText(ui.vicBalance,   '—');
  }

  // ---------- Connect wallet (auto hoặc bấm nút) ----------
  async function connectWallet(){
    if (!window.ethereum || !ethers){
      setConnectedUI(false);
      return;
    }
    app.provider = new ethers.providers.Web3Provider(window.ethereum, 'any');

    const accounts = await app.provider.send('eth_requestAccounts', []);
    app.account = (accounts && accounts[0]) ? ethers.utils.getAddress(accounts[0]) : null;
    app.signer = app.provider.getSigner();

    await ensureVictionChain();

    if (!app.abis.muaban || !app.abis.vin) await loadAbis();
    app.contracts.muaban = new ethers.Contract(MUABAN_ADDRESS,    app.abis.muaban, app.signer);
    app.contracts.vin    = new ethers.Contract(VIN_TOKEN_ADDRESS, app.abis.vin,    app.signer);

    try { app.vinDecimals = await app.contracts.vin.decimals(); } catch { app.vinDecimals = 18; }

    // UI: hiển thị ví + số dư; (không hiển thị tên mạng)
    setConnectedUI(true);
    safeText(ui.accountShort, short(app.account));
    safeText(ui.accountFull,  app.account);
    safeHref(ui.linkAccount, `https://vicscan.xyz/address/${app.account}`);
    if (MUABAN_ADDRESS) safeHref(ui.linkMuaban, `https://vicscan.xyz/address/${MUABAN_ADDRESS}`);
    if (VIN_TOKEN_ADDRESS) safeHref(ui.linkVinToken, `https://vicscan.xyz/token/${VIN_TOKEN_ADDRESS}`);

    // Đồng bộ nav đáy (phòng trường hợp script trong index chưa chạy)
    const navMap = [
      ['navContract', `https://vicscan.xyz/address/${MUABAN_ADDRESS||''}`],
      ['navVinToken', `https://vicscan.xyz/token/${VIN_TOKEN_ADDRESS||''}`],
    ];
    navMap.forEach(([id, href]) => { const el = $('#'+id); if (el && href.endsWith('/')) return; if (el) el.href = href; });

    // Listeners
    if (window.ethereum && window.ethereum.on){
      window.ethereum.on('accountsChanged', () => location.reload());
      window.ethereum.on('chainChanged',   () => location.reload());
      window.ethereum.on('disconnect',     () => location.reload());
    }

    await Promise.all([refreshBalances(), refreshRegistrationUI()]);

    try{ sessionStorage.removeItem('muaban:disable_autoconnect'); }catch{}
  }

  // ---------- Balances ----------
  async function refreshBalances(){
    if (!app.account || !app.provider) return;
    try{
      const wei = await app.provider.getBalance(app.account);
      safeText(ui.vicBalance, fmtToken(wei, 18, 4) + ' VIC');
    }catch{ safeText(ui.vicBalance, '—'); }
    try{
      const bal = await app.contracts.vin.balanceOf(app.account);
      safeText(ui.vinBalance, fmtToken(bal, app.vinDecimals||18, 4) + ' VIN');
    }catch{ safeText(ui.vinBalance, '—'); }
  }

  // ---------- Registration (0.001 VIN) ----------
  const REG_FEE_WEI = ethers.BigNumber.from('1000000000000000'); // 1e15

  async function refreshRegistrationUI(){
    if (!app.contracts?.muaban || !app.account) return;
    try{
      const ok = await app.contracts.muaban.isRegistered(app.account);
      setRegisteredUI(!!ok);
      safeText(ui.statusLine, ok ? 'Đã đăng ký nền tảng.' : 'Chưa đăng ký. Phí đăng ký: 0.001 VIN');
      // Ẩn/hiện toàn bộ nút hành động cần đăng ký
      $$('.registered-only').forEach(el => el.classList.toggle('hidden', !ok));
    }catch{
      setRegisteredUI(false);
    }
  }

  async function ensureAllowance(amount){
    const cur = await app.contracts.vin.allowance(app.account, MUABAN_ADDRESS);
    if (cur.gte(amount)) return;
    const tx = await app.contracts.vin.approve(MUABAN_ADDRESS, amount);
    safeText(ui.statusLine, 'Đang approve 0.001 VIN…');
    await tx.wait(1);
  }

  async function handleRegister(){
    if (!app.contracts?.muaban || !app.contracts?.vin) return;
    try{
      await ensureAllowance(REG_FEE_WEI);
      safeText(ui.statusLine, 'Đang đăng ký (0.001 VIN)…');
      const tx = await app.contracts.muaban.payRegistration();
      await tx.wait(1);
      safeText(ui.statusLine, 'Đăng ký thành công.');
      await Promise.all([refreshBalances(), refreshRegistrationUI()]);
    }catch(e){
      console.error(e);
      safeText(ui.statusLine, e?.data?.message || e?.message || 'Đăng ký thất bại.');
    }
  }

  // ---------- Buying / Escrow ----------
  // ceil(usdCents * vinPerUSD / 100)
  function usdCentsToVinWei(usdCentsBN, vinPerUSDBN){
    const num = usdCentsBN.mul(vinPerUSDBN);
    return num.add(ethers.BigNumber.from(99)).div(100);
  }

  async function getProduct(productId){
    const p = await app.contracts.muaban.products(productId);
    return {
      productId: p.productId,
      seller: p.seller,
      name: p.name,
      descriptionCID: p.descriptionCID,
      imageCID: p.imageCID,
      priceUsdCents: ethers.BigNumber.from(p.priceUsdCents || p[4] || 0),
      shippingUsdCents: ethers.BigNumber.from(p.shippingUsdCents || p[5] || 0),
      taxRateBps: ethers.BigNumber.from(p.taxRateBps || p[6] || 0),
      deliveryDaysMax: ethers.BigNumber.from(p.deliveryDaysMax || p[7] || 0),
      stock: ethers.BigNumber.from(p.stock || p[14] || 0),
      active: !!p.active
    };
  }

  async function quoteVinTotalWei(productId, qty, vinPerUSDWei){
    const p = await getProduct(productId);
    if (!p.active) throw new Error('Sản phẩm đang ẩn.');
    if (p.stock.lt(qty)) throw new Error('Tồn kho không đủ.');

    const priceAll = p.priceUsdCents.mul(qty);
    const ship = p.shippingUsdCents;
    const taxUsd = priceAll.mul(p.taxRateBps).add(9999).div(10000); // ceil

    const vinRev  = usdCentsToVinWei(priceAll, vinPerUSDWei);
    const vinShip = usdCentsToVinWei(ship, vinPerUSDWei);
    const vinTax  = usdCentsToVinWei(taxUsd, vinPerUSDWei);
    const vinTotal = vinRev.add(vinShip).add(vinTax);
    if (vinTotal.lte(0)) throw new Error('VIN tổng bằng 0.');
    return { vinRev, vinShip, vinTax, vinTotal };
  }

  function collectShipping(){
    const name = $('#shipName')?.value?.trim();
    const phone = $('#shipPhone')?.value?.trim();
    const addr = $('#shipAddr')?.value?.trim();
    const note = $('#shipNote')?.value?.trim() || '';
    if (!name || !phone || !addr) throw new Error('Điền đủ Tên, SĐT và Địa chỉ giao hàng.');
    const obj = { name, phone, addr, note };
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    return ethers.utils.hexlify(bytes);
  }

  async function approveVin(amountWei){
    const allowance = await app.contracts.vin.allowance(app.account, MUABAN_ADDRESS);
    if (allowance.gte(amountWei)) return true;
    const tx = await app.contracts.vin.approve(MUABAN_ADDRESS, amountWei);
    await tx.wait(1);
    return true;
  }

  async function placeOrder(){
    if (!app.signer) { alert('Kết nối ví trước.'); return; }
    const reg = await app.contracts.muaban.isRegistered(app.account);
    if (!reg) { alert('Ví chưa đăng ký. Vui lòng trả 0.001 VIN.'); return; }

    const pid = parseInt($('#productId')?.value || '0', 10);
    const qty = Math.max(1, parseInt($('#quantity')?.value || '1', 10));
    const vinPerUSDInput = ($('#vinPerUSD')?.value || '').trim();
    if (!vinPerUSDInput) { alert('Nhập vinPerUSD (VIN trên 1 USD).'); return; }

    let vinPerUSDWei;
    try { vinPerUSDWei = ethers.utils.parseUnits(vinPerUSDInput, 18); }
    catch { vinPerUSDWei = ethers.BigNumber.from(vinPerUSDInput); }

    try{
      const { vinTotal } = await quoteVinTotalWei(pid, qty, vinPerUSDWei);
      const shipBytes = collectShipping();
      await approveVin(vinTotal);

      const tx = await app.contracts.muaban.placeOrder(pid, qty, vinPerUSDWei, shipBytes);
      alert('Đang gửi giao dịch đặt hàng…');
      await tx.wait(1);
      alert('Đặt hàng thành công!');
    }catch(e){
      console.error(e);
      alert(e?.data?.message || e?.message || 'Đặt hàng thất bại.');
    }
  }

  async function confirmReceipt(){
    if (!app.signer) { alert('Kết nối ví trước.'); return; }
    const oid = parseInt($('#orderId')?.value || '0', 10);
    if (!oid) { alert('Nhập Order ID.'); return; }
    try{
      const tx = await app.contracts.muaban.confirmReceipt(oid);
      alert('Đang xác nhận nhận hàng…');
      await tx.wait(1);
      alert('Đã giải ngân escrow cho người bán.');
    }catch(e){
      console.error(e);
      alert(e?.data?.message || e?.message || 'Xác nhận thất bại.');
    }
  }

  async function refundIfExpired(){
    if (!app.signer) { alert('Kết nối ví trước.'); return; }
    const oid = parseInt($('#orderId')?.value || '0', 10);
    if (!oid) { alert('Nhập Order ID.'); return; }
    try{
      const tx = await app.contracts.muaban.refundIfExpired(oid);
      alert('Đang yêu cầu hoàn tiền…');
      await tx.wait(1);
      alert('Đã hoàn VIN về ví buyer (nếu đơn quá hạn).');
    }catch(e){
      console.error(e);
      alert(e?.data?.message || e?.message || 'Hoàn tiền thất bại.');
    }
  }

  // ---------- Search (placeholder: lọc thẻ .product-card theo data-name) ----------
  function attachSearch(){
    const input = $('#searchInput');
    const btn   = $('#btnSearch');
    if (!input || !btn) return;

    const run = () => {
      const q = (input.value || '').trim().toLowerCase();
      const cards = $$('.product-card');
      if (!cards.length) return; // chưa triển khai danh sách
      cards.forEach(card => {
        const name = (card.getAttribute('data-name') || '').toLowerCase();
        card.style.display = (!q || name.includes(q)) ? '' : 'none';
      });
    };
    btn.addEventListener('click', run);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  }

  // ---------- Boot ----------
  document.addEventListener('DOMContentLoaded', ()=>{
    // Map UI
    ui = {
      btnConnect   : $('#btnConnect'),
      walletInfo   : $('#walletInfo'),
      accountShort : $('#accountShort'),
      accountFull  : $('#accountFull'),
      vinBalance   : $('#vinBalance'),
      vicBalance   : $('#vicBalance'),
      btnRegister  : $('#btnRegister'),
      statusLine   : $('#statusLine'),
      linkAccount  : $('#linkAccount'),
      linkMuaban   : $('#linkMuaban'),
      linkVinToken : $('#linkVinToken'),
    };

    // Ẩn thông tin ví ban đầu
    setConnectedUI(false);

    // Chuẩn bị nút Connect/Disconnect
    updateConnectButton(false);

    // Nút Đăng ký (nếu có)
    ui.btnRegister?.addEventListener('click', async ()=>{
      if (!app.account) { alert('Hãy mở & kết nối ví EVM.'); return; }
      await handleRegister();
    });

    // Nút mua/đơn (nếu có trên trang)
    $('#btnApproveBuy')?.addEventListener('click', async ()=>{
      try{
        const pid = parseInt($('#productId')?.value || '0', 10);
        const qty = Math.max(1, parseInt($('#quantity')?.value || '1', 10));
        const vinPerUSDInput = ($('#vinPerUSD')?.value || '').trim();
        if (!vinPerUSDInput) { alert('Nhập vinPerUSD.'); return; }
        let vinPerUSDWei;
        try { vinPerUSDWei = ethers.utils.parseUnits(vinPerUSDInput, 18); }
        catch { vinPerUSDWei = ethers.BigNumber.from(vinPerUSDInput); }
        const { vinTotal } = await quoteVinTotalWei(pid, qty, vinPerUSDWei);
        await approveVin(vinTotal);
        alert('Approve VIN thành công.');
      }catch(e){
        console.error(e);
        alert(e?.data?.message || e?.message || 'Approve VIN thất bại.');
      }
    });
    $('#btnPlaceOrder')?.addEventListener('click', placeOrder);
    $('#btnConfirm')?.addEventListener('click', confirmReceipt);
    $('#btnRefund')?.addEventListener('click', refundIfExpired);

    // Search
    attachSearch();

    // Auto-connect nếu không bị tắt ở phiên trước
    const disableAuto = sessionStorage.getItem('muaban:disable_autoconnect') === '1';
    if (!disableAuto){
      (async () => {
        try{ await connectWallet(); }
        catch(err){ console.debug('Auto-connect skipped:', err?.message || err); }
      })();
    }
  });

})();

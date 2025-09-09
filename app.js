/* muaban — app.js (clean, single file)
   - Connect/Disconnect wallet
   - Show address + VIN/VIC balances
   - Registration fee (0.001 VIN) with auto-approve
   - Place order per product (reads inputs in #buyPanel)
   - Toggle UI by connected/registered states
*/
(() => {
  'use strict';

  // ---------- Helpers ----------
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const safeText = (el, t) => { if (el) el.textContent = t; };
  const safeShow = (el, show) => { if (!el) return; el.classList.toggle('hidden', !show); };
  const safeHref = (el, url) => { if (el && url) el.setAttribute('href', url); };
  const short = (a)=> a ? (a.slice(0,6)+'…'+a.slice(-4)) : '—';

  function fmtToken(raw, decimals=18, maxFrac=4){
    try{
      const s = ethers.utils.formatUnits(raw||0, decimals);
      const [i,f=''] = s.split('.');
      const fN = f.slice(0, maxFrac);
      return fN ? `${i}.${fN}` : i;
    }catch{ return '0'; }
  }

  // ---------- UI refs ----------
  const ui = {
    // header / wallet
    btnConnect   : $('#btnConnect'),
    walletInfo   : $('#walletInfo'),
    accountShort : $('#accountShort'),
    accountFull  : $('#accountFull'),
    vinBalance   : $('#vinBalance'),
    vicBalance   : $('#vicBalance'),
    btnRegister  : $('#btnRegister'),
    statusLine   : $('#statusLine'),

    // links (để đồng bộ vicscan)
    linkAccount  : $('#linkAccount'),
    linkMuaban   : $('#linkMuaban'),
    linkVinToken : $('#linkVinToken'),

    // buy panel
    buyPanel     : $('#buyPanel'),
    buyProductName: $('#buyProductName'),
    productIdInp : $('#productId'),
    qtyInp       : $('#quantity'),
    vinPerUSDInp : $('#vinPerUSD'),
    shipName     : $('#shipName'),
    shipPhone    : $('#shipPhone'),
    shipAddr     : $('#shipAddr'),      // <-- đúng id trong index.html
    shipNote     : $('#shipNote'),
    btnApproveBuy: $('#btnApproveBuy'),
    btnPlaceOrder: $('#btnPlaceOrder'),

    // order actions
    orderIdInp   : $('#orderId'),
    btnConfirm   : $('#btnConfirm'),
    btnRefund    : $('#btnRefund'),
  };

  // ---------- Config & ethers ----------
  const CFG = (window.MUABAN_CONFIG || {});
  const MUABAN_ADDRESS    = CFG.MUABAN_ADDRESS;
  const VIN_TOKEN_ADDRESS = CFG.VIN_TOKEN;
  const VIC_CHAIN_ID_HEX  = CFG.VIC_CHAIN_ID_HEX || '0x58';
  const VIC_NAME          = CFG.VIC_NAME || 'Viction Mainnet';

  const ethers = window.ethers;

  // ---------- App state ----------
  const app = {
    abis: { muaban: null, vin: null },
    provider: null, signer: null, account: null, chainIdHex: null,
    contracts: { muaban: null, vin: null }, vinDecimals: 18,
  };
  window.muabanApp = app; // tiện debug

  // ---------- Load ABIs ----------
  async function loadAbis(){
    const muabanPath = CFG.MUABAN_ABI_PATH || './Muaban_ABI.json';
    const vinPath    = './VinToken_ABI.json';
    const [r1, r2] = await Promise.all([
      fetch(muabanPath, {cache:'no-store'}),
      fetch(vinPath,    {cache:'no-store'}),
    ]);
    app.abis.muaban = await r1.json();
    app.abis.vin    = await r2.json();
  }

  // ---------- Chain ensure ----------
  async function ensureVictionChain(){
    const cur = await window.ethereum.request({ method: 'eth_chainId' });
    app.chainIdHex = cur;
    if (cur === VIC_CHAIN_ID_HEX) return;
    try{
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: VIC_CHAIN_ID_HEX }] });
    }catch(e){
      if (e && e.code === 4902){
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: VIC_CHAIN_ID_HEX,
            chainName: VIC_NAME,
            nativeCurrency: { name: 'Viction', symbol: 'VIC', decimals: 18 },
            rpcUrls: ['https://rpc.viction.xyz'],
            blockExplorerUrls: ['https://vicscan.xyz'],
          }]
        });
      }else{ throw e; }
    }
  }

  // ---------- UI states ----------
  function setConnectedUI(connected){
    document.body.classList.toggle('connected', connected);
    safeShow(ui.walletInfo, connected);
    updateConnectButton(connected);
  }
  function setRegisteredUI(registered){
    document.body.classList.toggle('registered', registered);
    ui.btnRegister && ui.btnRegister.classList.toggle('hidden', !!registered);
  }

  // ---------- Connect / Disconnect ----------
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
    try{ sessionStorage.setItem('muaban:disable_autoconnect', '1'); }catch{}
    app.provider = null; app.signer = null; app.account = null;
    setConnectedUI(false);
    safeText(ui.accountShort, '');
    safeText(ui.accountFull,  '');
    safeText(ui.vinBalance,   '—');
    safeText(ui.vicBalance,   '—');
  }

  async function connectWallet(){
    if (!window.ethereum || !ethers){
      alert('Không thấy ví EVM. Cài MetaMask/OKX… rồi tải lại trang.');
      return;
    }
    if (!MUABAN_ADDRESS || MUABAN_ADDRESS.length !== 42){
      alert('MUABAN_ADDRESS chưa đúng trong index.html');
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

    // UI
    setConnectedUI(true);
    safeText(ui.accountShort, short(app.account));
    safeText(ui.accountFull,  app.account);
    safeHref(ui.linkAccount,  `https://vicscan.xyz/address/${app.account}`);
    if (MUABAN_ADDRESS)    safeHref(ui.linkMuaban,   `https://vicscan.xyz/address/${MUABAN_ADDRESS}`);
    if (VIN_TOKEN_ADDRESS) safeHref(ui.linkVinToken, `https://vicscan.xyz/token/${VIN_TOKEN_ADDRESS}`);

    // listeners
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

  // ---------- Registration ----------
  const REG_FEE_WEI = ethers.BigNumber.from('1000000000000000'); // 0.001 VIN

  async function ensureAllowance(amountWei){
    const cur = await app.contracts.vin.allowance(app.account, MUABAN_ADDRESS);
    if (cur.gte(amountWei)) return;
    const tx = await app.contracts.vin.approve(MUABAN_ADDRESS, amountWei);
    safeText(ui.statusLine, 'Đang approve VIN…');
    await tx.wait(1);
  }

  async function refreshRegistrationUI(){
    if (!app.contracts?.muaban || !app.account) return;
    try{
      const ok = await app.contracts.muaban.isRegistered(app.account);
      setRegisteredUI(!!ok);
      safeText(ui.statusLine, ok ? 'Đã đăng ký nền tảng.' : 'Chưa đăng ký. Phí: 0.001 VIN');
      $$('.registered-only').forEach(el => el.classList.toggle('hidden', !ok));
    }catch{
      setRegisteredUI(false);
    }
  }

  async function handleRegister(){
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
  // usdCents * vinPerUSD / 100 (ceil)
  function usdCentsToVinWei(usdCentsBN, vinPerUSDBN){
    const num = usdCentsBN.mul(vinPerUSDBN);
    return num.add(ethers.BigNumber.from(99)).div(100);
  }

  async function getProduct(productId){
    const p = await app.contracts.muaban.products(productId);
    return {
      priceUsdCents   : ethers.BigNumber.from(p.priceUsdCents || p[4] || 0),
      shippingUsdCents: ethers.BigNumber.from(p.shippingUsdCents || p[5] || 0),
      taxRateBps      : ethers.BigNumber.from(p.taxRateBps || p[6] || 0),
      stock           : ethers.BigNumber.from(p.stock || p[14] || 0),
      active          : !!p.active
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
    const name = ui.shipName?.value?.trim();
    const phone = ui.shipPhone?.value?.trim();
    const addr = ui.shipAddr?.value?.trim();
    const note = ui.shipNote?.value?.trim() || '';
    if (!name || !phone || !addr) throw new Error('Điền đủ Tên, SĐT và Địa chỉ giao hàng.');
    const obj = { name, phone, addr, note };
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    return ethers.utils.hexlify(bytes);
  }

  async function approveBuyLarge(){
    // Cho thuận tiện trải nghiệm: approve “lớn” một lần (có thể revoke sau)
    const BIG = ethers.BigNumber.from('10000000000000000000000'); // 1e22 wei
    await ensureAllowance(BIG);
    alert('Đã approve VIN cho hợp đồng.');
  }

  async function placeOrder(){
    if (!app.signer) { alert('Kết nối ví trước.'); return; }
    const reg = await app.contracts.muaban.isRegistered(app.account);
    if (!reg) { alert('Ví chưa đăng ký. Vui lòng trả 0.001 VIN.'); return; }

    const pid = parseInt(ui.productIdInp?.value || '0', 10);
    const qty = Math.max(1, parseInt(ui.qtyInp?.value || '1', 10));
    const vinPerUSDInput = (ui.vinPerUSDInp?.value || '').trim();
    if (!pid || !vinPerUSDInput) { alert('Thiếu Mã SP hoặc vinPerUSD.'); return; }

    let vinPerUSDWei;
    try { vinPerUSDWei = ethers.utils.parseUnits(vinPerUSDInput, 18); }
    catch { vinPerUSDWei = ethers.BigNumber.from(vinPerUSDInput); }

    try{
      // Ước lượng để auto-approve vừa đủ
      const { vinTotal } = await quoteVinTotalWei(pid, qty, vinPerUSDWei);
      await ensureAllowance(vinTotal);

      const shipBytes = collectShipping();
      ui.btnPlaceOrder && (ui.btnPlaceOrder.disabled = true, ui.btnPlaceOrder.textContent = 'Đang đặt…');

      const tx = await app.contracts.muaban.placeOrder(pid, qty, vinPerUSDWei, shipBytes);
      await tx.wait(1);
      alert('Đặt hàng thành công!');
    }catch(e){
      console.error(e);
      alert(e?.data?.message || e?.message || 'Đặt hàng thất bại.');
    }finally{
      if (ui.btnPlaceOrder){ ui.btnPlaceOrder.disabled = false; ui.btnPlaceOrder.textContent = 'Mua (placeOrder)'; }
    }
  }

  async function confirmReceipt(){
    if (!app.signer) { alert('Kết nối ví trước.'); return; }
    const oid = parseInt(ui.orderIdInp?.value || '0', 10);
    if (!oid) { alert('Nhập Order ID.'); return; }
    try{
      const tx = await app.contracts.muaban.confirmReceipt(oid);
      await tx.wait(1);
      alert('Đã giải ngân escrow cho người bán.');
    }catch(e){
      console.error(e);
      alert(e?.data?.message || e?.message || 'Xác nhận thất bại.');
    }
  }

  async function refundIfExpired(){
    if (!app.signer) { alert('Kết nối ví trước.'); return; }
    const oid = parseInt(ui.orderIdInp?.value || '0', 10);
    if (!oid) { alert('Nhập Order ID.'); return; }
    try{
      const tx = await app.contracts.muaban.refundIfExpired(oid);
      await tx.wait(1);
      alert('Đã hoàn tiền cho đơn quá hạn.');
    }catch(e){
      console.error(e);
      alert(e?.data?.message || e?.message || 'Hoàn tiền thất bại.');
    }
  }

  // ---------- Wire up ----------
  document.addEventListener('DOMContentLoaded', () => {
    // buttons
    updateConnectButton(false);
    ui.btnRegister   && ui.btnRegister.addEventListener('click', handleRegister);
    ui.btnApproveBuy && ui.btnApproveBuy.addEventListener('click', approveBuyLarge);
    ui.btnPlaceOrder && ui.btnPlaceOrder.addEventListener('click', placeOrder);
    ui.btnConfirm    && ui.btnConfirm.addEventListener('click', confirmReceipt);
    ui.btnRefund     && ui.btnRefund.addEventListener('click', refundIfExpired);

    // tự nhận biết đã “kết nối lần trước” để tự động hoá (tùy chọn)
    if (window.ethereum && sessionStorage.getItem('muaban:disable_autoconnect') !== '1'){
      // không auto-click; để người dùng chủ động bấm "Kết nối ví"
    }
  });
})();

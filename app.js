/* muaban — app.js (clean)
   - Auto connect ví; hiển thị địa chỉ + số dư VIN/VIC
   - Đăng ký nền tảng (0.001 VIN): tự approve nếu thiếu rồi gọi payRegistration()
   - Đặt hàng theo sản phẩm: đọc giá trị từ khung #buyPanel và gọi placeOrder()
   - Ẩn/hiện các khối theo trạng thái connected/registered phù hợp index.html
*/
(() => {
  'use strict';

  // -------- Helpers --------
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

  // -------- UI refs --------
  const ui = {
    // ví
    walletInfo   : $('#walletInfo'),
    accountShort : $('#accountShort'),
    accountFull  : $('#accountFull'),
    vinBalance   : $('#vinBalance'),
    vicBalance   : $('#vicBalance'),
    btnRegister  : $('#btnRegister'),
    statusLine   : $('#statusLine'),
    // nav (tuỳ có/không)
    linkAccount  : $('#linkAccount'),
    linkMuaban   : $('#linkMuaban'),
    linkVinToken : $('#linkVinToken'),
    // buy panel
    buyPanel     : $('#buyPanel'),
    productIdInp : $('#productId'),
    vinPerUSDInp : $('#vinPerUSD'),
    qtyInp       : $('#quantity'),
    shipName     : $('#shipName'),
    shipPhone    : $('#shipPhone'),
    shipAddr     : $('#shipAddress'),
    shipNote     : $('#shipNote'),
    btnPlaceOrder: $('#btnPlaceOrder'),
  };

  // -------- Config & ethers --------
  const CFG = (window.MUABAN_CONFIG || {});
  const MUABAN_ADDRESS    = CFG.MUABAN_ADDRESS;
  const VIN_TOKEN_ADDRESS = CFG.VIN_TOKEN;
  const VIC_CHAIN_ID_HEX  = CFG.VIC_CHAIN_ID_HEX || '0x58';
  const VIC_NAME          = CFG.VIC_NAME || 'Viction Mainnet';

  const ethers = window.ethers;

  // -------- App state --------
  const app = {
    abis: { muaban: null, vin: null },
    provider: null, signer: null, account: null, chainIdHex: null,
    contracts: { muaban: null, vin: null }, vinDecimals: 18,
  };
  window.muabanApp = app; // tiện debug

  // -------- Load ABIs --------
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

  // -------- Ensure Viction chain --------
  async function ensureVictionChain(){
    const cur = await window.ethereum.request({ method: 'eth_chainId' });
    app.chainIdHex = cur;
    if (cur === VIC_CHAIN_ID_HEX) return;
    // thử switch, nếu chưa có thì add
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
      }else{
        throw e;
      }
    }
  }

  // -------- Connect wallet --------
  async function connectWallet(){
    if (!window.ethereum || !ethers){
      alert('Không thấy ví EVM. Hãy cài MetaMask/OKX… rồi tải lại trang.');
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
    safeShow(ui.walletInfo, true);
    safeText(ui.accountShort, short(app.account));
    safeText(ui.accountFull,  app.account);
    safeHref(ui.linkAccount,  `https://vicscan.xyz/address/${app.account}`);
    if (MUABAN_ADDRESS)    safeHref(ui.linkMuaban,   `https://vicscan.xyz/address/${MUABAN_ADDRESS}`);
    if (VIN_TOKEN_ADDRESS) safeHref(ui.linkVinToken, `https://vicscan.xyz/token/${VIN_TOKEN_ADDRESS}`);

    // listeners thay đổi ví/chain
    if (window.ethereum && window.ethereum.on){
      window.ethereum.on('accountsChanged', () => location.reload());
      window.ethereum.on('chainChanged',   () => location.reload());
      window.ethereum.on('disconnect',     () => location.reload());
    }

    await Promise.all([refreshBalances(), refreshRegistrationUI()]);
  }

  // -------- Balances --------
  async function refreshBalances(){
    if (!app.account || !app.provider) return;
    // VIC native
    try{
      const wei = await app.provider.getBalance(app.account);
      safeText(ui.vicBalance, fmtToken(wei, 18, 4) + ' VIC');
    }catch{ safeText(ui.vicBalance, '—'); }
    // VIN ERC20
    try{
      const bal = await app.contracts.vin.balanceOf(app.account);
      safeText(ui.vinBalance, fmtToken(bal, app.vinDecimals||18, 4) + ' VIN');
    }catch{ safeText(ui.vinBalance, '—'); }
  }

  // -------- Registration (0.001 VIN) --------
  const REG_FEE_WEI = ethers.BigNumber.from('1000000000000000'); // 0.001 * 1e18

  function setRegisteredUI(registered){
    // Ẩn nút "Đăng ký" nếu đã đăng ký
    if (ui.btnRegister) ui.btnRegister.classList.toggle('hidden', !!registered);
    // Ẩn mọi phần tử yêu cầu đã đăng ký
    $$('.registered-only').forEach(el => el.classList.toggle('hidden', !registered));
    safeText(ui.statusLine, registered ? 'Đã đăng ký nền tảng.' : 'Chưa đăng ký. Phí: 0.001 VIN');
  }

  async function refreshRegistrationUI(){
    if (!app.contracts?.muaban || !app.account) return;
    try{
      const ok = await app.contracts.muaban.isRegistered(app.account);
      setRegisteredUI(!!ok);
    }catch{
      setRegisteredUI(false);
    }
  }

  async function ensureAllowance(amountWei){
    const cur = await app.contracts.vin.allowance(app.account, MUABAN_ADDRESS);
    if (cur.gte(amountWei)) return;
    const tx = await app.contracts.vin.approve(MUABAN_ADDRESS, amountWei);
    safeText(ui.statusLine, 'Đang approve 0.001 VIN…');
    await tx.wait(1);
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

  // -------- Buy / Place order --------
  function packShippingInfo(){
    // Gói thông tin giao hàng thành bytes (JSON → UTF8 bytes)
    const obj = {
      name: ui.shipName?.value?.trim() || '',
      phone: ui.shipPhone?.value?.trim() || '',
      address: ui.shipAddr?.value?.trim() || '',
      note: ui.shipNote?.value?.trim() || '',
    };
    const json = JSON.stringify(obj);
    return ethers.utils.toUtf8Bytes(json);
  }

  async function placeOrder(){
    if (!app.contracts?.muaban || !app.contracts?.vin) return alert('Chưa kết nối ví.');
    // chỉ cho order khi đã đăng ký
    const reg = await app.contracts.muaban.isRegistered(app.account);
    if (!reg) { alert('Ví chưa đăng ký. Vui lòng bấm “Đăng ký (0.001 VIN)”.'); return; }

    // đọc input
    const pid = parseInt(ui.productIdInp?.value || '0', 10);
    const qty = ethers.BigNumber.from(ui.qtyInp?.value || '1');
    const vPerUSDStr = (ui.vinPerUSDInp?.value || '0').trim();
    if (!pid || qty.lte(0)) { alert('Thiếu Product ID hoặc Số lượng.'); return; }

    // vinPerUSD là "wei trên 1 USD"
    let vinPerUSD;
    try{
      vinPerUSD = ethers.utils.parseUnits(vPerUSDStr, app.vinDecimals||18);
    }catch{
      alert('vinPerUSD không hợp lệ. Ví dụ: 0.041666 (nếu 1 VIN = 24 USD)'); return;
    }

    const shipBytes = packShippingInfo();

    try{
      // Hỏi allowance: contract sẽ transferFrom VIN khi placeOrder
      // Ta có thể ước lượng tổng VIN và auto-approve; đơn giản hơn: approve "vô hạn" cho tiện (người dùng có thể tự revoke sau).
      // Nhưng để an toàn, approve đúng bằng ước tính: lấy giá trị xấp xỉ từ frontend (không có oracle on-chain).
      // Ở đây: cứ đảm bảo allowance >= 10^22 wei (~10,000 VIN) để tránh bật modal 2 lần (đơn giản hoá trải nghiệm).
      const BIG_ALLOW = ethers.BigNumber.from('10000000000000000000000'); // 1e22 wei
      await ensureAllowance(BIG_ALLOW);

      ui.btnPlaceOrder.disabled = true;
      ui.btnPlaceOrder.textContent = 'Đang đặt hàng…';

      const tx = await app.contracts.muaban.placeOrder(pid, qty, vinPerUSD, shipBytes);
      const rc = await tx.wait(1);

      alert('Đặt hàng thành công!');
      ui.btnPlaceOrder.textContent = 'Mua';
      ui.btnPlaceOrder.disabled = false;

    }catch(e){
      console.error(e);
      alert(e?.data?.message || e?.message || 'Đặt hàng thất bại.');
      ui.btnPlaceOrder.textContent = 'Mua';
      ui.btnPlaceOrder.disabled = false;
    }
  }

  // -------- Wire up --------
  document.addEventListener('DOMContentLoaded', ()=>{
    // Nút Đăng ký
    if (ui.btnRegister) ui.btnRegister.addEventListener('click', handleRegister);

    // Nút Mua trong panel
    if (ui.btnPlaceOrder) ui.btnPlaceOrder.addEventListener('click', placeOrder);

    // Tự động kết nối ví khi mở trang
    (async () => {
      try{ await connectWallet(); }catch(e){ console.debug('Auto-connect skipped:', e?.message||e); }
    })();
  });
})();

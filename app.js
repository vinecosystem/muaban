<!-- app.js (Part 1/3) -->
<script>
(() => {
  'use strict';

  /* ========== 0) Helpers ========== */
  const $  = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

  const ui = {
    btnConnect   : $('#btnConnect'),
    walletInfo   : $('#walletInfo'),
    accountShort : $('#accountShort'),
    networkName  : $('#networkName'),
  };

  const CFG = (window.MUABAN_CONFIG || {});
  const MUABAN_ADDRESS    = CFG.MUABAN_ADDRESS;
  const VIN_TOKEN_ADDRESS = CFG.VIN_TOKEN;
  const VIC_CHAIN_ID_HEX  = CFG.VIC_CHAIN_ID_HEX || '0x58'; // 88
  const VIC_NAME          = CFG.VIC_NAME || 'Viction Mainnet';

  // Ethers UMD đã được load bằng <script ... ethers.umd.min.js defer> trong index.html
  // -> dùng trực tiếp window.ethers, không redeclare
  const ethers = window.ethers;

  const app = {
    abis: { muaban: null, vin: null },
    provider: null,
    signer: null,
    account: null,
    chainIdHex: null,
    contracts: { muaban: null, vin: null },
    vinDecimals: 18,
  };

  function shortAddr(a){
    try { return a ? (a.slice(0,6) + '…' + a.slice(-4)) : '—'; }
    catch { return '—'; }
  }

  function safeSetText(el, text){
    if (el) el.textContent = text;
  }

  function showWalletInfo(show){
    if (!ui.walletInfo) return;
    ui.walletInfo.classList.toggle('hidden', !show);
  }

  /* ========== 1) Nạp ABI từ file JSON (cùng thư mục) ========== */
  async function loadAbis(){
    // Đường dẫn được set trong index.html
    const muabanPath = (CFG.MUABAN_ABI_PATH || './Muaban_ABI.json');
    const vinPath    = './VinToken_ABI.json';

    const [muabanRes, vinRes] = await Promise.all([
      fetch(muabanPath, { cache: 'no-store' }),
      fetch(vinPath, { cache: 'no-store' })
    ]);
    app.abis.muaban = await muabanRes.json();   // :contentReference[oaicite:6]{index=6}
    app.abis.vin    = await vinRes.json();      // :contentReference[oaicite:7]{index=7}
  }

  /* ========== 2) Kết nối ví + đảm bảo đúng chain (0x58) ========== */
  async function ensureVictionChain(){
    const current = await window.ethereum.request({ method: 'eth_chainId' });
    app.chainIdHex = current;
    if (current !== VIC_CHAIN_ID_HEX){
      // Thử switch; nếu chưa có thì add
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
              blockExplorerUrls: ['https://vicscan.xyz/']
            }]
          });
          app.chainIdHex = VIC_CHAIN_ID_HEX;
        }catch(addErr){
          throw new Error('Không thể chuyển sang mạng Viction');
        }
      }
    }
  }

  async function connectWallet(){
    if (!window.ethereum || !ethers){
      alert('Chưa phát hiện ví EVM. Hãy cài MetaMask hoặc ví tương thích.');
      return;
    }

    app.provider = new ethers.providers.Web3Provider(window.ethereum, 'any');

    // Yêu cầu tài khoản
    const accounts = await app.provider.send('eth_requestAccounts', []);
    app.account = (accounts && accounts[0]) ? ethers.utils.getAddress(accounts[0]) : null;
    app.signer = app.provider.getSigner();

    // Đảm bảo đúng chain
    await ensureVictionChain();

    // Cập nhật UI cơ bản
    showWalletInfo(true);
    safeSetText(ui.accountShort, shortAddr(app.account));
    safeSetText(ui.networkName, 'Viction');

    // Khởi tạo contracts sau khi có signer + ABI
    if (!app.abis.muaban || !app.abis.vin) await loadAbis();

    app.contracts.muaban = new ethers.Contract(MUABAN_ADDRESS, app.abis.muaban, app.signer); // :contentReference[oaicite:8]{index=8}
    app.contracts.vin    = new ethers.Contract(VIN_TOKEN_ADDRESS, app.abis.vin, app.signer);  // :contentReference[oaicite:9]{index=9}

    // Lưu decimals VIN nếu có
    try {
      app.vinDecimals = await app.contracts.vin.decimals();
    } catch(e){ app.vinDecimals = 18; }

    // Lắng nghe thay đổi tài khoản/chain
    if (window.ethereum && window.ethereum.on){
      window.ethereum.on('accountsChanged', () => location.reload());
      window.ethereum.on('chainChanged',   () => location.reload());
    }
  }

  /* ========== 3) Gắn event cho nút Kết nối ví ========== */
  function bindEvents(){
    if (ui.btnConnect){
      ui.btnConnect.addEventListener('click', async () => {
        try{
          await connectWallet();
        }catch(err){
          console.error(err);
          alert(err.message || 'Không thể kết nối ví.');
        }
      });
    }
  }

  /* ========== 4) Khởi động ========== */
  document.addEventListener('DOMContentLoaded', () => {
    // Ẩn ô ví ban đầu
    showWalletInfo(false);
    safeSetText(ui.networkName, '—');
    bindEvents();
  });

  // Expose tối thiểu nếu cần debug
  window.muabanApp = app;

})();
</script>
<!-- app.js (Part 2/3) — Balances + Registration -->
<script>
(() => {
  'use strict';

  const ethers = window.ethers;
  const app    = window.muabanApp || {};
  const CFG    = (window.MUABAN_CONFIG || {});
  const MUABAN_ADDRESS = CFG.MUABAN_ADDRESS;

  /* ======= DOM refs (tồn tại thì cập nhật, không có thì bỏ qua) ======= */
  const $  = (s, r=document) => r.querySelector(s);
  const ui = {
    btnRegister : $('#btnRegister'),
    vinBalance  : $('#vinBalance'),
    vicBalance  : $('#vicBalance'),
    statusLine  : $('#statusLine'),
  };

  /* ======= Utils ======= */
  const short = (a)=> a ? (a.slice(0,6)+'…'+a.slice(-4)) : '—';
  const safeText = (el, t)=> { if (el) el.textContent = t; };

  // Định dạng đơn giản cho token (4 số lẻ tối đa)
  function fmtToken(raw, decimals=18, maxFrac=4){
    try{
      const s = ethers.utils.formatUnits(raw, decimals);
      const [i,f=''] = s.split('.');
      const f4 = f.slice(0, maxFrac);
      return f4 ? `${i}.${f4}` : i;
    }catch{ return '0'; }
  }

  /* ======= Hằng số phí đăng ký (theo Muaban.sol: PLATFORM_FEE = 1e15 = 0.001 VIN) ======= */
  const REG_FEE_WEI = ethers.BigNumber.from('1000000000000000'); // 0.001 * 1e18

  /* ======= Cập nhật số dư VIC/VIN ======= */
  async function refreshBalances(){
    if (!app.provider || !app.account || !app.contracts?.vin) return;

    // VIC (native)
    try{
      const vicWei = await app.provider.getBalance(app.account);
      safeText(ui.vicBalance, fmtToken(vicWei, 18, 4) + ' VIC');
    }catch(e){
      safeText(ui.vicBalance, '—');
      console.debug('get VIC balance fail:', e);
    }

    // VIN (ERC-20)
    try{
      const bal = await app.contracts.vin.balanceOf(app.account);
      safeText(ui.vinBalance, fmtToken(bal, app.vinDecimals||18, 4) + ' VIN');
    }catch(e){
      safeText(ui.vinBalance, '—');
      console.debug('get VIN balance fail:', e);
    }
  }

  /* ======= Kiểm tra đã đăng ký chưa (isRegistered) để ẩn/hiện nút ======= */
  async function refreshRegistrationUI(){
    if (!app.contracts?.muaban || !app.account) return;
    try{
      const ok = await app.contracts.muaban.isRegistered(app.account); // public mapping getter
      if (ui.btnRegister) ui.btnRegister.classList.toggle('hidden', !!ok);
      safeText(ui.statusLine, ok ? 'Đã đăng ký nền tảng.' : 'Chưa đăng ký. Phí đăng ký: 0.001 VIN');
    }catch(e){
      console.debug('isRegistered() fail:', e);
    }
  }

  /* ======= Đảm bảo allowance đủ cho Muaban (spender = MUABAN_ADDRESS) ======= */
  async function ensureAllowance(amount){
    const owner = app.account;
    const spender = MUABAN_ADDRESS;
    const cur = await app.contracts.vin.allowance(owner, spender);
    if (cur.gte(amount)) return;

    // approve amount đúng bằng phí (tránh approve vô hạn nếu bạn không thích)
    const tx = await app.contracts.vin.approve(spender, amount);
    safeText(ui.statusLine, 'Đang gửi approve VIN…');
    await tx.wait(1);
  }

  /* ======= Thực hiện đăng ký: approve + payRegistration() ======= */
  async function handleRegister(){
    if (!app.contracts?.muaban || !app.contracts?.vin) return;
    try{
      safeText(ui.statusLine, 'Kiểm tra allowance…');
      await ensureAllowance(REG_FEE_WEI);

      safeText(ui.statusLine, 'Đang đăng ký (0.001 VIN)…');
      const tx = await app.contracts.muaban.payRegistration(); // cần approve trước
      await tx.wait(1);

      safeText(ui.statusLine, 'Đăng ký thành công.');
      await Promise.all([refreshBalances(), refreshRegistrationUI()]);
    }catch(err){
      console.error(err);
      safeText(ui.statusLine, err?.data?.message || err?.message || 'Đăng ký thất bại.');
    }
  }

  /* ======= Gắn sự kiện cho nút Đăng ký (nếu có trong HTML) ======= */
  function bindRegister(){
    if (!ui.btnRegister) return;
    ui.btnRegister.addEventListener('click', async () => {
      if (!app.account) {
        alert('Hãy kết nối ví trước.');
        return;
      }
      await handleRegister();
    });
  }

  /* ======= Chờ đến khi Part 1 kết nối xong thì khởi động Part 2 ======= */
  function postConnectInit(){
    bindRegister();
    refreshBalances();
    refreshRegistrationUI();
  }

  // Khi bấm nút Kết nối ví (từ Part 1), mình sẽ chờ contracts sẵn sàng rồi init
  function whenReady(){
    const ok = app?.account && app?.contracts?.muaban && app?.contracts?.vin;
    if (ok) return postConnectInit();
    setTimeout(whenReady, 300);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btnConnect = document.querySelector('#btnConnect');
    if (btnConnect) btnConnect.addEventListener('click', whenReady);

    // Nếu trang reload mà ví đã kết nối & contracts đã có, init luôn
    if (app?.account && app?.contracts?.muaban && app?.contracts?.vin) {
      postConnectInit();
    }
  });

})();
</script>
<!-- app.js (Part 3/3) — UI helpers, refresh, safety hooks -->
<script>
(() => {
  'use strict';

  const ethers = window.ethers;
  const app    = window.muabanApp || {};
  const CFG    = (window.MUABAN_CONFIG || {});
  const MUABAN_ADDRESS    = CFG.MUABAN_ADDRESS;
  const VIN_TOKEN_ADDRESS = CFG.VIN_TOKEN;

  const $  = (s, r=document) => r.querySelector(s);
  const ui = {
    // khu vực ví/ mạng
    walletInfo    : $('#walletInfo'),
    accountShort  : $('#accountShort'),
    accountFull   : $('#accountFull'),   // optional
    networkName   : $('#networkName'),
    // số dư
    vinBalance    : $('#vinBalance'),
    vicBalance    : $('#vicBalance'),
    // hành động
    btnConnect    : $('#btnConnect'),
    btnRegister   : $('#btnRegister'),
    btnRefresh    : $('#btnRefresh'),
    // trạng thái
    statusLine    : $('#statusLine'),
    // link explorer (optional)
    linkAccount   : $('#linkAccount'),
    linkMuaban    : $('#linkMuaban'),
    linkVinToken  : $('#linkVinToken'),
  };

  /* ========= Helpers ========= */
  const safeText = (el, t) => { if (el) el.textContent = t; };
  const safeHref = (el, url) => { if (el && url) el.setAttribute('href', url); };
  const short = (a)=> a ? (a.slice(0,6) + '…' + a.slice(-4)) : '—';

  // Định dạng số VNĐ (số nguyên, chấm ngăn cách)
  function fmtVND(n){
    try{
      const s = String(Math.trunc(Number(n)||0));
      return s.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    }catch { return '0'; }
  }

  // Định dạng token với tối đa 4 chữ số thập phân
  function fmtToken(raw, decimals=18, maxFrac=4){
    try{
      const s = ethers.utils.formatUnits(raw, decimals);
      const [i,f=''] = s.split('.');
      const f4 = f.slice(0, maxFrac);
      return f4 ? `${i}.${f4}` : i;
    }catch{ return '0'; }
  }

  /* ========= Cập nhật hiển thị ví / mạng / liên kết explorer ========= */
  function refreshAccountUI(){
    if (!app.account){
      if (ui.walletInfo) ui.walletInfo.classList.add('hidden');
      return;
    }
    if (ui.walletInfo) ui.walletInfo.classList.remove('hidden');

    safeText(ui.accountShort, short(app.account));
    safeText(ui.accountFull, app.account);
    safeText(ui.networkName, 'Viction');

    // Link explorer (nếu có thẻ)
    const accUrl = `https://vicscan.xyz/address/${app.account}`;
    safeHref(ui.linkAccount, accUrl);

    if (MUABAN_ADDRESS) {
      safeHref(ui.linkMuaban, `https://vicscan.xyz/address/${MUABAN_ADDRESS}`);
    }
    if (VIN_TOKEN_ADDRESS) {
      safeHref(ui.linkVinToken, `https://vicscan.xyz/address/${VIN_TOKEN_ADDRESS}`);
    }
  }

  /* ========= Làm mới số dư & trạng thái đăng ký ========= */
  async function fullRefresh(){
    try{
      if (!app.account || !app.provider || !app.contracts?.vin || !app.contracts?.muaban) {
        // chưa kết nối ví — chỉ dọn UI
        safeText(ui.vicBalance, '—');
        safeText(ui.vinBalance, '—');
        return;
      }
      // VIC
      try{
        const vicWei = await app.provider.getBalance(app.account);
        safeText(ui.vicBalance, fmtToken(vicWei, 18, 4) + ' VIC');
      }catch{ safeText(ui.vicBalance, '—'); }

      // VIN
      try{
        const bal = await app.contracts.vin.balanceOf(app.account);
        const dec = app.vinDecimals || 18;
        safeText(ui.vinBalance, fmtToken(bal, dec, 4) + ' VIN');
      }catch{ safeText(ui.vinBalance, '—'); }

      // Đăng ký
      try{
        const ok = await app.contracts.muaban.isRegistered(app.account);
        if (ui.btnRegister) ui.btnRegister.classList.toggle('hidden', !!ok);
        safeText(ui.statusLine, ok ? 'Đã đăng ký nền tảng.' : 'Chưa đăng ký. Phí đăng ký: 0.001 VIN');
      }catch{}
    }catch(e){
      console.debug('fullRefresh error:', e);
    }
  }

  /* ========= Gắn sự kiện ========= */
  function bindUI(){
    if (ui.btnRefresh){
      ui.btnRefresh.addEventListener('click', async () => {
        safeText(ui.statusLine, 'Đang làm mới…');
        await fullRefresh();
        safeText(ui.statusLine, 'Đã cập nhật.');
        setTimeout(() => safeText(ui.statusLine, ''), 1200);
      });
    }

    // Khi ví/chain thay đổi → reload cho đơn giản
    if (window.ethereum && window.ethereum.on){
      window.ethereum.on('accountsChanged', () => location.reload());
      window.ethereum.on('chainChanged',   () => location.reload());
    }
  }

  /* ========= Khởi động khi trang sẵn sàng ========= */
  function whenReady(){
    // Nếu Part 1 đã kết nối thì cập nhật UI
    if (app.account) {
      refreshAccountUI();
      fullRefresh();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindUI();

    // Nếu người dùng vừa bấm "Kết nối ví" ở Part 1, ta chờ contracts sẵn sàng rồi cập nhật
    const btnConnect = $('#btnConnect');
    if (btnConnect){
      btnConnect.addEventListener('click', () => {
        const tick = () => {
          if (app?.account && app?.contracts?.muaban && app?.contracts?.vin){
            refreshAccountUI();
            fullRefresh();
          } else {
            setTimeout(tick, 300);
          }
        };
        setTimeout(tick, 300);
      });
    }

    // Nếu trang reload mà ví đã kết nối & contracts có sẵn (trường hợp MetaMask nhớ phiên)
    if (app?.account && app?.contracts?.muaban && app?.contracts?.vin){
      refreshAccountUI();
      fullRefresh();
    }
  });

})();
</script>

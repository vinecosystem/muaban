<script>
(() => {
  'use strict';

  /* ========== Helpers DOM ========== */
  const $  = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const safeText = (el, t) => { if (el) el.textContent = t; };
  const safeShow = (el, show) => { if (!el) return; el.classList.toggle('hidden', !show); };
  const short = (a)=> a ? (a.slice(0,6)+'…'+a.slice(-4)) : '—';

  /* ========== Tham chiếu UI (tồn tại thì cập nhật, không có thì bỏ qua) ========== */
  const ui = {
    btnConnect  : $('#btnConnect'),
    walletInfo  : $('#walletInfo'),
    accountShort: $('#accountShort'),
    networkName : $('#networkName'),
    vinBalance  : $('#vinBalance'),
    vicBalance  : $('#vicBalance'),
    btnRegister : $('#btnRegister'),
    statusLine  : $('#statusLine'),

    // tuỳ chọn: link explorer
    linkAccount : $('#linkAccount'),
    linkMuaban  : $('#openContract') || $('#linkMuaban'),
    linkVin     : $('#openToken')    || $('#linkVinToken'),
  };

  /* ========== Config lấy từ index.html ========== */
  const CFG = (window.MUABAN_CONFIG || {});
  const MUABAN_ADDRESS    = CFG.MUABAN_ADDRESS;         // hợp đồng mua bán
  const VIN_TOKEN_ADDRESS = CFG.VIN_TOKEN;               // token VIN (ERC-20)
  const VIC_CHAIN_ID_HEX  = CFG.VIC_CHAIN_ID_HEX || '0x58';
  const VIC_NAME          = CFG.VIC_NAME || 'Viction Mainnet';

  // ethers UMD đã được nạp bằng <script ... ethers.umd.min.js defer>
  const ethers = window.ethers;

  /* ========== Trạng thái ứng dụng ========== */
  const app = {
    abis: { muaban: null, vin: null },
    provider: null,
    signer: null,
    account: null,
    chainIdHex: null,
    contracts: { muaban: null, vin: null },
    vinDecimals: 18,
  };
  window.muabanApp = app; // expose để debug

  function fmtToken(raw, decimals=18, maxFrac=4){
    try{
      const s = ethers.utils.formatUnits(raw||0, decimals);
      const [i,f=''] = s.split('.');
      const f4 = f.slice(0, maxFrac);
      return f4 ? `${i}.${f4}` : i;
    }catch{ return '0'; }
  }

  /* ========== Nạp ABI từ file JSON tĩnh (cùng thư mục) ========== */
  // Lý do: GitHub Pages là static, fetch JSON là phù hợp; ABI đã có trong repo.
  async function loadAbis(){
    const muabanPath = CFG.MUABAN_ABI_PATH || './Muaban_ABI.json';
    const vinPath    = './VinToken_ABI.json';
    const [r1, r2] = await Promise.all([
      fetch(muabanPath, { cache: 'no-store' }),
      fetch(vinPath,    { cache: 'no-store' }),
    ]);
    app.abis.muaban = await r1.json(); // Muaban_ABI.json
    app.abis.vin    = await r2.json(); // VinToken_ABI.json
  }

  /* ========== Đảm bảo đúng mạng Viction (0x58) ========== */
  async function ensureVictionChain(){
    const cur = await window.ethereum.request({ method: 'eth_chainId' });
    app.chainIdHex = cur;
    if (cur === VIC_CHAIN_ID_HEX) return;

    // thử switch trước
    try{
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: VIC_CHAIN_ID_HEX }]
      });
      app.chainIdHex = VIC_CHAIN_ID_HEX;
      return;
    }catch(e){
      // nếu chưa có chain, add chain
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
      }catch(err){
        throw new Error('Không thể chuyển sang mạng Viction.');
      }
    }
  }

  /* ========== Kết nối ví (auto) ========== */
  async function connectWallet(){
    if (!window.ethereum || !ethers) {
      // Không có ví — ẩn vùng ví và thoát êm
      safeShow(ui.walletInfo, false);
      return;
    }

    app.provider = new ethers.providers.Web3Provider(window.ethereum, 'any');

    // yêu cầu tài khoản
    const accounts = await app.provider.send('eth_requestAccounts', []);
    app.account = (accounts && accounts[0]) ? ethers.utils.getAddress(accounts[0]) : null;
    app.signer = app.provider.getSigner();

    // đảm bảo chain
    await ensureVictionChain();

    // nạp ABI & khởi tạo contracts
    if (!app.abis.muaban || !app.abis.vin) await loadAbis();
    app.contracts.muaban = new ethers.Contract(MUABAN_ADDRESS,    app.abis.muaban, app.signer);
    app.contracts.vin    = new ethers.Contract(VIN_TOKEN_ADDRESS, app.abis.vin,    app.signer);

    try { app.vinDecimals = await app.contracts.vin.decimals(); } catch { app.vinDecimals = 18; }

    // Cập nhật UI cơ bản
    safeShow(ui.walletInfo, true);
    if (ui.btnConnect) ui.btnConnect.style.display = 'none';
    safeText(ui.accountShort, short(app.account));
    safeText(ui.networkName, 'Viction');

    // Link explorer (nếu có phần tử)
    try{
      if (ui.linkAccount) ui.linkAccount.href = `https://vicscan.xyz/address/${app.account}`;
      if (ui.linkMuaban && MUABAN_ADDRESS) ui.linkMuaban.href = `https://vicscan.xyz/address/${MUABAN_ADDRESS}`;
      if (ui.linkVin    && VIN_TOKEN_ADDRESS) ui.linkVin.href = `https://vicscan.xyz/token/${VIN_TOKEN_ADDRESS}`;
    }catch{}

    // Lắng nghe thay đổi
    if (window.ethereum && window.ethereum.on){
      window.ethereum.on('accountsChanged', () => location.reload());
      window.ethereum.on('chainChanged',   () => location.reload());
      window.ethereum.on('disconnect',     () => location.reload());
    }

    // Làm mới số dư & trạng thái
    await Promise.all([refreshBalances(), refreshRegistrationUI()]);
  }

  /* ========== Số dư VIN/VIC ========== */
  async function refreshBalances(){
    if (!app.account || !app.provider) return;
    // VIC (native)
    try{
      const wei = await app.provider.getBalance(app.account);
      safeText(ui.vicBalance, fmtToken(wei, 18, 4) + ' VIC');
    }catch{ safeText(ui.vicBalance, '—'); }
    // VIN (ERC-20)
    try{
      const bal = await app.contracts.vin.balanceOf(app.account);
      safeText(ui.vinBalance, fmtToken(bal, app.vinDecimals||18, 4) + ' VIN');
    }catch{ safeText(ui.vinBalance, '—'); }
  }

  /* ========== Đăng ký nền tảng (0.001 VIN) ========== */
  const REG_FEE_WEI = ethers.BigNumber.from('1000000000000000'); // 1e15 wei

  async function refreshRegistrationUI(){
    if (!app.contracts?.muaban || !app.account) return;
    try{
      const ok = await app.contracts.muaban.isRegistered(app.account);
      if (ui.btnRegister) ui.btnRegister.classList.toggle('hidden', !!ok);
      safeText(ui.statusLine, ok ? 'Đã đăng ký nền tảng.' : 'Chưa đăng ký. Phí đăng ký: 0.001 VIN');
    }catch{}
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
      const tx = await app.contracts.muaban.payRegistration(); // requires approve trước
      await tx.wait(1);
      safeText(ui.statusLine, 'Đăng ký thành công.');
      await Promise.all([refreshBalances(), refreshRegistrationUI()]);
    }catch(e){
      console.error(e);
      safeText(ui.statusLine, e?.data?.message || e?.message || 'Đăng ký thất bại.');
    }
  }

  /* ========== Bind UI + Auto connect khi mở trang ========== */
  document.addEventListener('DOMContentLoaded', ()=>{
    // Ẩn vùng ví lúc đầu
    safeShow(ui.walletInfo, false);
    if (ui.networkName) safeText(ui.networkName, '—');

    // Nếu vẫn còn nút Kết nối ví trong HTML, bỏ luôn (yêu cầu của bạn)
    try { ui.btnConnect?.remove(); } catch {}

    // Nút Đăng ký (nếu có)
    if (ui.btnRegister) ui.btnRegister.addEventListener('click', async ()=>{
      if (!app.account) { alert('Hãy mở & kết nối ví EVM (MetaMask).'); return; }
      await handleRegister();
    });

    // Tự động kết nối ví khi mở trang
    (async () => {
      try{
        await connectWallet();
      }catch(err){
        // Không spam alert; chỉ log và để người dùng tự mở ví nếu muốn
        console.debug('Auto-connect skipped:', err?.message || err);
      }
    })();
  });

})();
</script>
<script>
(() => {
  'use strict';

  const ethers = window.ethers;
  const app    = window.muabanApp || {};
  const CFG    = (window.MUABAN_CONFIG || {});
  const MUABAN_ADDRESS = CFG.MUABAN_ADDRESS;

  const $ = (s, r=document) => r.querySelector(s);
  const safeText = (el, t) => { if (el) el.textContent = t; };

  /* ===== Helpers số học giống hợp đồng =====
     USD cents -> VIN (wei) theo công thức ceil(usdCents * vinPerUSD / 100)
     để khớp _usdCentsToVin() trong contract. :contentReference[oaicite:3]{index=3} */
  function usdCentsToVinWei(usdCentsBN, vinPerUSDBN){
    // (usdCents * vinPerUSD + 99) / 100
    const num = usdCentsBN.mul(vinPerUSDBN);
    return num.add(ethers.BigNumber.from(99)).div(100);
  }

  /* Lấy thông tin Product từ contract: products(productId) trả về struct. :contentReference[oaicite:4]{index=4} */
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

  /* Tính tổng VIN phải escrow cho đơn (vinTotal) bằng công thức trong contract:
     - priceUsdCentsAll = priceUsdCents * qty
     - taxUsdCents = ceil(priceUsdCentsAll * taxBps / 10_000)
     - vinTotal = ceil(price * vinPerUSD/100) + ceil(ship * vinPerUSD/100) + ceil(tax * vinPerUSD/100)
     Hợp đồng cũng làm đúng như vậy trước khi _pullVIN(). :contentReference[oaicite:5]{index=5} */
  async function quoteVinTotalWei(productId, qty, vinPerUSDWei){
    const p = await getProduct(productId);

    if (!p.active) throw new Error('Sản phẩm đang ẩn.');
    if (p.stock.lt(qty)) throw new Error('Tồn kho không đủ.');

    const priceAll = p.priceUsdCents.mul(qty);
    const ship = p.shippingUsdCents;

    // taxUsdCents = (priceAll * taxBps + 9_999)/10_000  (ceil)  :contentReference[oaicite:6]{index=6}
    const taxUsd = priceAll.mul(p.taxRateBps).add(9999).div(10000);

    const vinRev = usdCentsToVinWei(priceAll, vinPerUSDWei);
    const vinShip = usdCentsToVinWei(ship, vinPerUSDWei);
    const vinTax = usdCentsToVinWei(taxUsd, vinPerUSDWei);
    const vinTotal = vinRev.add(vinShip).add(vinTax);
    if (vinTotal.lte(0)) throw new Error('VIN tổng bằng 0.');
    return { vinRev, vinShip, vinTax, vinTotal };
  }

  /* Thu thập form giao hàng (đơn giản): nếu thiếu thì throw. */
  function collectShipping(){
    const name = $('#shipName')?.value?.trim();
    const phone = $('#shipPhone')?.value?.trim();
    const addr = $('#shipAddr')?.value?.trim();
    const note = $('#shipNote')?.value?.trim() || '';
    if (!name || !phone || !addr) throw new Error('Điền đủ Tên, SĐT và Địa chỉ giao hàng.');
    // Ở bản tối giản: đóng gói JSON rồi encode bytes (UTF-8)
    const obj = { name, phone, addr, note };
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    // ABI cần 'bytes' → ethers.utils.hexlify(Uint8Array)
    return ethers.utils.hexlify(bytes);
  }

  /* Approve VIN đúng bằng vinTotal cho Muaban (spender = MUABAN_ADDRESS). */
  async function approveVin(amountWei){
    const allowance = await app.contracts.vin.allowance(app.account, MUABAN_ADDRESS);
    if (allowance.gte(amountWei)) return true;
    const tx = await app.contracts.vin.approve(MUABAN_ADDRESS, amountWei);
    await tx.wait(1);
    return true;
  }

  /* Đặt hàng: placeOrder(productId, quantity, vinPerUSD, shippingInfoCiphertext)  :contentReference[oaicite:7]{index=7} */
  async function placeOrder(){
    if (!app.signer) { alert('Hãy mở ví EVM và kết nối.'); return; }

    // Phải là ví đã đăng ký nền tảng (modifier onlyRegistered). :contentReference[oaicite:8]{index=8}
    const reg = await app.contracts.muaban.isRegistered(app.account);
    if (!reg) { alert('Ví chưa đăng ký. Vui lòng trả phí 0.001 VIN trước.'); return; }

    const pid = parseInt($('#productId')?.value || '0', 10);
    const qty = Math.max(1, parseInt($('#quantity')?.value || '1', 10));
    // vinPerUSD nhập bằng số thập phân VIN; chuyển sang wei: x * 1e18
    // Nếu bạn đã nhập sẵn "wei" thì bỏ dòng parseFloat và đọc trực tiếp.
    const vinPerUSDInput = ($('#vinPerUSD')?.value || '').trim();
    if (!vinPerUSDInput) { alert('Nhập vinPerUSD (VIN wei trên 1 USD).'); return; }
    let vinPerUSDWei;
    try {
      // Cho phép người dùng nhập dạng thập phân, ví dụ "12.34" VIN -> parseUnits
      vinPerUSDWei = ethers.utils.parseUnits(vinPerUSDInput, 18);
    } catch {
      // Hoặc nếu họ đã nhập sẵn "wei" (số nguyên rất lớn), thử BigNumber trực tiếp
      vinPerUSDWei = ethers.BigNumber.from(vinPerUSDInput);
    }

    try{
      // Tính vinTotal giống hợp đồng để approve chính xác
      const { vinTotal } = await quoteVinTotalWei(pid, qty, vinPerUSDWei);

      // Thu thập & mã hoá (đơn giản) shipping info
      const shipBytes = collectShipping();

      // Approve
      await approveVin(vinTotal);

      // Gọi placeOrder → VIN sẽ bị _pullVIN(...) vào escrow của hợp đồng. :contentReference[oaicite:9]{index=9}
      const tx = await app.contracts.muaban.placeOrder(pid, qty, vinPerUSDWei, shipBytes);
      alert('Đang gửi giao dịch đặt hàng…');
      const rc = await tx.wait(1);
      // Bạn có thể lấy orderId từ event OrderPlaced nếu cần; ở bản tối giản chỉ báo thành công.
      alert('Đặt hàng thành công! Hãy xem đơn trong tab Orders/VicScan.');
    }catch(e){
      console.error(e);
      alert(e?.data?.message || e?.message || 'Đặt hàng thất bại.');
    }
  }

  /* Buyer xác nhận nhận hàng: confirmReceipt(orderId)  :contentReference[oaicite:10]{index=10} */
  async function confirmReceipt(){
    if (!app.signer) { alert('Kết nối ví trước.'); return; }
    const oid = parseInt($('#orderId')?.value || '0', 10);
    if (!oid) { alert('Nhập Order ID.'); return; }
    try{
      const tx = await app.contracts.muaban.confirmReceipt(oid);
      alert('Đang gửi xác nhận nhận hàng…');
      await tx.wait(1);
      alert('Đã giải ngân escrow cho người bán.');
    }catch(e){
      console.error(e);
      alert(e?.data?.message || e?.message || 'Xác nhận thất bại.');
    }
  }

  /* Hoàn tiền khi quá hạn: refundIfExpired(orderId)  :contentReference[oaicite:11]{index=11} */
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

  /* Gắn sự kiện nút tối giản (nếu phần tử tồn tại thì bind; không thì bỏ qua) */
  document.addEventListener('DOMContentLoaded', () => {
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
  });
})();
</script>

/* ==========================================================================
   muaban — app.js (ethers v5)
   Chain: Viction (VIC, chainId 88)
   Contract: Muaban @ window.MUABAN_CONFIG.MUABAN_ADDRESS
   Token:    VIN    @ window.MUABAN_CONFIG.VIN_TOKEN

   Tính năng:
   - Kết nối ví, kiểm tra mạng 88
   - Đăng ký nền tảng (0.001 VIN): approve -> payRegistration
   - Quét sản phẩm từ event ProductCreated, lọc & tìm kiếm
   - Mua hàng (escrow): quoteVinForProduct -> approve -> placeOrder
   - Đơn hàng của tôi: quét OrderPlaced(buyer), theo dõi deadline, confirm/refund
   - Bán hàng: tạo sản phẩm, sửa, ẩn/hiện (setProductActive)
   ========================================================================== */
(function () {
  'use strict';

  // -------------------- DOM helpers --------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const byId = (id) => document.getElementById(id);

  // Elements
  const yearEl = byId('year');
  const btnConnect = byId('btnConnect');
  const walletInfo = byId('walletInfo');
  const accountShortEl = byId('accountShort');
  const networkNameEl = byId('networkName');
  const toastEl = byId('toast');

  // Tabs
  const tabButtons = $$('.tabs .tab');
  const tabPanels = $$('.tab-panel');
  const tabBrowse = byId('tab-browse');
  const tabOrders = byId('tab-orders');
  const tabSell   = byId('tab-sell');

  // Browse
  const productGrid = byId('productGrid');
  const tplProductCard = byId('tplProductCard');
  const searchKeyword = byId('searchKeyword');
  const searchSeller  = byId('searchSeller');
  const priceMin = byId('priceMin');
  const priceMax = byId('priceMax');
  const filterInStock = byId('filterInStock');
  const btnSearch = byId('btnSearch');
  const btnReset  = byId('btnReset');

  // Modals
  const dlgProduct = byId('dlgProduct');
  const dlgProdName = byId('dlgProdName');
  const dlgProdImg = byId('dlgProdImg');
  const dlgDescLink = byId('dlgDescLink');
  const dlgSeller = byId('dlgSeller');
  const dlgPriceUsd = byId('dlgPriceUsd');
  const dlgShipUsd  = byId('dlgShipUsd');
  const dlgTaxRate  = byId('dlgTaxRate');
  const dlgDelivDays= byId('dlgDelivDays');
  const dlgStock    = byId('dlgStock');
  const dlgVicPrice = byId('dlgVicPrice');
  const dlgVinUsd   = byId('dlgVinUsd');
  const buyQty      = byId('buyQty');
  const shipName    = byId('shipName');
  const shipPhone   = byId('shipPhone');
  const shipAddr    = byId('shipAddr');
  const shipNote    = byId('shipNote');
  const qRev   = byId('qRev');
  const qShip  = byId('qShip');
  const qTax   = byId('qTax');
  const qTotal = byId('qTotal');
  const btnApproveBuy = byId('btnApproveBuy');
  const btnPlaceOrder = byId('btnPlaceOrder');
  const buyStatus     = byId('buyStatus');

  // Orders
  const orderList = byId('orderList');
  const tplOrderItem = byId('tplOrderItem');

  // Sell / Registration
  const regStatus = byId('regStatus');
  const btnCheckReg = byId('btnCheckReg');
  const btnApproveReg = byId('btnApproveReg');
  const btnPayReg = byId('btnPayReg');

  // Sell / Create product
  const formCreate = byId('formCreate');
  const btnClearCreate = byId('btnClearCreate');
  const btnLoadMyProducts = byId('btnLoadMyProducts');
  const myProducts = byId('myProducts');
  const tplMyProduct = byId('tplMyProduct');

  // Edit modal
  const dlgEdit = byId('dlgEditProduct');
  const formEdit = $('#formEdit', dlgEdit);
  const btnDoUpdate = byId('btnDoUpdate');

  // Price chips in header (already set by index.html)
  const vicPriceEl = byId('vicPrice');
  const vinUsdEl   = byId('vinUsd');

  // Footer links
  const openContract = byId('openContract');

  // -------------------- Runtime state --------------------
  const CFG = window.MUABAN_CONFIG || {};
  const CHAIN_ID_HEX = CFG.VIC_CHAIN_ID_HEX || '0x58';
  const MUABAN_ADDR  = CFG.MUABAN_ADDRESS;
  const VIN_ADDR     = CFG.VIN_TOKEN;

  let provider, signer, account, chainId;
  let muaban, vin;          // ethers.Contract
  let ABI_CACHE = null;
  let VIN_DECIMALS = 18;    // default, will read on connect
  let lastVicUsd = null;    // for quoting
  let lastVinPerUSDWei = null; // vinPerUSD in wei (VIN wei per 1 USD), from VIC/USDT × 100

  // Browse cache
  let PRODUCTS = new Map(); // productId -> product (struct)
  let PRODUCT_IDS = [];     // for rendering order
  let CURRENT_DETAIL = null;// {product, productId}

  // -------------------- Utils --------------------
  const sleep = (ms)=> new Promise(r => setTimeout(r, ms));

  const showToast = (msg, timeout=2200) => {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(()=> toastEl.classList.remove('show'), timeout);
  };

  const shortAddr = (a) => a ? (a.slice(0,6)+'…'+a.slice(-4)) : '—';

  const nowSec = ()=> Math.floor(Date.now()/1000);

  const toUsdCents = (usdStr) => {
    if (!usdStr || Number.isNaN(parseFloat(usdStr))) return 0;
    // allow decimals → cents (round to nearest cent)
    return Math.round(parseFloat(usdStr)*100);
  };

  const fromUsdCents = (cents) => (Number(cents||0)/100).toFixed(2);

  const bpsFromPercent = (p) => Math.round(parseFloat(p||0)*100); // % -> bps

  const parseHexOrBase64ToBytes = (txt) => {
    if (!txt) return '0x';
    const s = txt.trim();
    if (/^0x[0-9a-fA-F]*$/.test(s)) return s;
    try {
      // base64 → bytes
      const bin = atob(s);
      let hex = '0x';
      for (let i=0;i<bin.length;i++) {
        const h = bin.charCodeAt(i).toString(16).padStart(2,'0');
        hex += h;
      }
      return hex;
    } catch(e) {
      // fallback: utf-8
      return ethers.utils.hexlify(ethers.utils.toUtf8Bytes(s));
    }
  };

  // vinPerUSD (wei) from VIC/USDT × 100
  const computeVinPerUSDWei = (vicUsd) => {
    if (!isFinite(vicUsd) || vicUsd <= 0) return null;
    // vinPerUSD tokens = vicUsd * 100
    // convert to wei: mul by 1eVIN_DECIMALS
    const vinPerUSDtokens = ethers.BigNumber.from(Math.round(vicUsd*100).toString()); // keep 2 decimals precision rough
    const scale = ethers.BigNumber.from(10).pow(VIN_DECIMALS);
    return vinPerUSDtokens.mul(scale);
  };

  // Format VIN amount in tokens from wei
  const fmtVIN = (wei) => {
    try {
      return Number(ethers.utils.formatUnits(wei, VIN_DECIMALS)).toLocaleString('vi-VN', {maximumFractionDigits: 6});
    } catch{
      return '—';
    }
  };

  const ensureAbi = async () => {
    if (ABI_CACHE) return ABI_CACHE;
    const res = await fetch(CFG.MUABAN_ABI_PATH || './Muaban_ABI.json', {cache:'no-store'});
    ABI_CACHE = await res.json();
    return ABI_CACHE;
  };

  const getVicUsd = async () => {
    // index.html đã hiển thị, nhưng app.js vẫn tự fetch để dùng khi quote/mua
    try {
      const url = CFG.BINANCE_VICUSDT || 'https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT';
      const res = await fetch(url, {cache:'no-store'});
      const data = await res.json();
      const vic = parseFloat(data?.price);
      if (!isFinite(vic)) throw new Error('VIC price invalid');
      lastVicUsd = vic;
      lastVinPerUSDWei = computeVinPerUSDWei(vic);
      return vic;
    } catch (e) {
      lastVicUsd = null;
      lastVinPerUSDWei = null;
      return null;
    }
  };

  const requireProvider = () => {
    if (!window.ethereum) throw new Error('Không thấy ví EVM. Hãy cài MetaMask/Brave…');
  };

  const requireSigner = () => {
    if (!signer || !account) throw new Error('Vui lòng kết nối ví trước.');
  };

  const switchToVictionIfNeeded = async () => {
    const target = CHAIN_ID_HEX;
    const cur = await provider.send('eth_chainId', []);
    if (cur !== target) {
      try {
        await provider.send('wallet_switchEthereumChain', [{ chainId: target }]);
      } catch (e) {
        throw new Error('Hãy thêm và chuyển sang Viction (chainId 88).');
      }
    }
  };

  // -------------------- Init & Connect --------------------
  const init = async () => {
    try {
      yearEl && (yearEl.textContent = new Date().getFullYear());
      openContract && (openContract.href = `https://vicscan.xyz/address/${MUABAN_ADDR}`);

      // Tabs
      tabButtons.forEach(btn=>{
        btn.addEventListener('click', ()=>{
          tabButtons.forEach(b=>b.classList.remove('active'));
          tabPanels.forEach(p=>p.classList.remove('active'));
          btn.classList.add('active');
          const id = btn.getAttribute('data-tab');
          byId(`tab-${id}`).classList.add('active');
          if (id==='browse') renderBrowse();
          if (id==='orders') loadMyOrders();
          if (id==='sell')   refreshRegistration();
        });
      });

      // Search
      btnSearch.addEventListener('click', renderBrowse);
      btnReset.addEventListener('click', ()=>{
        searchKeyword.value='';
        searchSeller.value='';
        priceMin.value=''; priceMax.value='';
        filterInStock.checked = true;
        renderBrowse();
      });

      // Registration
      btnCheckReg.addEventListener('click', refreshRegistration);
      btnApproveReg.addEventListener('click', approveRegistrationFee);
      btnPayReg.addEventListener('click', payRegistration);

      // Create product
      formCreate.addEventListener('submit', onCreateProduct);
      btnClearCreate.addEventListener('click', ()=> formCreate.reset());
      btnLoadMyProducts.addEventListener('click', loadMyProducts);

      // Edit product modal actions
      btnDoUpdate.addEventListener('click', doUpdateProduct);

      // Product dialog actions
      if (dlgProduct) {
        buyQty.addEventListener('input', recalcQuoteInModal);
        btnApproveBuy.addEventListener('click', approveForPurchase);
        btnPlaceOrder.addEventListener('click', placeOrder);
      }

      // Connect button
      btnConnect.addEventListener('click', connectWallet);

      // Preload ABI & price & products (for browse even when not connected)
      await ensureAbi();
      await getVicUsd();
      await buildContractsReadonly(); // read-only provider for events
      await indexAllProducts();

      renderBrowse();
    } catch (e) {
      console.error(e);
      showToast(e.message || 'Lỗi khởi tạo');
    }
  };

  const buildContractsReadonly = async () => {
    // read-only default provider: use window.ethereum if exists, otherwise public RPC
    const rpc = CFG.RPC_URL || 'https://rpc.viction.xyz';
    const roProv = window.ethereum ? new ethers.providers.Web3Provider(window.ethereum) : new ethers.providers.JsonRpcProvider(rpc);
    const ABI = await ensureAbi();
    muaban = new ethers.Contract(MUABAN_ADDR, ABI, roProv);
    // VIN chỉ cần khi đã connect (để approve), nhưng tạo sẵn ro:
    vin    = new ethers.Contract(VIN_ADDR, [
      // minimal ERC20 ABI
      "function decimals() view returns (uint8)",
      "function balanceOf(address) view returns (uint256)",
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)"
    ], roProv);
    try {
      VIN_DECIMALS = Number(await vin.decimals());
    } catch {
      VIN_DECIMALS = 18;
    }
  };

  const connectWallet = async () => {
    try {
      requireProvider();
      provider = new ethers.providers.Web3Provider(window.ethereum);
      await provider.send('eth_requestAccounts', []);
      await switchToVictionIfNeeded();

      signer  = provider.getSigner();
      account = await signer.getAddress();
      chainId = await signer.getChainId();

      // Rebuild contracts with signer
      const ABI = await ensureAbi();
      muaban = new ethers.Contract(MUABAN_ADDR, ABI, signer);
      vin    = new ethers.Contract(VIN_ADDR, [
        "function decimals() view returns (uint8)",
        "function balanceOf(address) view returns (uint256)",
        "function allowance(address,address) view returns (uint256)",
        "function approve(address,uint256) returns (bool)"
      ], signer);

      try { VIN_DECIMALS = Number(await vin.decimals()); } catch {}

      // UI
      btnConnect.classList.add('hidden');
      walletInfo.classList.remove('hidden');
      accountShortEl.textContent = shortAddr(account);
      networkNameEl.textContent = 'Viction (88)';

      showToast('Đã kết nối ví');
      refreshRegistration();
      // auto-load "Sản phẩm của tôi" nếu đang ở tab SELL
      if (tabSell.classList.contains('active')) loadMyProducts();
    } catch (e) {
      console.error(e);
      showToast(e.message || 'Kết nối ví thất bại');
    }
  };

  // -------------------- Registration --------------------
  const refreshRegistration = async () => {
    try {
      if (!muaban) await buildContractsReadonly();
      if (!account && window.ethereum) {
        const accs = await window.ethereum.request({ method: 'eth_accounts' });
        if (accs && accs[0]) account = accs[0];
      }
      if (!account) {
        regStatus.textContent = 'Chưa kết nối ví';
        regStatus.className = 'badge';
        return;
      }
      const ok = await muaban.isRegistered(account);
      regStatus.textContent = ok ? 'Đã đăng ký' : 'Chưa đăng ký';
      regStatus.className = 'badge';
      if (ok) regStatus.classList.add('success');
    } catch (e) {
      regStatus.textContent = 'Lỗi kiểm tra';
    }
  };

  const approveRegistrationFee = async () => {
    try {
      requireSigner();
      const fee = await muaban.PLATFORM_FEE(); // 0.001 VIN (wei)
      const cur = await vin.allowance(account, MUABAN_ADDR);
      if (cur.gte(fee)) {
        showToast('Đã đủ allowance 0.001 VIN');
        return;
      }
      const tx = await vin.approve(MUABAN_ADDR, fee);
      showToast('Đang approve 0.001 VIN…');
      await tx.wait();
      showToast('Approve thành công');
    } catch (e) {
      console.error(e);
      showToast(e?.data?.message || e.message || 'Approve lỗi');
    }
  };

  const payRegistration = async () => {
    try {
      requireSigner();
      const tx = await muaban.payRegistration({ gasPrice: ethers.utils.parseUnits('0.5', 'gwei') });
      showToast('Đang trả phí 0.001 VIN…');
      await tx.wait();
      showToast('Đăng ký thành công');
      refreshRegistration();
    } catch (e) {
      console.error(e);
      showToast(e?.data?.message || e.message || 'Trả phí lỗi');
    }
  };

  // -------------------- Products indexing --------------------
  const indexAllProducts = async () => {
    try {
      if (!muaban) await buildContractsReadonly();

      // Quét event ProductCreated từ block 0
      const topicCreated = muaban.interface.getEventTopic('ProductCreated');
      const logs = await muaban.provider.getLogs({
        address: MUABAN_ADDR,
        topics: [topicCreated],
        fromBlock: 0,
        toBlock: 'latest'
      });

      // Lấy productId từ log & fetch chi tiết
      const ids = new Set();
      for (const lg of logs) {
        try {
          const parsed = muaban.interface.parseLog(lg);
          const pid = parsed.args.productId.toString();
          ids.add(pid);
        } catch {}
      }
      PRODUCT_IDS = Array.from(ids.values());
      PRODUCTS.clear();

      // Fetch chi tiết
      for (const pid of PRODUCT_IDS) {
        try {
          const p = await muaban.getProduct(pid);
          PRODUCTS.set(pid, p);
        } catch (e) {
          console.warn('getProduct fail', pid, e);
        }
      }
    } catch (e) {
      console.error('indexAllProducts', e);
    }
  };

  // -------------------- Browse render & search --------------------
  const renderBrowse = async () => {
    try {
      await indexAllProducts(); // refresh nhẹ; có thể tối ưu bằng cache+TTL nếu cần
      const kw = (searchKeyword.value || '').trim().toLowerCase();
      const seller = (searchSeller.value || '').trim().toLowerCase();
      const minUsd = priceMin.value ? parseFloat(priceMin.value) : null;
      const maxUsd = priceMax.value ? parseFloat(priceMax.value) : null;
      const inStock = filterInStock.checked;

      productGrid.innerHTML = '';
      if (!PRODUCT_IDS.length) {
        productGrid.innerHTML = `<div class="card muted">Chưa có sản phẩm on-chain.</div>`;
        return;
      }

      for (const pid of PRODUCT_IDS) {
        const p = PRODUCTS.get(pid);
        if (!p) continue;

        const name = p.name || '';
        const sellerAddr = (p.seller || '').toLowerCase();

        // USD filter
        const priceUsd = Number(fromUsdCents(p.priceUsdCents));
        if (minUsd != null && priceUsd < minUsd) continue;
        if (maxUsd != null && priceUsd > maxUsd) continue;

        // keyword filter
        if (kw && !name.toLowerCase().includes(kw)) continue;

        // seller filter
        if (seller && sellerAddr !== seller) continue;

        if (inStock && p.stock.toString() === '0') continue;
        if (!p.active) continue; // chỉ hiển thị đang bán

        // Render
        const card = tplProductCard.content.cloneNode(true);
        const img = $('.prod-img', card);
        const nm  = $('.prod-name', card);
        const saddr= $('.seller-addr', card);
        const usd = $('.usd-val', card);
        const vin = $('.vin-val', card);
        const ship= $('.ship-usd', card);
        const tax = $('.tax-rate', card);
        const dmax= $('.delivery-days', card);
        const stk = $('.stock', card);
        const btn = $('.btn-view', card);

        img.src = `https://ipfs.io/ipfs/${p.imageCID}`;
        img.alt = name;
        nm.textContent = name;
        saddr.textContent = shortAddr(p.seller);
        usd.textContent = priceUsd.toFixed(2);
        ship.textContent = Number(fromUsdCents(p.shippingUsdCents));
        tax.textContent = (Number(p.taxRateBps)/100).toFixed(2);
        dmax.textContent = p.deliveryDaysMax.toString();
        stk.textContent  = p.stock.toString();

        // Ước tính VIN ~(USD × vinPerUSD), lấy từ lastVicUsd
        let approxVin = '—';
        if (lastVicUsd) {
          const vinPerUSD = lastVicUsd * 100; // tokens per USD
          approxVin = (priceUsd * vinPerUSD).toFixed(2);
        }
        vin.textContent = approxVin;

        btn.addEventListener('click', ()=> openProductModal(pid));
        productGrid.appendChild(card);
      }

      if (!productGrid.children.length) {
        productGrid.innerHTML = `<div class="card muted">Không tìm thấy sản phẩm phù hợp bộ lọc.</div>`;
      }
    } catch (e) {
      console.error(e);
      productGrid.innerHTML = `<div class="card muted">Lỗi tải danh sách.</div>`;
    }
  };

  // -------------------- Product modal & purchase --------------------
  const openProductModal = async (pid) => {
    try {
      const p = await muaban.getProduct(pid);
      CURRENT_DETAIL = { product: p, productId: pid };

      dlgProdName.textContent = p.name;
      dlgProdImg.src = `https://ipfs.io/ipfs/${p.imageCID}`;
      dlgDescLink.href = `https://ipfs.io/ipfs/${p.descriptionCID}`;
      dlgSeller.textContent = shortAddr(p.seller);
      dlgPriceUsd.textContent = fromUsdCents(p.priceUsdCents);
      dlgShipUsd.textContent  = fromUsdCents(p.shippingUsdCents);
      dlgTaxRate.textContent  = (Number(p.taxRateBps)/100).toFixed(2);
      dlgDelivDays.textContent= p.deliveryDaysMax.toString();
      dlgStock.textContent    = p.stock.toString();

      // Đồng bộ tỷ giá trong dialog
      if (lastVicUsd) {
        dlgVicPrice.textContent = lastVicUsd.toFixed(4);
        const vinUsd = lastVicUsd * 100; // 1 VIN ≈ X USD (theo yêu cầu hiển thị)
        dlgVinUsd.textContent = vinUsd.toFixed(2);
      } else {
        dlgVicPrice.textContent = '—';
        dlgVinUsd.textContent   = '—';
      }

      buyQty.value = '1';
      recalcQuoteInModal();

      dlgProduct.showModal();
    } catch (e) {
      console.error(e);
      showToast('Không tải được chi tiết sản phẩm');
    }
  };

  const recalcQuoteInModal = async () => {
    if (!CURRENT_DETAIL) return;
    try {
      const q = Math.max(1, parseInt(buyQty.value||'1', 10));
      if (!lastVicUsd) await getVicUsd();
      if (!lastVinPerUSDWei) throw new Error('Chưa có tỷ giá');

      const pid = CURRENT_DETAIL.productId;
      const [vinRev, vinShip, vinTax, vinTot] = await muaban.quoteVinForProduct(pid, q, lastVinPerUSDWei);
      qRev.textContent   = fmtVIN(vinRev);
      qShip.textContent  = fmtVIN(vinShip);
      qTax.textContent   = fmtVIN(vinTax);
      qTotal.textContent = fmtVIN(vinTot);
    } catch (e) {
      qRev.textContent = qShip.textContent = qTax.textContent = qTotal.textContent = '—';
    }
  };

  const approveForPurchase = async () => {
    try {
      requireSigner();
      if (!CURRENT_DETAIL) throw new Error('Chưa chọn sản phẩm');
      const q = Math.max(1, parseInt(buyQty.value||'1', 10));
      if (!lastVicUsd) await getVicUsd();
      if (!lastVinPerUSDWei) throw new Error('Chưa có tỷ giá');

      const pid = CURRENT_DETAIL.productId;
      const [, , , vinTot] = await muaban.quoteVinForProduct(pid, q, lastVinPerUSDWei);

      const cur = await vin.allowance(account, MUABAN_ADDR);
      if (cur.gte(vinTot)) {
        showToast('Đã đủ allowance VIN');
        return;
      }
      const tx = await vin.approve(MUABAN_ADDR, vinTot);
      buyStatus.textContent = 'Đang approve VIN…';
      await tx.wait();
      buyStatus.textContent = 'Approve xong.';
      showToast('Approve thành công');
    } catch (e) {
      console.error(e);
      buyStatus.textContent = e?.data?.message || e.message || 'Approve lỗi';
    }
  };

  const placeOrder = async () => {
    try {
      requireSigner();
      const q = Math.max(1, parseInt(buyQty.value||'1', 10));
      if (!CURRENT_DETAIL) throw new Error('Chưa chọn sản phẩm');

      if (!lastVicUsd) await getVicUsd();
      if (!lastVinPerUSDWei) throw new Error('Chưa có tỷ giá');
      const pid = CURRENT_DETAIL.productId;

      // Gói “shipping info” → bytes (mã hoá đơn giản)
      const payload = {
        name:  (shipName.value||'').trim(),
        phone: (shipPhone.value||'').trim(),
        addr:  (shipAddr.value||'').trim(),
        note:  (shipNote.value||'').trim()
      };
      const plaintext = JSON.stringify(payload);
      const ciphertext = ethers.utils.hexlify(ethers.utils.toUtf8Bytes(plaintext));

      const tx = await muaban.placeOrder(pid, q, lastVinPerUSDWei, ciphertext, {
        gasPrice: ethers.utils.parseUnits('0.5','gwei')
      });
      buyStatus.textContent = 'Đang tạo đơn…';
      const rc = await tx.wait();
      const ev = rc.events?.find(e=> e.event==='OrderPlaced');
      if (ev) {
        const oid = ev.args?.orderId?.toString();
        buyStatus.textContent = `Mua thành công. Mã đơn #${oid}`;
      } else {
        buyStatus.textContent = 'Mua thành công.';
      }
      showToast('Đã tạo đơn hàng');
      dlgProduct.close();
    } catch (e) {
      console.error(e);
      buyStatus.textContent = e?.data?.message || e.message || 'Đặt mua lỗi';
    }
  };

  // -------------------- Orders (mine) --------------------
  const loadMyOrders = async () => {
    try {
      if (!muaban) await buildContractsReadonly();
      orderList.innerHTML = '';

      // Lấy địa chỉ ví (kể cả khi chưa ấn “Kết nối”)
      let addr = account;
      if (!addr && window.ethereum) {
        const accs = await window.ethereum.request({ method: 'eth_accounts' });
        if (accs && accs[0]) addr = accs[0];
      }
      if (!addr) {
        orderList.innerHTML = `<div class="card muted">Hãy kết nối ví để xem đơn hàng.</div>`;
        return;
      }

      const topicPlaced = muaban.interface.getEventTopic('OrderPlaced');
      // indexed: orderId (uint256), productId (uint256), buyer (address)
      const buyerTopic = ethers.utils.hexZeroPad(addr, 32).toLowerCase();

      const logs = await muaban.provider.getLogs({
        address: MUABAN_ADDR,
        topics: [topicPlaced, null, null, buyerTopic],
        fromBlock: 0, toBlock: 'latest'
      });

      if (!logs.length) {
        orderList.innerHTML = `<div class="card muted">Bạn chưa có đơn hàng.</div>`;
        return;
      }

      for (const lg of logs) {
        try {
          const parsed = muaban.interface.parseLog(lg);
          const oid = parsed.args.orderId.toString();
          const o = await muaban.getOrder(oid);

          const node = tplOrderItem.content.cloneNode(true);
          $('.oid', node).textContent = oid;
          $('.pid', node).textContent = o.productId.toString();
          $('.qty', node).textContent = o.quantity.toString();
          $('.vin-total', node).textContent = fmtVIN(o.vinAmountTotal);
          $('.placed-at', node).textContent = new Date(Number(o.placedAt)*1000).toLocaleString('vi-VN', {hour12:false});
          $('.deadline', node).textContent = new Date(Number(o.deadline)*1000).toLocaleString('vi-VN', {hour12:false});

          const stBadge = $('.status', node);
          const btnC = $('.btn-confirm', node);
          const btnR = $('.btn-refund', node);
          const btnScan = $('.btn-vicscan', node);
          btnScan.href = `https://vicscan.xyz/tx/${lg.transactionHash}`;

          // status: 0=PLACED, 1=RELEASED, 2=REFUNDED
          const status = Number(o.status);
          const now = nowSec();
          if (status===0) {
            stBadge.textContent = 'Đang giao';
            if (now < Number(o.deadline)) {
              btnC.disabled = false; // Confirm nếu chưa quá hạn
            } else {
              btnR.disabled = false; // Refund nếu đã quá hạn
            }
          } else if (status===1) {
            stBadge.textContent = 'Đã nhận hàng';
          } else if (status===2) {
            stBadge.textContent = 'Đã hoàn tiền';
          } else {
            stBadge.textContent = '—';
          }

          btnC.addEventListener('click', async ()=>{
            try {
              requireSigner();
              const tx = await muaban.confirmReceipt(o.orderId, { gasPrice: ethers.utils.parseUnits('0.5','gwei') });
              showToast('Xác nhận nhận hàng…');
              await tx.wait();
              showToast('Đã xác nhận');
              loadMyOrders();
            } catch (e) {
              showToast(e?.data?.message || e.message || 'Lỗi xác nhận');
            }
          });

          btnR.addEventListener('click', async ()=>{
            try {
              requireSigner();
              const tx = await muaban.refundIfExpired(o.orderId, { gasPrice: ethers.utils.parseUnits('0.5','gwei') });
              showToast('Yêu cầu hoàn tiền…');
              await tx.wait();
              showToast('Đã hoàn tiền (nếu đủ điều kiện)');
              loadMyOrders();
            } catch (e) {
              showToast(e?.data?.message || e.message || 'Lỗi hoàn tiền');
            }
          });

          orderList.appendChild(node);
        } catch (e) {
          console.warn('order parse fail', e);
        }
      }
    } catch (e) {
      console.error(e);
      orderList.innerHTML = `<div class="card muted">Lỗi tải đơn hàng.</div>`;
    }
  };

  // -------------------- Seller: create / my products / edit --------------------
  const onCreateProduct = async (ev) => {
    ev.preventDefault();
    try {
      requireSigner();
      await refreshRegistration();
      const ok = await muaban.isRegistered(account);
      if (!ok) throw new Error('Bạn chưa đăng ký nền tảng (0.001 VIN).');

      const fd = new FormData(formCreate);
      const name  = (fd.get('name')||'').toString().trim();
      const desc  = (fd.get('descriptionCID')||'').toString().trim();
      const image = (fd.get('imageCID')||'').toString().trim();
      const priceUsdCents   = toUsdCents(fd.get('priceUsd'));
      const shippingUsdCents= toUsdCents(fd.get('shippingUsd'));
      const taxRateBps      = bpsFromPercent(fd.get('taxRate'));
      const delivDays       = parseInt(fd.get('deliveryDays')||'0',10);
      const revenueWallet   = (fd.get('revenueWallet')||'').toString().trim();
      const taxWallet       = (fd.get('taxWallet')||'').toString().trim();
      const shippingWallet  = (fd.get('shippingWallet')||'').toString().trim() || ethers.constants.AddressZero;
      const pubkeyBytes     = parseHexOrBase64ToBytes((fd.get('pubkey')||'').toString());
      const stock           = parseInt(fd.get('stock')||'0',10);
      const active          = (fd.get('active')||'true')==='true';

      if (!name || !desc || !image) throw new Error('Thiếu tên/ảnh/mô tả (CID).');

      const tx = await muaban.createProduct(
        name, desc, image,
        priceUsdCents, shippingUsdCents,
        taxRateBps, delivDays,
        revenueWallet, taxWallet, shippingWallet,
        pubkeyBytes, stock, active,
        { gasPrice: ethers.utils.parseUnits('0.5','gwei') }
      );
      showToast('Đăng sản phẩm…');
      const rc = await tx.wait();
      const ev = rc.events?.find(e=> e.event==='ProductCreated');
      if (ev) {
        const pid = ev.args?.productId?.toString();
        showToast(`Đã đăng sản phẩm #${pid}`);
      } else {
        showToast('Đã đăng sản phẩm');
      }
      formCreate.reset();
      await indexAllProducts();
      renderBrowse();
      if (tabSell.classList.contains('active')) loadMyProducts();
    } catch (e) {
      console.error(e);
      showToast(e?.data?.message || e.message || 'Đăng sản phẩm lỗi');
    }
  };

  const loadMyProducts = async () => {
    try {
      requireProvider();
      myProducts.innerHTML = '';
      if (!account) {
        // tự lấy nếu trước đó user đã ủy quyền
        const accs = await window.ethereum.request({ method: 'eth_accounts' });
        if (accs && accs[0]) account = accs[0];
      }
      if (!account) {
        myProducts.innerHTML = `<div class="card muted">Hãy kết nối ví để xem sản phẩm của bạn.</div>`;
        return;
      }

      // Ưu tiên gọi getSellerProductIds (rẻ hơn log-scan)
      const ids = await muaban.getSellerProductIds(account);
      if (!ids.length) {
        myProducts.innerHTML = `<div class="card muted">Bạn chưa có sản phẩm.</div>`;
        return;
      }

      for (const idBN of ids) {
        const pid = idBN.toString();
        const p = await muaban.getProduct(pid);

        const node = tplMyProduct.content.cloneNode(true);
        $('.mp-name', node).textContent = p.name;
        $('.mp-id', node).textContent   = pid;
        $('.mp-updated', node).textContent = new Date(Number(p.updatedAt)*1000).toLocaleString('vi-VN', {hour12:false});
        $('.mp-active', node).textContent = p.active ? 'Đang bán' : 'Đang ẩn';

        $('.mp-price', node).textContent = fromUsdCents(p.priceUsdCents);
        $('.mp-ship',  node).textContent = fromUsdCents(p.shippingUsdCents);
        $('.mp-tax',   node).textContent = (Number(p.taxRateBps)/100).toFixed(2);
        $('.mp-deliv', node).textContent = p.deliveryDaysMax.toString();
        $('.mp-stock', node).textContent = p.stock.toString();

        $('.mp-revenue', node).textContent = shortAddr(p.revenueWallet);
        $('.mp-taxWallet', node).textContent= shortAddr(p.taxWallet);
        $('.mp-shipWallet', node).textContent= p.shippingWallet===ethers.constants.AddressZero ? '(trống)' : shortAddr(p.shippingWallet);

        // Actions
        $('.mp-toggle', node).addEventListener('click', async ()=>{
          try {
            requireSigner();
            const tx = await muaban.setProductActive(pid, !p.active, { gasPrice: ethers.utils.parseUnits('0.5','gwei') });
            showToast('Đang thay đổi trạng thái…');
            await tx.wait();
            showToast('Đã cập nhật');
            loadMyProducts();
            await indexAllProducts();
            renderBrowse();
          } catch (e) { showToast(e?.data?.message || e.message || 'Lỗi cập nhật'); }
        });

        $('.mp-edit', node).addEventListener('click', ()=>{
          // Prefill edit form
          $('[name="productId"]', formEdit).value = pid;
          $('[name="priceUsd"]', formEdit).value  = fromUsdCents(p.priceUsdCents);
          $('[name="shippingUsd"]', formEdit).value = fromUsdCents(p.shippingUsdCents);
          $('[name="taxRate"]', formEdit).value   = (Number(p.taxRateBps)/100).toFixed(2);
          $('[name="deliveryDays"]', formEdit).value = p.deliveryDaysMax.toString();
          $('[name="revenueWallet"]', formEdit).value  = p.revenueWallet;
          $('[name="taxWallet"]', formEdit).value      = p.taxWallet;
          $('[name="shippingWallet"]', formEdit).value = p.shippingWallet===ethers.constants.AddressZero?'':p.shippingWallet;
          $('[name="stock"]', formEdit).value          = p.stock.toString();
          $('[name="pubkey"]', formEdit).value         = ''; // để trống nếu không đổi
          dlgEdit.showModal();
        });

        myProducts.appendChild(node);
      }
    } catch (e) {
      console.error(e);
      myProducts.innerHTML = `<div class="card muted">Lỗi tải danh sách.</div>`;
    }
  };

  const doUpdateProduct = async () => {
    try {
      requireSigner();
      const fd = new FormData(formEdit);
      const pid = fd.get('productId').toString();
      const priceUsdCents    = toUsdCents(fd.get('priceUsd'));
      const shippingUsdCents = toUsdCents(fd.get('shippingUsd'));
      const taxRateBps       = bpsFromPercent(fd.get('taxRate'));
      const delivDays        = parseInt(fd.get('deliveryDays')||'0',10);
      const revenueWallet    = (fd.get('revenueWallet')||'').toString().trim();
      const taxWallet        = (fd.get('taxWallet')||'').toString().trim();
      const shippingWallet   = (fd.get('shippingWallet')||'').toString().trim() || ethers.constants.AddressZero;
      const stock            = parseInt(fd.get('stock')||'0',10);
      const pubkeyBytes      = parseHexOrBase64ToBytes((fd.get('pubkey')||'').toString());

      const tx = await muaban.updateProduct(
        pid,
        priceUsdCents, shippingUsdCents,
        taxRateBps, delivDays,
        revenueWallet, taxWallet, shippingWallet,
        stock, pubkeyBytes,
        { gasPrice: ethers.utils.parseUnits('0.5','gwei') }
      );
      showToast('Đang cập nhật…');
      await tx.wait();
      showToast('Đã cập nhật sản phẩm');
      dlgEdit.close();
      loadMyProducts();
      await indexAllProducts();
      renderBrowse();
    } catch (e) {
      console.error(e);
      showToast(e?.data?.message || e.message || 'Cập nhật lỗi');
    }
  };

  // -------------------- Misc --------------------
  // Đóng modal bằng phím ESC/ngoài vùng
  [dlgProduct, dlgEdit].forEach(dg=>{
    if (!dg) return;
    dg.addEventListener('click', (e)=>{
      const box = $('.modal-box', dg);
      if (e.target === dg && box && !box.contains(e.target)) dg.close();
    });
  });

  // -------------------- Start --------------------
  window.addEventListener('load', init);
})();

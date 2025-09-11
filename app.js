/* ==========================================================================
   muaban.vin — app.js (ethers v5)
   - Chọn số lượng & xem trước VIN bằng quoteVinForProduct
   - Mua hàng: approve vinTotal → placeOrder(productId, qty, vinPerUSD, shippingCiphertext)
   - Đơn của tôi (mua/bán): đọc logs OrderPlaced, hiển thị & thao tác confirm / refund
   ========================================================================== */
(function () {
  'use strict';

  /* -------------------- Tiện ích DOM -------------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const show = el => el.classList.remove('hidden');
  const hide = el => el.classList.add('hidden');
  const toast = (t) => {
    const el = $("#toast");
    el.textContent = t; show(el);
    setTimeout(()=>hide(el), 1600);
  };

  /* -------------------- Cấu hình mạng / địa chỉ -------------------- */
  const RPC_URL = "https://rpc.viction.xyz";
  const CHAIN_ID_HEX = "0x58"; // 88
  const MUABAN = "0xe01e2213A899E9B3b1921673D2d13a227a8df638"; // contract address

  /* -------------------- Ethers / Provider -------------------- */
  let provider, signer, user;
  let muaban, vin;
  async function bindRO(){
    if (!window.ethers){ throw new Error("ethers not loaded"); }
    provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const abi = await (await fetch("Muaban_ABI.json")).json();
    const vinAbi = await (await fetch("VinToken_ABI.json")).json();
    muaban = new ethers.Contract(MUABAN, abi, provider);
    const vinAddr = await muaban.VIN(); // lấy địa chỉ VIN từ hợp đồng nếu có
    vin = new ethers.Contract(vinAddr, vinAbi, provider);
  }
  async function bindRW(){
    if (!window.ethereum) throw new Error("No wallet");
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params:[{ chainId: CHAIN_ID_HEX }]});
    const web3 = new ethers.providers.Web3Provider(window.ethereum, 'any');
    await web3.send('eth_requestAccounts', []);
    provider = web3;
    signer = web3.getSigner();
    user = await signer.getAddress();
    muaban = muaban.connect(signer);
    vin = vin.connect(signer);
    await refreshBalances();
  }

  /* -------------------- VIN/USD (VICUSDT * 100) -------------------- */
  let vinPerUSD_BN = null; // VIN wei per 1 USD (từ VICUSDT * 100)
  async function refreshVinPrice(){
    // Lấy giá VIC/USDT từ Binance → 1 VIN = 100 VIC → VIN/USD = VIC/USDT * 100
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT");
    const j = await res.json();
    const vic = Number(j.price || 0);
    const vinPerUsd = vic * 100;
    $("#vinUsd").innerHTML = `<strong>${vinPerUsd.toFixed(2)}</strong> USD`;
    // quy ước: 1 VIN = 10^18 wei
    vinPerUSD_BN = ethers.utils.parseUnits(String(1 / vinPerUsd), 18).isZero()
      ? ethers.BigNumber.from("1") // tránh 0
      : ethers.utils.parseUnits(String(1 / vinPerUsd), 18);
  }

  async function refreshBalances(){
    if (!user) return;
    const vinBal = await vin.balanceOf(user);
    const vicBal = await provider.getBalance(user);
    $("#vinBalance").textContent = Number(ethers.utils.formatUnits(vinBal,18)).toFixed(4);
    $("#vicBalance").textContent = Number(ethers.utils.formatEther(vicBal)).toFixed(4);
    $("#accountShort").textContent = user.slice(0,6) + "…" + user.slice(-4);
    $("#accountShort").href = `https://vicscan.xyz/address/${user}`;
    hide($("#btnConnect"));
    show($("#walletInfo"));
  }

  async function connectWallet(){
    try{ await bindRW(); toast("Đã kết nối"); }
    catch(e){ console.error(e); toast("Kết nối ví thất bại"); }
  }
  function disconnectWallet(){
    user = null; signer = null;
    show($("#btnConnect")); hide($("#walletInfo"));
  }

  /* -------------------- Tải & hiển thị sản phẩm -------------------- */
  let allProducts = [];
  async function loadProducts(){
    const count = (await muaban.productSeq()).toNumber();
    const items = [];
    for (let id=1; id<=count; id++){
      const p = await muaban.getProduct(id);
      // p.active và p.stock nằm trong struct (xem hợp đồng)
      if ((p.active ?? p[13]) && Number(p.stock ?? p[16]) > 0){
        items.push({ id, p });
      }
    }
    allProducts = items;
    renderProducts();
  }
  function renderProducts(){
    const q = ($("#searchInput").value||"").trim().toLowerCase();
    const wrap = $("#productList"); wrap.innerHTML = "";
    const tpl = $("#tplProductCard").content;
    let shown = 0;
    for (const {id,p} of allProducts){
      const name = (p.name ?? p[1])+"";
      const unit = (p.unit ?? p[3])+"";
      if (q && !(`${name} ${unit}`.toLowerCase().includes(q))) continue;

      const card = document.importNode(tpl, true);
      const media = card.querySelector(".p-media");
      const title = card.querySelector(".p-title");
      const price = card.querySelector(".p-price-vin");
      const stockBadge = card.querySelector(".stock-badge");
      const btnBuy = card.querySelector(".buy-btn");
      const btnUpd = card.querySelector(".update-btn");

      // media (ảnh/video)
      const img = (p.imageCID ?? p[2])+"";
      if (/\.(mp4|webm)$/i.test(img)) {
        const v = document.createElement("video"); v.src = img; v.controls = true;
        media.appendChild(v);
      } else {
        const i = document.createElement("img"); i.src = img; i.alt = name;
        media.appendChild(i);
      }

      title.textContent = name;
      const priceUsd = ((p.priceUsdCents ?? p[5]) / 100).toFixed(2);
      price.textContent = `Giá: ${priceUsd} USD / ${unit}`;

      const stock = Number(p.stock ?? p[16]);
      const active = !!(p.active ?? p[13]);
      stockBadge.textContent = stock>0 ? `${stock} ${unit}` : "Hết hàng";
      stockBadge.className = "stock-badge badge " + (stock>0 ? "ok" : "out");

      if (active && stock>0){ btnBuy.classList.remove("hidden"); }
      btnBuy.dataset.productId = id;

      // chỉ hiện “Cập nhật” với chính chủ sản phẩm
      if (user && (String((p.seller ?? p[0])).toLowerCase() === user.toLowerCase())){
        btnUpd.classList.remove("hidden");
        btnUpd.dataset.productId = id;
      }

      wrap.appendChild(card);
      shown++;
    }
    $("#emptyProducts").style.display = shown ? "none" : "block";
  }

  /* -------------------- Tạo/Cập nhật sản phẩm (giữ nguyên logic cũ) -------------------- */
  // ... (phần của bạn không đổi – rút gọn ở đây cho gọn bài; nếu cần tôi gửi full lại)

  /* -------------------- Mua hàng: chọn số lượng, xem trước VIN, mã hoá địa chỉ -------------------- */
  let buying = { id:null, p:null };
  async function ensureNaCl(){
    if (window.nacl) return;
    await import("https://cdn.jsdelivr.net/npm/tweetnacl-util@0.15.1/nacl-util.js");
    await import("https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js");
  }
  async function encryptForSellerBase64(pubB64, plainJSON){
    await ensureNaCl();
    const pk = window.nacl.util.decodeBase64(pubB64);
    const eph = window.nacl.box.keyPair();
    const nonce = window.nacl.randomBytes(24);
    const msg = window.nacl.util.decodeUTF8(plainJSON);
    const ct = window.nacl.box(msg, nonce, pk, eph.secretKey);
    const payload = {
      version:"x25519-xsalsa20-poly1305",
      ephemPublicKey: window.nacl.util.encodeBase64(eph.publicKey),
      nonce:          window.nacl.util.encodeBase64(nonce),
      ciphertext:     window.nacl.util.encodeBase64(ct)
    };
    return ethers.utils.hexlify(ethers.utils.toUtf8Bytes(JSON.stringify(payload)));
  }

  async function startBuy(pid){
    if (!user){ toast("Kết nối ví để mua"); return; }
    const p = await muaban.getProduct(pid);
    if (!(p.active ?? p[13]) || String(p.stock ?? p[16])==="0") return toast("Sản phẩm tạm hết hàng");
    buying = { id:pid, p };
    $("#shipName").value=""; $("#shipPhone").value=""; $("#shipAddress").value=""; $("#shipNote").value="";
    $("#buyQty").value = "1";
    await previewVin(); // tính sẵn VIN theo mặc định qty=1
    show($("#buyModal"));
  }

  async function previewVin(){
    try{
      if (!vinPerUSD_BN) await refreshVinPrice();
      const qty = Math.max(1, parseInt($("#buyQty").value||"1",10));

      const q = await muaban.quoteVinForProduct(buying.id, qty, vinPerUSD_BN);
      const [vinRevenue, vinShipping, vinTax, vinTotal] = q;

      const fmt = (bn)=> Number(ethers.utils.formatUnits(bn,18)).toFixed(4) + " VIN";
      $("#buyVinPreview").textContent = fmt(vinTotal);
      $("#buyVinBreakdown").textContent =
        `Doanh thu: ${fmt(vinRevenue)} · Giao hàng: ${fmt(vinShipping)} · Thuế: ${fmt(vinTax)}`;
      // gắn lên nút để người dùng yên tâm
      $("#buySubmit").textContent = `Thanh toán ${fmt(vinTotal)}`;
      $("#buySubmit").dataset.vinTotal = vinTotal.toString();
    }catch(e){ console.warn(e); $("#buyVinPreview").textContent="—"; $("#buySubmit").textContent="Thanh toán VIN"; }
  }

  $("#buyQty")?.addEventListener("input", ()=>previewVin());

  async function submitBuy(){
    try{
      if (!user) return toast("Kết nối ví");
      await bindRW();
      if (!vinPerUSD_BN) await refreshVinPrice();

      const ship = {
        name: $("#shipName").value.trim(),
        phone: $("#shipPhone").value.trim(),
        address: $("#shipAddress").value.trim(),
        note: $("#shipNote").value.trim()
      };
      if (!ship.name || !ship.phone || !ship.address) return toast("Điền đủ Tên/SĐT/Địa chỉ");

      let shipHex;
      try{
        let sellerPubB64 = "";
        try{ sellerPubB64 = ethers.utils.toUtf8String(buying.p.sellerEncryptPubKey ?? buying.p[12]); }catch(_){}
        const plain = JSON.stringify(ship);
        shipHex = sellerPubB64
          ? await encryptForSellerBase64(sellerPubB64, plain)
          : ethers.utils.hexlify(ethers.utils.toUtf8Bytes(plain));
      }catch(e){
        console.warn("encrypt fail", e);
        shipHex = ethers.utils.hexlify(ethers.utils.toUtf8Bytes(JSON.stringify(ship)));
      }

      const qty = Math.max(1, parseInt($("#buyQty").value||"1",10));
      // Báo giá chính xác theo hợp đồng
      const q = await muaban.quoteVinForProduct(buying.id, qty, vinPerUSD_BN); // vinRevenue, vinShipping, vinTax, vinTotal
      const vinTotal = q[3];

      // Approve đúng vinTotal
      const allow = await vin.allowance(user, MUABAN);
      if (allow.lt(vinTotal)){
        const t1 = await vin.approve(MUABAN, vinTotal);
        toast("Approve VIN…"); await t1.wait();
      }

      // placeOrder(productId, quantity, vinPerUSD, shippingCiphertext)
      const t2 = await muaban.placeOrder(buying.id, qty, vinPerUSD_BN, shipHex);
      toast("Đặt hàng…"); await t2.wait();

      toast("Đặt hàng thành công");
      hide($("#buyModal"));
      await loadBuyerOrders(); // cập nhật tab đơn mua
    }catch(e){ console.error(e); toast("Đặt hàng thất bại"); }
  }

  /* -------------------- Đơn của tôi (Buyer/Seller) -------------------- */
  function statusText(s){ const n=Number(s); if(n===1) return "Đang ký quỹ"; if(n===2) return "Đã xả tiền"; if(n===3) return "Đã hoàn"; return "—"; }

  async function loadBuyerOrders(){
    if (!provider) await bindRO();
    if (!user) { $("#buyerOrders").innerHTML=""; $("#emptyBuyerOrders").style.display="block"; return; }

    const iface = muaban.interface;
    const topic = iface.getEventTopic("OrderPlaced");
    const filter = {
      address: MUABAN,
      topics: [topic, null, ethers.utils.hexZeroPad(user,32)] // indexed: orderId, productId, buyer
    };
    const logs = await provider.getLogs({ ...filter, fromBlock: 1, toBlock: "latest" });

    const wrap = $("#buyerOrders"); wrap.innerHTML = "";
    const tpl = $("#tplBuyerOrder").content;
    for (const lg of logs.reverse()){ // mới nhất trước
      const ev = iface.parseLog(lg);
      const { orderId, productId, quantity, vinTotal, deadline } = {
        orderId: ev.args[0].toNumber(),
        productId: ev.args[1].toNumber(),
        quantity: ev.args[4].toNumber(),
        vinTotal: ev.args[5],
        deadline: ev.args[7].toNumber()
      };

      const p = await muaban.getProduct(productId);
      const card = document.importNode(tpl, true);
      card.querySelector(".p-title").textContent = (p.name ?? p[1]) + ` × ${quantity}`;
      card.querySelector(".p-price-vin").textContent =
        `${Number(ethers.utils.formatUnits(vinTotal,18)).toFixed(4)} VIN · Hạn: ${new Date(deadline*1000).toLocaleString()}`;
      card.querySelector(".muted.mono").textContent =
        `orderId=${orderId} · productId=${productId} · trạng thái: ${statusText((await muaban.getOrder(orderId)).status)}`;

      // nút hành động
      const btnConfirm = card.querySelector(".confirm-btn");
      const btnRefund  = card.querySelector(".refund-btn");
      btnConfirm.onclick = async ()=>{
        try{ await bindRW(); const tx=await muaban.confirmReceipt(orderId); toast("Xác nhận…"); await tx.wait(); toast("Đã xả tiền"); }
        catch(e){ console.error(e); toast("Thao tác thất bại"); }
      };
      btnRefund.onclick = async ()=>{
        try{ await bindRW(); const tx=await muaban.refundIfExpired(orderId); toast("Yêu cầu hoàn…"); await tx.wait(); toast("Đã hoàn (nếu quá hạn)"); }
        catch(e){ console.error(e); toast("Thao tác thất bại"); }
      };

      wrap.appendChild(card);
    }
    $("#emptyBuyerOrders").style.display = wrap.children.length ? "none" : "block";
  }

  async function loadSellerOrders(){
    if (!provider) await bindRO();
    if (!user) { $("#sellerOrders").innerHTML=""; $("#emptySellerOrders").style.display="block"; return; }

    // Lấy danh sách productId của người bán
    const sellerStat = await muaban.sellerStats(user); // để kiểm tra có dữ liệu
    // lấy productSeq rồi quét sellerProducts(user, idx) đến khi 0
    const productIds = [];
    for (let i=0;i<1000;i++){
      try{
        const id = await muaban.sellerProducts(user, i);
        if (id.eq(0)) break;
        productIds.push(id.toNumber());
      }catch(_){ break; }
    }

    const iface = muaban.interface;
    const topic = iface.getEventTopic("OrderPlaced");

    const wrap = $("#sellerOrders"); wrap.innerHTML = "";
    const tpl = $("#tplSellerOrder").content;

    for (const pid of productIds){
      const filter = {
        address: MUABAN,
        topics: [topic, null, ethers.utils.hexZeroPad(ethers.BigNumber.from(pid).toHexString(),32)] // indexed: orderId, productId, buyer
      };
      const logs = await provider.getLogs({ ...filter, fromBlock: 1, toBlock:"latest" });

      for (const lg of logs.reverse()){
        const ev = iface.parseLog(lg);
        const orderId = ev.args[0].toNumber();
        const productId = ev.args[1].toNumber();
        const quantity = ev.args[4].toNumber();
        const vinTotal = ev.args[5];

        const p = await muaban.getProduct(productId);

        const card = document.importNode(tpl, true);
        card.querySelector(".p-title").textContent = (p.name ?? p[1]) + ` × ${quantity}`;
        card.querySelector(".p-price-vin").textContent =
          `${Number(ethers.utils.formatUnits(vinTotal,18)).toFixed(4)} VIN`;
        card.querySelector(".muted.mono").textContent = `orderId=${orderId} · productId=${productId}`;
        card.querySelector(".tx-link").href = `https://vicscan.xyz/tx/${lg.transactionHash}`;

        // Giải mã địa chỉ (nếu người bán có private decryption – ở đây nếu plaintext thì hiển thị luôn)
        const pre = card.querySelector(".shipping-plain");
        try{
          const o = await muaban.getOrder(orderId);
          // nếu shippingInfoCiphertext là UTF8 plain (dev/test) → hiển thị
          try{
            const txt = ethers.utils.toUtf8String(o.shippingInfoCiphertext);
            if (txt){ pre.textContent = txt; show(pre); }
          }catch(_){}
        }catch(_){}

        card.querySelector(".decrypt-btn").onclick = ()=>{ pre.classList.toggle("hidden"); };
        wrap.appendChild(card);
      }
    }
    $("#emptySellerOrders").style.display = wrap.children.length ? "none" : "block";
  }

  /* -------------------- Đăng ký, tạo & cập nhật sản phẩm (nút) -------------------- */
  async function payRegistration(){
    try{ await bindRW(); const fee = await muaban.registrationFeeVIN(); const tx = await muaban.registerSeller(fee); toast("Đăng ký…"); await tx.wait(); toast("Đã đăng ký"); }
    catch(e){ console.error(e); toast("Đăng ký thất bại"); }
  }
  async function openCreateModal(){ show($("#createModal")); }
  async function openUpdateModal(id){
    // (phần lấy sản phẩm & điền form như file hiện tại của bạn)
    show($("#updateModal"));
  }
  async function submitCreate(){ /* giữ nguyên theo bản trước */ }
  async function submitUpdate(){ /* giữ nguyên theo bản trước */ }

  /* -------------------- Gắn sự kiện UI -------------------- */
  function bindUI(){
    $("#btnConnect").onclick = connectWallet;
    $("#btnDisconnect").onclick = disconnectWallet;

    $("#btnRegister").onclick = payRegistration;
    $("#btnCreateProduct").onclick = openCreateModal;

    $("#createClose").onclick=()=>hide($("#createModal"));
    $("#createCancel").onclick=()=>hide($("#createModal"));
    $("#createSubmit").onclick=submitCreate;

    $("#updateClose").onclick=()=>hide($("#updateModal"));
    $("#updateCancel").onclick=()=>hide($("#updateModal"));
    $("#updateSubmit").onclick=submitUpdate;

    $("#buyClose").onclick=()=>hide($("#buyModal"));
    $("#buyCancel").onclick=()=>hide($("#buyModal"));
    $("#buySubmit").onclick=submitBuy;

    $("#btnReload").onclick = ()=>renderProducts();
    $("#searchInput").oninput = ()=>renderProducts();

    $("#productList").addEventListener("click", async (ev)=>{
      const buy = ev.target.closest(".buy-btn");
      const upd = ev.target.closest(".update-btn");
      if (buy){ const id=parseInt(buy.dataset.productId,10); if(!user){toast("Kết nối ví để mua");return;} await startBuy(id); }
      if (upd){ const id=parseInt(upd.dataset.productId,10); await openUpdateModal(id); }
    });

    $("#btnViewProducts").onclick = ()=>{ showTab("products"); };
    $("#btnBuyerOrders").onclick  = async ()=>{ showTab("buyer"); await loadBuyerOrders(); };
    $("#btnSellerOrders").onclick = async ()=>{ showTab("seller"); await loadSellerOrders(); };
  }
  function showTab(which){
    const tabs = {
      products: {sec:"#tabProducts", btn:"#btnViewProducts"},
      buyer:    {sec:"#tabBuyer",    btn:"#btnBuyerOrders"},
      seller:   {sec:"#tabSeller",   btn:"#btnSellerOrders"},
    };
    for (const k in tabs){
      const s=$(tabs[k].sec), b=$(tabs[k].btn);
      if (k===which){ show(s); b.classList.add("outline","active"); }
      else { hide(s); b.classList.remove("active"); }
    }
  }

  /* -------------------- Bootstrap -------------------- */
  window.addEventListener("DOMContentLoaded", async ()=>{
    bindUI();
    showTab("products");
    hide($("#createModal")); hide($("#updateModal")); hide($("#buyModal"));

    // Chờ ethers sẵn sàng (tránh 'ethers is not defined' trên GitHub Pages)
    const waitEthers = async ()=>{
      const t0 = Date.now();
      while (!window.ethers){
        if (Date.now()-t0 > 5000) { alert("Không tải được thư viện Ethers. Kiểm tra mạng/CDN."); return false; }
        await new Promise(r=>setTimeout(r,50));
      }
      return true;
    };
    const ok = await waitEthers(); if(!ok) return;

    await bindRO();
    await refreshVinPrice();
    await loadProducts();

    if (window.ethereum){
      window.ethereum.on("accountsChanged", ()=>{ disconnectWallet(); });
      window.ethereum.on("chainChanged", ()=>{ location.reload(); });
    }
  });

})();

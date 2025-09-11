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
    // ✅ Getter đúng là vin()
    const vinAddr = await muaban.vin();
    vin = new ethers.Contract(vinAddr, vinAbi, provider);
  }
  async function bindRW(){
    if (!window.ethereum) throw new Error("No wallet");

    const CHAIN_ID_HEX = "0x58"; // Viction mainnet (88)
    const RPC_URL = "https://rpc.viction.xyz";

    // ✅ Đảm bảo chain đã có trong ví
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: CHAIN_ID_HEX }],
      });
    } catch (e) {
      if (e.code === 4902 || (e.data && e.data.originalError && e.data.originalError.code === 4902)) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: CHAIN_ID_HEX,
            chainName: 'Viction Mainnet',
            nativeCurrency: { name: 'Viction', symbol: 'VIC', decimals: 18 },
            rpcUrls: [RPC_URL],
            blockExplorerUrls: ['https://vicscan.xyz'],
          }],
        });
      } else {
        throw e;
      }
    }

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
  let vinPerUSD_BN = null; // VIN wei per 1 USD

  async function refreshVinPrice(){
    // Lấy giá VIC/USDT → 1 VIN = 100 VIC → USD per VIN = VICUSDT * 100
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT");
    const j = await res.json();
    const vic = Number(j.price || 0);
    const usdPerVin = vic * 100;

    // ✅ đúng ID trong index.html là #vinPriceUsd
    const el = document.getElementById("vinPriceUsd");
    if (el) el.textContent = usdPerVin.toFixed(2);

    // Hợp đồng cần VIN per USD (BN-18): 1 / usdPerVin
    const inv = 1 / (usdPerVin || 1); // tránh chia 0
    const s = String(inv);
    vinPerUSD_BN = ethers.utils.parseUnits(s, 18);
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
})();

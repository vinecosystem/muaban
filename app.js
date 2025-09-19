/* ========== muaban.vin — app.js (rev: anti-freeze + robust wallet connect) ========== */

/* -------------------- 0) CẤU HÌNH -------------------- */
const CONFIG = {
  CHAIN_ID: 88, // Viction mainnet
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://www.vicscan.xyz",
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",

  BINANCE_VICUSDT: "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",
  COINGECKO_USDTVND: "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",

  LOGS_LOOKBACK_BLOCKS: 500_000n,
  TX_WAIT_TIMEOUT_MS: 90_000, // 90s chống kẹt khi chờ xác nhận
};

/* -------------------- 1) TIỆN ÍCH -------------------- */
const $ = (s,r=document)=>r.querySelector(s);
const $$ = (s,r=document)=>Array.from(r.querySelectorAll(s));
const bn = (n)=>ethers.BigNumber.from(String(n));
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const shortAddr=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`:"0x…";
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const toBase64=(str)=>btoa(unescape(encodeURIComponent(str)));
const fmtVND=(n)=>new Intl.NumberFormat('vi-VN').format(Number(n||0))+" VND";
const fmtVINWeiToVIN=(wei)=>Number(ethers.utils.formatUnits(wei,18));

let toastTimer=null;
function toast(msg){
  console.log("[toast]", msg);
  $("#_toast")?.remove();
  const el=document.createElement("div");
  el.id="_toast";
  el.style.cssText="position:fixed;left:50%;top:12px;transform:translateX(-50%);background:#111827;color:#fff;padding:10px 14px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.25);z-index:9999;font-size:13px";
  el.textContent=msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.remove(),2600);
}

/* Overlay chống “quay trắng” */
function ensureOverlay(){
  if ($("#_overlay")) return $("#_overlay");
  const o=document.createElement("div");
  o.id="_overlay";
  o.style.cssText="position:fixed;inset:0;background:rgba(255,255,255,.78);backdrop-filter:saturate(1.2) blur(1px);display:none;z-index:9998";
  o.innerHTML=`<div id="_spinner" style="position:absolute;left:50%;top:40%;transform:translate(-50%,-50%);font:500 14px/1 Inter,system-ui,sans-serif;color:#111827;text-align:center">
    <div class="_ring" style="width:54px;height:54px;margin:0 auto 10px;border:4px solid #d1d5db;border-top-color:#111827;border-radius:50%;animation:spin 1s linear infinite"></div>
    <div id="_overlayMsg">Processing…</div>
  </div>
  <style>@keyframes spin{to{transform:rotate(360deg)}}</style>`;
  document.body.appendChild(o);
  return o;
}
function showOverlay(msg="Processing…"){
  const o=ensureOverlay();
  $("#_overlayMsg",o).textContent=msg;
  o.style.display="block";
}
function hideOverlay(){
  $("#_overlay")?.style && ($("#_overlay").style.display="none");
}

/* Bọc 1 action có overlay + đảm bảo always-off + chống kẹt tx.wait() */
async function withLoading(label, fn){
  showOverlay(label);
  try{
    return await fn();
  }finally{
    hideOverlay();
  }
}

/* Chờ tx với timeout chống kẹt */
async function waitTx(txPromise, label="Đang chờ xác nhận…"){
  const tx = await txPromise;
  const rcPromise = tx.wait();
  const timeout = new Promise((_,rej)=>setTimeout(()=>rej(new Error("TIMEOUT_WAIT_TX")), CONFIG.TX_WAIT_TIMEOUT_MS));
  showOverlay(label);
  try{
    const rc = await Promise.race([rcPromise, timeout]);
    return rc;
  }finally{
    hideOverlay();
  }
}

/* -------------------- 2) TRẠNG THÁI -------------------- */
let providerRead, providerWrite, signer, account;
let muaban, vin;
let MUABAN_ABI, VIN_ABI;

let isRegistered=false;
let rate = {
  vic_usdt:null,
  usdt_vnd:null,
  vin_vnd:null,
  vinPerVND_wei:null
};

/* -------------------- 3) NẠP ABI -------------------- */
async function loadABIs(){
  const [m,v]=await Promise.all([
    fetch("Muaban_ABI.json").then(r=>r.json()),
    fetch("VinToken_ABI.json").then(r=>r.json())
  ]);
  MUABAN_ABI=m; VIN_ABI=v;
}

/* -------------------- 4) PROVIDERS -------------------- */
async function setupProviders(){
  providerRead = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL, {name:"viction", chainId:CONFIG.CHAIN_ID});
  if (window.ethereum){
    providerWrite = new ethers.providers.Web3Provider(window.ethereum, "any");
  }else{
    providerWrite = null;
  }
}
function bindContracts(read=true){
  const prov = read ? providerRead : providerWrite;
  muaban = new ethers.Contract(CONFIG.MUABAN_ADDR, MUABAN_ABI, prov);
  vin    = new ethers.Contract(CONFIG.VIN_ADDR, VIN_ABI, prov);
}

async function ensureChain(){
  if (!providerWrite) return;
  const net = await providerWrite.getNetwork();
  if (Number(net.chainId)!==CONFIG.CHAIN_ID){
    try{
      await window.ethereum.request({
        method:"wallet_switchEthereumChain",
        params:[{chainId:"0x"+CONFIG.CHAIN_ID.toString(16)}]
      });
    }catch(err){
      if (err?.code===4902){
        await window.ethereum.request({
          method:"wallet_addEthereumChain",
          params:[{
            chainId:"0x"+CONFIG.CHAIN_ID.toString(16),
            chainName:"Viction Mainnet",
            rpcUrls:[CONFIG.RPC_URL],
            nativeCurrency:{name:"VIC",symbol:"VIC",decimals:18},
            blockExplorerUrls:[CONFIG.EXPLORER]
          }]
        });
      }else{ throw err; }
    }
  }
}

/* -------------------- 5) GIÁ VIN (VND) -------------------- */
async function fetchRates(){
  try{
    const [r1,r2]=await Promise.all([
      fetch(CONFIG.BINANCE_VICUSDT,{cache:"no-store"}).then(r=>r.json()),
      fetch(CONFIG.COINGECKO_USDTVND,{cache:"no-store"}).then(r=>r.json())
    ]);
    const vic_usdt = Number(r1?.price||0);
    const usdt_vnd = Number(r2?.tether?.vnd||0);
    if (vic_usdt>0 && usdt_vnd>0){
      rate.vic_usdt=vic_usdt; rate.usdt_vnd=usdt_vnd;
      rate.vin_vnd = Math.floor(vic_usdt * 100 * usdt_vnd);
      rate.vinPerVND_wei = bn(Math.floor(1e18/Math.max(1,rate.vin_vnd)));
      $("#vinPrice").textContent = `1 VIN = ${new Intl.NumberFormat('vi-VN').format(rate.vin_vnd)} VND`;
    }else{
      $("#vinPrice").textContent = "Loading price...";
    }
  }catch(e){
    console.warn("fetchRates",e);
    $("#vinPrice").textContent = "Loading price...";
  }
}

/* -------------------- 6) VÍ -------------------- */
async function refreshBalances(){
  if (!account) return;
  try{
    const [vinBal, vicBal] = await Promise.all([
      vin.balanceOf(account),
      providerWrite.getBalance(account)
    ]);
    $("#vinBalance").textContent=`VIN: ${ethers.utils.formatUnits(vinBal,18).slice(0,8)}`;
    $("#vicBalance").textContent=`VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;
    $("#accountShort").textContent=shortAddr(account);
    $("#accountShort").href=`${CONFIG.EXPLORER}/address/${account}`;
  }catch(e){ console.warn("refreshBalances",e); }
}

async function connectWallet(){
  if (!window.ethereum){ toast("Hãy cài MetaMask để kết nối."); return; }

  await withLoading("Kết nối ví…", async()=>{
    await ensureChain();
    // Lưu ý: nếu ví đang khóa, MetaMask sẽ hỏi mật khẩu; nếu đang mở khóa, sẽ không hỏi — hành vi chuẩn.
    const accounts = await window.ethereum.request({ method:"eth_requestAccounts" });
    if (!accounts || !accounts.length) throw new Error("NO_ACCOUNT");
    signer = providerWrite.getSigner();
    account = await signer.getAddress();

    $("#btnConnect").classList.add("hidden");
    $("#walletBox").classList.remove("hidden");
    $("#menuBox").classList.remove("hidden");
    $("#accountShort").textContent=shortAddr(account);
    $("#accountShort").href=`${CONFIG.EXPLORER}/address/${account}`;

    bindContracts(false);
    await refreshBalances();
    await checkRegistrationAndToggleMenu();
  });
}
function disconnectWallet(){
  signer=null; account=null;
  $("#walletBox").classList.add("hidden");
  $("#btnConnect").classList.remove("hidden");
  $("#menuBox").classList.add("hidden");
}

/* -------------------- 7) ĐĂNG KÝ (approve → payRegistration) -------------------- */
async function checkRegistrationAndToggleMenu(){
  if (!account) return;
  try{
    isRegistered = await muaban.registered(account);
  }catch(e){
    bindContracts(true);
    isRegistered = await muaban.registered(account);
    bindContracts(false);
  }
  $("#btnRegister").classList.toggle("hidden", !!isRegistered);
  $("#btnCreate").classList.toggle("hidden", !isRegistered);
  $("#btnOrdersBuy").classList.toggle("hidden", !isRegistered);
  $("#btnOrdersSell").classList.toggle("hidden", !isRegistered);
}

async function onRegister(){
  if (!signer){ toast("Vui lòng kết nối ví trước."); return; }
  await withLoading("Đăng ký ví…", async()=>{
    const REG_FEE = await muaban.REG_FEE();
    const vinW = vin.connect(signer);
    const allowance = await vinW.allowance(account, CONFIG.MUABAN_ADDR);
    if (allowance.lt(REG_FEE)){
      await waitTx(vinW.approve(CONFIG.MUABAN_ADDR, REG_FEE), "Đang approve phí đăng ký…");
    }
    await waitTx(muaban.connect(signer).payRegistration(), "Đang gửi đăng ký…");
    toast("Đăng ký thành công.");
    await checkRegistrationAndToggleMenu();
    await refreshBalances();
  });
}

/* -------------------- 8) SẢN PHẨM -------------------- */
function openCreateModal(){ $("#formCreate").classList.remove("hidden"); document.body.classList.add("no-scroll"); }
function closeCreateModal(){ $("#formCreate").classList.add("hidden"); document.body.classList.remove("no-scroll"); }

async function onSubmitCreate(){
  if (!signer || !isRegistered){ toast("Hãy kết nối & đăng ký ví trước."); return; }
  const name = ($("#createName").value||"").trim();
  const ipfs = ($("#createIPFS").value||"").trim();
  const unit = ($("#createUnit").value||"").trim();
  const priceVND = bn(String(Math.max(1, Number($("#createPrice").value||0))));
  const wallet = ($("#createWallet").value||"").trim();
  const days = Number($("#createDays").value||0);
  if (!name || !ipfs || !unit || priceVND.lte(0) || !wallet || !days){ toast("Vui lòng nhập đủ thông tin."); return; }

  const descriptionCID = `unit:${unit}`;
  const imageCID = ipfs;

  await withLoading("Đăng sản phẩm…", async()=>{
    const txp = muaban.connect(signer).createProduct(name, descriptionCID, imageCID, priceVND, days, wallet, true);
    await waitTx(txp, "Đang chờ xác nhận giao dịch…");
    toast("Đăng sản phẩm thành công.");
  });

  closeCreateModal();
  await loadProducts($("#searchInput").value||"");
}

/* Update */
function openUpdateModal(it){
  $("#formUpdate").classList.remove("hidden"); document.body.classList.add("no-scroll");
  $("#updatePid").value=String(it.pid);
  $("#updatePrice").value=String(it.priceVND);
  $("#updateDays").value=String(it.deliveryDaysMax);
  $("#updateWallet").value=it.payoutWallet;
  $("#updateActive").checked=!!it.active;
}
function closeUpdateModal(){ $("#formUpdate").classList.add("hidden"); document.body.classList.remove("no-scroll"); }

async function onSubmitUpdate(){
  const pid = Number($("#updatePid").value||0);
  const priceVND = bn(String(Math.max(1, Number($("#updatePrice").value||0))));
  const days = Number($("#updateDays").value||0);
  const wallet = ($("#updateWallet").value||"").trim();
  const active = !!$("#updateActive").checked;
  if (!pid || priceVND.lte(0) || !days || !wallet){ toast("Thiếu dữ liệu."); return; }

  await withLoading("Cập nhật sản phẩm…", async()=>{
    await waitTx(muaban.connect(signer).updateProduct(pid, priceVND, days, wallet, active), "Đang chờ xác nhận…");
    toast("Cập nhật thành công.");
  });

  closeUpdateModal();
  await loadProducts($("#searchInput").value||"");
}

/* -------------------- 9) TẢI & HIỂN THỊ SẢN PHẨM -------------------- */
async function loadProducts(keyword=""){
  try{
    bindContracts(true);
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topicCreated = iface.getEventTopic("ProductCreated");
    const latest = await providerRead.getBlockNumber();
    let fromBlock = 0n;
    if (CONFIG.LOGS_LOOKBACK_BLOCKS){
      const lb = BigInt(latest)-CONFIG.LOGS_LOOKBACK_BLOCKS;
      fromBlock = lb>0n?lb:0n;
    }
    const logs = await providerRead.getLogs({
      address:CONFIG.MUABAN_ADDR,
      fromBlock:"0x"+fromBlock.toString(16),
      toBlock:"latest",
      topics:[topicCreated]
    });

    const pidSet = new Set();
    for (const lg of logs){
      try{ pidSet.add((new ethers.utils.Interface(MUABAN_ABI)).parseLog(lg).args.productId.toString()); }catch{}
    }

    const list=[];
    for (const pid of pidSet){
      const p = await muaban.getProduct(pid);
      if (keyword && !String(p.name||"").toLowerCase().includes(keyword.toLowerCase())) continue;
      let unit="";
      if (p.descriptionCID && p.descriptionCID.startsWith("unit:")) unit=p.descriptionCID.slice(5);
      list.push({
        pid:Number(p.productId), name:p.name, image:p.imageCID,
        priceVND:p.priceVND.toString(), deliveryDaysMax:Number(p.deliveryDaysMax),
        seller:p.seller, payoutWallet:p.payoutWallet, active:p.active, unit
      });
    }
    list.sort((a,b)=>b.pid-a.pid);
    renderProducts(list);
  }catch(e){
    console.error("loadProducts",e); toast("Không tải được danh sách sản phẩm.");
  }finally{ bindContracts(false); }
}
function renderProducts(list){
  const box=$("#productList");
  box.innerHTML="";
  if (!list.length){
    const d=document.createElement("div"); d.style.padding="12px"; d.style.color="#64748b"; d.textContent="Chưa có sản phẩm."; box.appendChild(d); return;
  }
  for (const it of list){
    const card=document.createElement("div"); card.className="product-card";
    const img=document.createElement("img"); img.className="product-thumb"; img.src=it.image||""; img.alt=it.name||"";
    const info=document.createElement("div"); info.className="product-info";
    const top=document.createElement("div"); top.className="product-top";
    const title=document.createElement("h3"); title.className="product-title"; title.textContent=it.name||"(không tên)";
    const stock=document.createElement("span"); stock.className="stock-badge "+(it.active?"":"out"); stock.textContent=it.active?"Còn hàng":"Hết hàng";
    top.appendChild(title); top.appendChild(stock);
    const meta=document.createElement("div"); meta.className="product-meta";
    const unitTxt=it.unit?` / ${it.unit}`:"";
    meta.innerHTML=`<span class="price-vnd">${fmtVND(it.priceVND)}</span>${unitTxt}`;
    const actions=document.createElement("div"); actions.className="card-actions";
    const aSeller=document.createElement("a"); aSeller.href=`${CONFIG.EXPLORER}/address/${it.seller}`; aSeller.target="_blank"; aSeller.rel="noopener"; aSeller.className="tag"; aSeller.textContent=shortAddr(it.seller);
    actions.appendChild(aSeller);
    if (account && isRegistered){
      if (account.toLowerCase()===it.seller.toLowerCase()){
        const btnU=document.createElement("button"); btnU.className="btn"; btnU.textContent="Cập nhật sản phẩm"; btnU.onclick=()=>openUpdateModal(it);
        actions.appendChild(btnU);
      }else if (it.active){
        const btnB=document.createElement("button"); btnB.className="btn primary"; btnB.textContent="Mua"; btnB.onclick=()=>openBuyModal(it);
        actions.appendChild(btnB);
      }
    }
    info.appendChild(top); info.appendChild(meta); info.appendChild(actions);
    card.appendChild(img); card.appendChild(info); box.appendChild(card);
  }
}

/* -------------------- 10) MUA HÀNG -------------------- */
let currentBuyItem=null;
function openBuyModal(item){
  currentBuyItem=item;
  $("#formBuy").classList.remove("hidden"); document.body.classList.add("no-scroll");
  $("#buyProductInfo").innerHTML=`<div class="order-row"><span class="order-strong">${item.name}</span><span>${fmtVND(item.priceVND)}${item.unit?(" / "+item.unit):""}</span><span>Giao trong ${item.deliveryDaysMax} ngày</span></div>`;
  $("#buyName").value=""; $("#buyAddress").value=""; $("#buyPhone").value=""; $("#buyNote").value=""; $("#buyQty").value="1";
  updateBuyTotalVIN();
}
function closeBuyModal(){ $("#formBuy").classList.add("hidden"); document.body.classList.remove("no-scroll"); currentBuyItem=null; }

function updateBuyTotalVIN(){
  const qty = clamp(Number($("#buyQty").value||1), 1, 1_000_000);
  $("#buyQty").value=String(qty);
  if (!currentBuyItem || !rate.vinPerVND_wei){ $("#buyTotalVIN").textContent="Tổng VIN cần trả: 0"; return; }
  const totalWei = bn(currentBuyItem.priceVND).mul(qty).mul(rate.vinPerVND_wei);
  $("#buyTotalVIN").textContent=`Tổng VIN cần trả: ${fmtVINWeiToVIN(totalWei).toFixed(6)}`;
}

async function onSubmitBuy(){
  if (!signer || !isRegistered){ toast("Vui lòng kết nối & đăng ký ví trước."); return; }
  if (!currentBuyItem){ toast("Thiếu dữ liệu sản phẩm."); return; }
  if (!rate.vinPerVND_wei){ toast("Chưa có tỉ giá. Vui lòng đợi giá tải xong."); return; }

  const name = ($("#buyName").value||"").trim();
  const addr = ($("#buyAddress").value||"").trim();
  const phone= ($("#buyPhone").value||"").trim();
  const note = ($("#buyNote").value||"").trim();
  const qty  = clamp(Number($("#buyQty").value||1),1,1_000_000);
  if (!name || !addr || !phone){ toast("Vui lòng điền họ tên, địa chỉ, SĐT."); return; }
  const cipher = toBase64(JSON.stringify({name,addr,phone,note}));
  const expectWei = bn(currentBuyItem.priceVND).mul(qty).mul(rate.vinPerVND_wei);

  await withLoading("Đặt hàng…", async()=>{
    const vinW=vin.connect(signer);
    const allowance=await vinW.allowance(account, CONFIG.MUABAN_ADDR);
    if (allowance.lt(expectWei)){
      await waitTx(vinW.approve(CONFIG.MUABAN_ADDR, expectWei), "Đang approve VIN…");
    }
    await waitTx(muaban.connect(signer).placeOrder(currentBuyItem.pid, qty, rate.vinPerVND_wei, cipher), "Đang gửi đơn hàng…");
    toast("Đặt hàng thành công.");
  });

  closeBuyModal();
  await refreshBalances();
  await loadMyOrders();
}

/* -------------------- 11) ĐƠN HÀNG CỦA TÔI -------------------- */
async function loadMyOrders(){
  if (!account) return;
  bindContracts(true);
  const iface=new ethers.utils.Interface(MUABAN_ABI);
  const topicOrder=iface.getEventTopic("OrderPlaced");
  const latest=await providerRead.getBlockNumber();
  let fromBlock=0n;
  if (CONFIG.LOGS_LOOKBACK_BLOCKS){
    const lb=BigInt(latest)-CONFIG.LOGS_LOOKBACK_BLOCKS; fromBlock=lb>0n?lb:0n;
  }
  const logs=await providerRead.getLogs({address:CONFIG.MUABAN_ADDR,fromBlock:"0x"+fromBlock.toString(16),toBlock:"latest",topics:[topicOrder]});
  const buys=[], sells=[];
  for (const lg of logs){
    try{
      const ev=iface.parseLog(lg);
      const oid=ev.args.orderId.toString();
      const od=await muaban.getOrder(oid);
      const buyer=od.buyer?.toLowerCase?.()||"", seller=od.seller?.toLowerCase?.()||"", me=account.toLowerCase();
      const row={ oid:Number(od.orderId), pid:Number(od.productId), buyer:od.buyer, seller:od.seller, quantity:Number(od.quantity), vinAmount:od.vinAmount.toString(), placedAt:Number(od.placedAt), deadline:Number(od.deadline), status:Number(od.status) };
      if (buyer===me) buys.push(row);
      if (seller===me) sells.push(row);
    }catch{}
  }
  renderOrders("#ordersBuySection","#ordersBuyList",buys,"buy");
  renderOrders("#ordersSellSection","#ordersSellList",sells,"sell");
  bindContracts(false);
}
function renderOrders(sectionSel,listSel,arr,mode){
  const list=$(listSel); list.innerHTML="";
  if (!arr.length){ const p=document.createElement("p"); p.style.color="#64748b"; p.textContent="Chưa có đơn."; list.appendChild(p); return; }
  for (const it of arr.sort((a,b)=>b.oid-a.oid)){
    const card=document.createElement("div"); card.className="order-card";
    const vin=fmtVINWeiToVIN(it.vinAmount);
    const placed=new Date(it.placedAt*1000).toLocaleString("vi-VN");
    const deadline=new Date(it.deadline*1000).toLocaleDateString("vi-VN");
    const stMap=["NONE","PLACED","RELEASED","REFUNDED"]; const st=stMap[it.status]||String(it.status);
    const row1=document.createElement("div"); row1.className="order-row";
    row1.innerHTML=`<span class="order-strong">#${it.oid}</span><span>PID: ${it.pid}</span><span>Số lượng: ${it.quantity}</span><span>VIN: ${vin.toFixed(6)}</span>`;
    const row2=document.createElement("div"); row2.className="order-row";
    row2.innerHTML=`<span>Ngày đặt: ${placed}</span><span>Hạn giao: ${deadline}</span><span>Trạng thái: ${st}</span>`;
    const act=document.createElement("div"); act.className="card-actions";
    if (mode==="buy" && it.status===1){
      const b1=document.createElement("button"); b1.className="btn primary"; b1.textContent="Xác nhận đã nhận hàng"; b1.onclick=()=>confirmReceipt(it.oid);
      const b2=document.createElement("button"); b2.className="btn"; b2.textContent="Hoàn tiền (quá hạn)"; b2.onclick=()=>refundIfExpired(it.oid);
      act.appendChild(b1); act.appendChild(b2);
    }
    if (mode==="sell"){
      const aBuyer=document.createElement("a"); aBuyer.className="tag"; aBuyer.href=`${CONFIG.EXPLORER}/address/${it.buyer}`; aBuyer.target="_blank"; aBuyer.rel="noopener"; aBuyer.textContent="Buyer: "+shortAddr(it.buyer);
      act.appendChild(aBuyer);
    }
    card.appendChild(row1); card.appendChild(row2); card.appendChild(act);
    list.appendChild(card);
  }
}
async function confirmReceipt(oid){
  await withLoading("Xác nhận nhận hàng…", async()=>{
    await waitTx(muaban.connect(signer).confirmReceipt(oid), "Đang gửi xác nhận…");
    toast("Đã giải ngân cho người bán.");
  });
  await loadMyOrders(); await refreshBalances();
}
async function refundIfExpired(oid){
  await withLoading("Yêu cầu hoàn tiền…", async()=>{
    await waitTx(muaban.connect(signer).refundIfExpired(oid), "Đang gửi yêu cầu…");
    toast("Đã hoàn tiền (nếu đơn quá hạn).");
  });
  await loadMyOrders(); await refreshBalances();
}

/* -------------------- 12) TÌM KIẾM -------------------- */
async function onSearch(){ await loadProducts(($("#searchInput").value||"").trim()); }

/* -------------------- 13) BIND UI -------------------- */
function bindUI(){
  $("#btnConnect")?.addEventListener("click", connectWallet);
  $("#btnDisconnect")?.addEventListener("click", disconnectWallet);

  $("#btnRegister")?.addEventListener("click", onRegister);

  $("#btnCreate")?.addEventListener("click", openCreateModal);
  $("#btnSubmitCreate")?.addEventListener("click", onSubmitCreate);
  $("#formCreate .close")?.addEventListener("click", closeCreateModal);

  $("#btnSubmitUpdate")?.addEventListener("click", onSubmitUpdate);
  $("#formUpdate .close")?.addEventListener("click", closeUpdateModal);

  $("#btnSearch")?.addEventListener("click", onSearch);
  $("#searchInput")?.addEventListener("keydown",(e)=>{ if(e.key==="Enter") onSearch(); });

  $("#btnOrdersBuy")?.addEventListener("click", ()=>{
    $("#ordersBuySection").classList.remove("hidden");
    $("#ordersSellSection").classList.add("hidden");
    loadMyOrders(); window.scrollTo({top:document.body.scrollHeight, behavior:"smooth"});
  });
  $("#btnOrdersSell")?.addEventListener("click", ()=>{
    $("#ordersBuySection").classList.add("hidden");
    $("#ordersSellSection").classList.remove("hidden");
    loadMyOrders(); window.scrollTo({top:document.body.scrollHeight, behavior:"smooth"});
  });

  $("#buyQty")?.addEventListener("input", updateBuyTotalVIN);
  $("#btnSubmitBuy")?.addEventListener("click", onSubmitBuy);
  $("#formBuy .close")?.addEventListener("click", closeBuyModal);
}

/* -------------------- 14) INIT -------------------- */
(async function init(){
  try{
    await Promise.all([loadABIs(), setupProviders()]);
    bindContracts(true);
    bindUI();
    await fetchRates();
    setInterval(fetchRates, 60_000);
    await loadProducts();

    if (window.ethereum){
      window.ethereum.on("accountsChanged",()=>window.location.reload());
      window.ethereum.on("chainChanged",  ()=>window.location.reload());
    }
  }catch(e){
    console.error("init",e);
    toast("Lỗi khởi tạo ứng dụng.");
    hideOverlay(); // đề phòng overlay bật trước khi crash
  }
})();

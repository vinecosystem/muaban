/* ======================= muaban.vin — app.js =======================
 * Phụ thuộc: ethers v5 UMD (đã nhúng trong index.html)
 * Khớp UI: index.html (id phần tử, modal, nút…) và style.css
 * Hợp đồng: MuabanVND (VIC, chainId 88) + VIN (ERC20, 18 decimals)
 * ================================================================== */

/* -------------------- CẤU HÌNH CỐ ĐỊNH -------------------- */
const CONFIG = {
  CHAIN_ID: 88, // Viction mainnet
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://www.vicscan.xyz",
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0", // MuabanVND
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4", // VIN (18d)
  // API giá: VIN/VND = (VIC/USDT * 100) * (USDT/VND)
  BINANCE_VICUSDT: "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",
  COINGECKO_USDT_VND: "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",
  ABI_PATH_MUABAN: "Muaban_ABI.json",
  ABI_PATH_VIN: "VinToken_ABI.json",
};

/* -------------------- TIỆN ÍCH DOM -------------------- */
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

function shortAddr(addr){
  if(!addr) return "0x…";
  return addr.slice(0,6) + "…" + addr.slice(-4);
}

function fmtVND(n){
  try{
    return new Intl.NumberFormat('vi-VN').format(Math.floor(Number(n||0)));
  }catch(_){ return String(n); }
}

function toast(msg){
  // gọn nhẹ
  alert(msg);
}

/* -------------------- BIẾN TOÀN CỤC -------------------- */
let providerRead, providerWrite, signer, account;
let muaban, vin, MUABAN_ABI, VIN_ABI;

let isRegistered = false;
let vndPerVIN = null;        // (VIC/USDT * 100) * (USDT/VND)
let vinPerVNDWei = null;     // 1 VND quy ra VIN-wei (uint256 gửi vào placeOrder)
let products = [];           // cache danh sách sản phẩm
let productMap = new Map();  // pid -> product
let ordersBuy = [];          // đơn của tôi (buyer)
let ordersSell = [];         // đơn của tôi (seller)

/* -------------------- KHỞI TẠO -------------------- */
init();

async function init(){
  try{
    // Provider đọc
    providerRead = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);

    // Nạp ABI
    [MUABAN_ABI, VIN_ABI] = await Promise.all([
      fetch(CONFIG.ABI_PATH_MUABAN).then(r=>r.json()),
      fetch(CONFIG.ABI_PATH_VIN).then(r=>r.json()),
    ]);

    // Khởi tạo contract đọc
    muaban = new ethers.Contract(CONFIG.MUABAN_ADDR, MUABAN_ABI, providerRead);
    vin    = new ethers.Contract(CONFIG.VIN_ADDR,    VIN_ABI,    providerRead);

    // Gán sự kiện UI
    bindUI();

    // Hiển thị giá VIN/VND (dù chưa kết nối ví)
    updatePriceChip();

    // Tải danh sách sản phẩm từ log ProductCreated
    await loadAllProductsFromEvents();

    // Render danh sách
    renderProducts();

  }catch(err){
    console.error("init error:", err);
    toast("Lỗi khởi tạo ứng dụng. Vui lòng tải lại trang.");
  }
}

/* -------------------- LIÊN KẾT UI -------------------- */
function bindUI(){
  // Header & ví
  $("#btnConnect").addEventListener("click", connectWallet);
  $("#btnDisconnect").addEventListener("click", disconnectWallet);

  // Menu sau khi kết nối
  $("#btnRegister").addEventListener("click", onRegister);
  $("#btnCreate").addEventListener("click", ()=>openModal("#formCreate"));
  $("#btnOrdersBuy").addEventListener("click", async ()=>{
    await loadMyOrders();
    showOrders("buy");
  });
  $("#btnOrdersSell").addEventListener("click", async ()=>{
    await loadMyOrders();
    showOrders("sell");
  });

  // Search
  $("#btnSearch").addEventListener("click", doSearch);
  $("#searchInput").addEventListener("keydown", (e)=>{ if(e.key==="Enter") doSearch(); });

  // Modal create
  $("#btnSubmitCreate").addEventListener("click", submitCreate);
  $("#formCreate .close").addEventListener("click", ()=>closeModal("#formCreate"));

  // Modal update
  $("#btnSubmitUpdate").addEventListener("click", submitUpdate);
  $("#formUpdate .close").addEventListener("click", ()=>closeModal("#formUpdate"));

  // Modal buy
  $("#btnSubmitBuy").addEventListener("click", submitBuy);
  $("#formBuy .close").addEventListener("click", ()=>closeModal("#formBuy"));
}

/* -------------------- MODAL HELPERS -------------------- */
function openModal(sel){
  $(sel).classList.remove("hidden");
  document.body.classList.add("no-scroll");
}
function closeModal(sel){
  $(sel).classList.add("hidden");
  document.body.classList.remove("no-scroll");
}

/* -------------------- KẾT NỐI VÍ -------------------- */
async function connectWallet(){
  try{
    if(!window.ethereum){ toast("Vui lòng cài MetaMask."); return; }

    // Yêu cầu chain 88
    await window.ethereum.request({ method: 'eth_requestAccounts' });
    const web3 = new ethers.providers.Web3Provider(window.ethereum, "any");
    const net = await web3.getNetwork();
    if(Number(net.chainId) !== CONFIG.CHAIN_ID){
      // Thử switch
      try{
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: '0x58' }], // 88
        });
      }catch(switchErr){
        // Thử add chain
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: '0x58',
            chainName: 'Viction Mainnet',
            rpcUrls: [CONFIG.RPC_URL],
            nativeCurrency: { name:'VIC', symbol:'VIC', decimals:18 },
            blockExplorerUrls: [CONFIG.EXPLORER.replace('/address','')],
          }]
        });
      }
    }

    // Lấy signer
    providerWrite = web3;
    signer = providerWrite.getSigner();
    account = await signer.getAddress();

    // Re-instantiate contract write
    muaban = muaban.connect(signer);
    vin    = vin.connect(signer);

    // Cập nhật ví + số dư
    await refreshWalletBox();

    // Kiểm tra đăng ký
    isRegistered = await muaban.registered(account);
    updateMenuByRegistration();

    // Lắng nghe thay đổi tài khoản/chain
    window.ethereum.on('accountsChanged', ()=>location.reload());
    window.ethereum.on('chainChanged',   ()=>location.reload());

  }catch(err){
    console.error("connectWallet error:", err);
    toast("Kết nối ví thất bại.");
  }
}

function disconnectWallet(){
  // Chỉ ẩn UI (MetaMask không hỗ trợ 'disconnect' theo ý mình)
  account = null; signer = null; providerWrite = null;
  $("#walletBox").classList.add("hidden");
  $("#btnConnect").classList.remove("hidden");
  $("#menuBox").classList.add("hidden");
}

/* -------------------- GIÁ VIN/VND -------------------- */
async function updatePriceChip(){
  try{
    const [vicRes, cgkRes] = await Promise.all([
      fetch(CONFIG.BINANCE_VICUSDT).then(r=>r.json()),
      fetch(CONFIG.COINGECKO_USDT_VND).then(r=>r.json()),
    ]);
    const vicUsdt = Number(vicRes?.price || 0);
    const usdtVnd = Number(cgkRes?.tether?.vnd || 0);
    if(vicUsdt>0 && usdtVnd>0){
      vndPerVIN = vicUsdt * 100 * usdtVnd; // theo mô tả
      // tính 1 VND -> VIN-wei (làm tròn xuống)
      const WEI = ethers.constants.WeiPerEther; // 1e18
      const vinPerVND_BN = WEI.mul(1).div(ethers.BigNumber.from(Math.floor(vndPerVIN)));
      vinPerVNDWei = vinPerVND_BN;

      $("#vinPrice").textContent = `1 VIN = ${fmtVND(vndPerVIN)} VND`;
    }else{
      $("#vinPrice").textContent = "Không lấy được giá";
    }
  }catch(err){
    console.error("updatePriceChip error:", err);
    $("#vinPrice").textContent = "Không lấy được giá";
  }
}

/* -------------------- VÍ & SỐ DƯ -------------------- */
async function refreshWalletBox(){
  try{
    const vinBal = await vin.balanceOf(account);
    const vicBal = await providerWrite.getBalance(account);
    $("#vinBalance").textContent = `VIN: ${ethers.utils.formatUnits(vinBal, 18).slice(0,8)}`;
    $("#vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;
    const a = $("#accountShort");
    a.textContent = shortAddr(account);
    a.href = `${CONFIG.EXPLORER}/address/${account}`;
    $("#walletBox").classList.remove("hidden");
    $("#btnConnect").classList.add("hidden");
    $("#menuBox").classList.remove("hidden");
  }catch(err){
    console.error("refreshWalletBox error:", err);
  }
}

function updateMenuByRegistration(){
  // Nếu chưa đăng ký: chỉ hiện nút Đăng ký
  if(!isRegistered){
    $("#btnRegister").classList.remove("hidden");
    $("#btnCreate").classList.add("hidden");
    $("#btnOrdersBuy").classList.add("hidden");
    $("#btnOrdersSell").classList.add("hidden");
  }else{
    $("#btnRegister").classList.add("hidden");
    $("#btnCreate").classList.remove("hidden");
    $("#btnOrdersBuy").classList.remove("hidden");
    $("#btnOrdersSell").classList.remove("hidden");
  }
}

/* -------------------- ĐĂNG KÝ (0.001 VIN) -------------------- */
async function onRegister(){
  try{
    if(!signer) { toast("Vui lòng kết nối ví."); return; }

    // Lấy phí đăng ký từ contract (hằng REG_FEE)
    const REG_FEE = await muaban.REG_FEE();
    // approve trước cho owner? Contract thu REG_FEE = transferFrom(msg.sender, owner, REG_FEE)
    // => spender chính là owner contract (owner() trong contract)
    const ownerAddr = await muaban.owner();

    // Kiểm tra allowance
    const curAllow = await vin.allowance(account, ownerAddr);
    if(curAllow.lt(REG_FEE)){
      const tx1 = await vin.approve(ownerAddr, REG_FEE);
      await tx1.wait();
    }
    const tx = await muaban.payRegistration();
    await tx.wait();

    isRegistered = true;
    updateMenuByRegistration();
    toast("Đăng ký thành công!");

  }catch(err){
    console.error("payRegistration error:", err);
    toast("Đăng ký thất bại.");
  }
}

/* -------------------- LẤY DANH SÁCH SẢN PHẨM -------------------- */
/** Lấy tất cả sản phẩm bằng cách quét log ProductCreated (đúng interface trong ABI) */
async function loadAllProductsFromEvents(){
  try{
    products = [];
    productMap.clear();

    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("ProductCreated(uint256,address,string,uint256)");
    const logs = await providerRead.getLogs({
      address: CONFIG.MUABAN_ADDR,
      fromBlock: 0,
      toBlock: "latest",
      topics: [topic],
    });

    const pids = [];
    for(const log of logs){
      const parsed = iface.parseLog(log);
      const pid = parsed.args.productId.toString();
      pids.push(pid);
    }

    // Dedup & sort by pid asc
    const uniqPids = Array.from(new Set(pids)).map(x=>Number(x)).sort((a,b)=>a-b);

    // Fetch chi tiết sản phẩm
    for(const pid of uniqPids){
      try{
        const p = await muaban.getProduct(pid);
        if(p && p.seller !== ethers.constants.AddressZero){
          const rec = normalizeProduct(p);
          products.push(rec);
          productMap.set(rec.productId, rec);
        }
      }catch(_){}
    }
  }catch(err){
    console.error("loadAllProductsFromEvents error:", err);
  }
}

function normalizeProduct(p){
  return {
    productId: Number(p.productId.toString()),
    seller: p.seller,
    name: p.name,
    descriptionCID: p.descriptionCID,
    imageCID: p.imageCID,
    priceVND: Number(p.priceVND.toString()),
    deliveryDaysMax: Number(p.deliveryDaysMax.toString()),
    payoutWallet: p.payoutWallet,
    active: Boolean(p.active),
    createdAt: Number(p.createdAt?.toString?.() ?? 0),
    updatedAt: Number(p.updatedAt?.toString?.() ?? 0),
  };
}

/* -------------------- RENDER SẢN PHẨM -------------------- */
function renderProducts(list = products){
  const wrap = $("#productList");
  wrap.innerHTML = "";
  if(!list || list.length===0){
    wrap.innerHTML = `<div class="tag">Chưa có sản phẩm</div>`;
    return;
  }

  for(const p of list){
    const unit = extractUnitFromDescription(p.descriptionCID); // 'unit:...'
    const card = document.createElement("div");
    card.className = "product-card";

    const thumbSrc = toIPFSUrl(p.imageCID);
    card.innerHTML = `
      <img class="product-thumb" src="${thumbSrc}" alt="">
      <div class="product-info">
        <div class="product-top">
          <h3 class="product-title">${escapeHtml(p.name)}</h3>
          <span class="unit">${unit ? unit : ""}</span>
        </div>
        <div class="product-meta">
          <span class="price-vnd">${fmtVND(p.priceVND)} VND${unit?` / ${unit}`:""}</span>
          <span class="stock-badge ${p.active?'':'out'}">${p.active?'Còn hàng':'Hết hàng'}</span>
        </div>
        <div class="card-actions"></div>
      </div>
    `;

    const actions = $(".card-actions", card);

    // Nếu đã kết nối & đăng ký
    if(account && isRegistered){
      if(p.seller.toLowerCase() === account.toLowerCase()){
        // Seller => nút cập nhật
        const btnU = document.createElement("button");
        btnU.className = "btn";
        btnU.textContent = "Cập nhật sản phẩm";
        btnU.addEventListener("click", ()=>openUpdateForm(p));
        actions.appendChild(btnU);
      }else{
        // Buyer => nút mua (khi còn hàng)
        if(p.active){
          const btnB = document.createElement("button");
          btnB.className = "btn primary";
          btnB.textContent = "Mua";
          btnB.addEventListener("click", ()=>openBuyForm(p));
          actions.appendChild(btnB);
        }
      }
    }

    wrap.appendChild(card);
  }
}

function toIPFSUrl(x){
  if(!x) return "";
  if(x.startsWith("ipfs://")){
    const cid = x.replace("ipfs://","");
    return `https://ipfs.io/ipfs/${cid}`;
  }
  return x; // https link
}

function extractUnitFromDescription(desc){
  if(!desc) return "";
  const m = desc.match(/unit:([^\s]+)/i);
  return m ? m[1] : "";
}

function escapeHtml(str){
  return (str||"").replace(/[&<>"']/g, s=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[s]));
}

/* -------------------- TÌM KIẾM -------------------- */
function doSearch(){
  const q = ($("#searchInput").value||"").trim().toLowerCase();
  if(!q){ renderProducts(products); return; }
  const filtered = products.filter(p => (p.name||"").toLowerCase().includes(q));
  renderProducts(filtered);
}

/* -------------------- ĐĂNG SẢN PHẨM -------------------- */
function openUpdateForm(p){
  $("#updatePid").value = p.productId;
  $("#updatePrice").value = p.priceVND;
  $("#updateDays").value = p.deliveryDaysMax;
  $("#updateWallet").value = p.payoutWallet;
  $("#updateActive").checked = !!p.active;
  openModal("#formUpdate");
}

function openBuyForm(p){
  const info = $("#buyProductInfo");
  const unit = extractUnitFromDescription(p.descriptionCID);
  info.innerHTML = `
    <div><b>${escapeHtml(p.name)}</b></div>
    <div>Giá: <b>${fmtVND(p.priceVND)} VND${unit?` / ${unit}`:""}</b></div>
    <div>Người bán: <a class="mono" href="${CONFIG.EXPLORER}/address/${p.seller}" target="_blank" rel="noopener">${shortAddr(p.seller)}</a></div>
  `;
  $("#buyQty").value = 1;
  $("#buyTotalVIN").textContent = "Tổng VIN cần trả: 0";
  $("#btnSubmitBuy").dataset.pid = String(p.productId);
  updateBuyTotalVIN(); // cố gắng tính nếu đã có giá
  openModal("#formBuy");
}

// Cập nhật tổng VIN (client-side, gần đúng)
$("#buyQty").addEventListener("input", updateBuyTotalVIN);
function updateBuyTotalVIN(){
  try{
    const qty = Math.max(1, Number($("#buyQty").value||1));
    const pid = Number($("#btnSubmitBuy").dataset.pid||0);
    const p = productMap.get(pid);
    if(!p || !vndPerVIN) return;
    const totalVND = Number(p.priceVND) * qty;
    const totalVIN = totalVND / vndPerVIN; // 1 VIN = vndPerVIN
    $("#buyTotalVIN").textContent = `Tổng VIN cần trả: ${totalVIN.toFixed(6)}`;
  }catch(_){}
}

async function submitCreate(){
  try{
    if(!signer) { toast("Vui lòng kết nối ví."); return; }
    if(!isRegistered){ toast("Cần đăng ký ví trước."); return; }

    const name   = ($("#createName").value||"").trim();
    const ipfs   = ($("#createIPFS").value||"").trim();
    const unit   = ($("#createUnit").value||"").trim();
    const priceVND = ethers.BigNumber.from(String(Math.max(1, Number($("#createPrice").value||0))));
    const wallet = ($("#createWallet").value||"").trim();
    const days   = ethers.BigNumber.from(String(Math.max(1, Number($("#createDays").value||0))));
    if(!name || !ipfs || !unit || priceVND.lte(0) || !wallet || days.lte(0)){
      toast("Vui lòng nhập đủ thông tin."); return;
    }

    const descriptionCID = `unit:${unit}`;
    const imageCID = ipfs;
    const active = true;

    const tx = await muaban.createProduct(
      name, descriptionCID, imageCID,
      priceVND, days, wallet, active
    );
    const rc = await tx.wait();

    // Sau khi tạo, reload danh sách theo event
    await loadAllProductsFromEvents();
    renderProducts();
    closeModal("#formCreate");
    toast("Đăng sản phẩm thành công!");

  }catch(err){
    console.error("submitCreate error:", err);
    // Hiển thị chuỗi lỗi chi tiết để tránh 'Internal JSON-RPC error' mơ hồ
    const msg = err?.error?.message || err?.data?.message || err?.message || String(err);
    toast("Đăng sản phẩm thất bại:\n" + msg);
  }
}

async function submitUpdate(){
  try{
    if(!signer) { toast("Vui lòng kết nối ví."); return; }
    if(!isRegistered){ toast("Cần đăng ký ví trước."); return; }

    const pid  = Number($("#updatePid").value||0);
    const priceVND = ethers.BigNumber.from(String(Math.max(1, Number($("#updatePrice").value||0))));
    const days = ethers.BigNumber.from(String(Math.max(1, Number($("#updateDays").value||0))));
    const wallet = ($("#updateWallet").value||"").trim();
    const active = $("#updateActive").checked;

    if(!pid || priceVND.lte(0) || days.lte(0) || !wallet){
      toast("Thiếu dữ liệu cần thiết."); return;
    }

    const tx = await muaban.updateProduct(pid, priceVND, days, wallet, active);
    await tx.wait();

    // cập nhật lại cache
    const p = await muaban.getProduct(pid);
    const rec = normalizeProduct(p);
    productMap.set(pid, rec);
    const idx = products.findIndex(x=>x.productId===pid);
    if(idx>=0) products[idx] = rec;

    renderProducts();
    closeModal("#formUpdate");
    toast("Cập nhật sản phẩm thành công!");

  }catch(err){
    console.error("submitUpdate error:", err);
    const msg = err?.error?.message || err?.data?.message || err?.message || String(err);
    toast("Cập nhật thất bại:\n" + msg);
  }
}

/* -------------------- MUA HÀNG (placeOrder) -------------------- */
async function submitBuy(){
  try{
    if(!signer) { toast("Vui lòng kết nối ví."); return; }
    if(!isRegistered){ toast("Cần đăng ký ví trước."); return; }
    if(!vinPerVNDWei){
      await updatePriceChip();
      if(!vinPerVNDWei){ toast("Chưa tính được tỷ giá. Thử lại."); return; }
    }

    const pid = Number($("#btnSubmitBuy").dataset.pid||0);
    const qty = Math.max(1, Number($("#buyQty").value||1));
    const name = ($("#buyName").value||"").trim();
    const addr = ($("#buyAddress").value||"").trim();
    const phone = ($("#buyPhone").value||"").trim();
    const note = ($("#buyNote").value||"").trim();
    if(!pid || !qty || !name || !addr || !phone){
      toast("Vui lòng nhập đủ thông tin mua hàng."); return;
    }

    const p = productMap.get(pid);
    if(!p || !p.active){ toast("Sản phẩm không khả dụng."); return; }

    // Chuẩn bị buyerInfoCipher (obfuscation đơn giản: base64 JSON)
    const buyerInfo = { name, addr, phone, note };
    const buyerInfoCipher = "b64:" + btoa(unescape(encodeURIComponent(JSON.stringify(buyerInfo))));

    // Tính tổng VIN cần escrow để approve trước (ceil bảo vệ seller đã ở contract)
    // totalVND = priceVND * qty
    const totalVND = ethers.BigNumber.from(String(p.priceVND)).mul(qty);
    const vinPerVND = vinPerVNDWei; // BN VIN-wei/1 VND
    const vinAmount = totalVND.mul(vinPerVND);

    // approve contract (spender là địa chỉ Muaban)
    const allowance = await vin.allowance(account, CONFIG.MUABAN_ADDR);
    if(allowance.lt(vinAmount)){
      const tx1 = await vin.approve(CONFIG.MUABAN_ADDR, vinAmount);
      await tx1.wait();
    }

    // Gọi placeOrder(productId, quantity, vinPerVND, buyerInfoCipher)
    const tx = await muaban.placeOrder(
      p.productId,
      ethers.BigNumber.from(String(qty)),
      vinPerVND,              // BN
      buyerInfoCipher
    );
    await tx.wait();

    closeModal("#formBuy");
    toast("Đặt hàng thành công!");

  }catch(err){
    console.error("submitBuy error:", err);
    const msg = err?.error?.message || err?.data?.message || err?.message || String(err);
    toast("Đặt hàng thất bại:\n" + msg);
  }
}

/* -------------------- ĐƠN HÀNG CỦA TÔI -------------------- */
/** Tải đơn hàng bằng cách quét event OrderPlaced và lọc theo buyer/seller */
async function loadMyOrders(){
  if(!account) return;
  try{
    ordersBuy = [];
    ordersSell = [];

    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("OrderPlaced(uint256,uint256,address,uint256,uint256)");
    const logs = await providerRead.getLogs({
      address: CONFIG.MUABAN_ADDR,
      fromBlock: 0,
      toBlock: "latest",
      topics: [topic],
    });

    for(const log of logs){
      const parsed = iface.parseLog(log);
      const oid = Number(parsed.args.orderId.toString());
      const productId = Number(parsed.args.productId.toString());
      const buyer = String(parsed.args.buyer).toLowerCase();

      // lấy chi tiết order
      const o = await muaban.getOrder(oid);
      const order = {
        orderId: Number(o.orderId.toString()),
        productId: Number(o.productId.toString()),
        buyer: o.buyer,
        seller: o.seller,
        quantity: Number(o.quantity.toString()),
        vinAmount: o.vinAmount.toString(),
        placedAt: Number(o.placedAt.toString()),
        deadline: Number(o.deadline.toString()),
        status: Number(o.status),
        buyerInfoCipher: o.buyerInfoCipher,
      };

      // đảm bảo có product trong cache
      if(!productMap.has(order.productId)){
        try{
          const p = await muaban.getProduct(order.productId);
          const rec = normalizeProduct(p);
          productMap.set(rec.productId, rec);
          if(!products.find(x=>x.productId===rec.productId)){
            products.push(rec);
          }
        }catch(_){}
      }

      if(order.buyer.toLowerCase() === account.toLowerCase()){
        ordersBuy.push(order);
      }
      if(order.seller.toLowerCase() === account.toLowerCase()){
        ordersSell.push(order);
      }
    }

    renderProducts(); // đảm bảo giao diện không mất

  }catch(err){
    console.error("loadMyOrders error:", err);
  }
}

function showOrders(type){
  const secBuy = $("#ordersBuySection");
  const secSell = $("#ordersSellSection");
  secBuy.classList.add("hidden");
  secSell.classList.add("hidden");

  if(type==="buy"){
    renderOrderList("#ordersBuyList", ordersBuy, "buy");
    secBuy.classList.remove("hidden");
  }else{
    renderOrderList("#ordersSellList", ordersSell, "sell");
    secSell.classList.remove("hidden");
  }
}

function renderOrderList(sel, list, role){
  const box = $(sel);
  box.innerHTML = "";
  if(!list || list.length===0){
    box.innerHTML = `<div class="tag">Chưa có dữ liệu</div>`;
    return;
  }

  for(const o of list){
    const p = productMap.get(o.productId);
    const div = document.createElement("div");
    div.className = "order-card";

    const vinHuman = ethers.utils.formatUnits(o.vinAmount, 18);
    const statusTxt = ["NONE","ĐÃ ĐẶT","ĐÃ GIẢI NGÂN","ĐÃ HOÀN TIỀN"][o.status] || String(o.status);
    const deadline = new Date(o.deadline*1000).toLocaleString('vi-VN');

    div.innerHTML = `
      <div class="order-row"><span class="order-strong">#${o.orderId}</span> · Sản phẩm #${o.productId} · Trạng thái: <b>${statusTxt}</b></div>
      <div class="order-row">VIN escrow: <span class="order-strong">${vinHuman}</span></div>
      <div class="order-row">Hạn giao hàng: <span class="order-strong">${deadline}</span></div>
      <div class="order-row">Người bán: <a class="mono" href="${CONFIG.EXPLORER}/address/${o.seller}" target="_blank" rel="noopener">${shortAddr(o.seller)}</a></div>
      <div class="order-row">Người mua: <a class="mono" href="${CONFIG.EXPLORER}/address/${o.buyer}" target="_blank" rel="noopener">${shortAddr(o.buyer)}</a></div>
      <div class="card-actions"></div>
    `;

    const actions = $(".card-actions", div);
    if(role==="buy"){
      // Buyer có thể xác nhận nhận hàng hoặc hoàn tiền khi quá hạn (status = PLACED)
      if(o.status===1){
        const btnC = document.createElement("button");
        btnC.className = "btn primary";
        btnC.textContent = "Xác nhận đã nhận hàng";
        btnC.addEventListener("click", ()=>confirmReceipt(o.orderId));
        actions.appendChild(btnC);

        const btnR = document.createElement("button");
        btnR.className = "btn";
        btnR.textContent = "Hoàn tiền (quá hạn)";
        btnR.addEventListener("click", ()=>refundIfExpired(o.orderId));
        actions.appendChild(btnR);
      }
    }else if(role==="sell"){
      // Seller xem thông tin người mua (giải mã base64)
      const btnView = document.createElement("button");
      btnView.className = "btn";
      btnView.textContent = "Xem thông tin người mua";
      btnView.addEventListener("click", ()=>showBuyerInfo(o.buyerInfoCipher));
      actions.appendChild(btnView);
    }

    box.appendChild(div);
  }
}

function showBuyerInfo(cipher){
  try{
    if(cipher?.startsWith("b64:")){
      const json = decodeURIComponent(escape(atob(cipher.slice(4))));
      const obj = JSON.parse(json);
      alert(
        `Họ tên: ${obj.name}\nĐịa chỉ: ${obj.addr}\nSĐT: ${obj.phone}\nPhụ ghi: ${obj.note||""}`
      );
    }else{
      alert("Không đọc được thông tin.");
    }
  }catch(_){
    alert("Không đọc được thông tin.");
  }
}

/* -------------------- HÀNH ĐỘNG ĐƠN HÀNG -------------------- */
async function confirmReceipt(orderId){
  try{
    const tx = await muaban.confirmReceipt(ethers.BigNumber.from(String(orderId)));
    await tx.wait();
    await loadMyOrders();
    showOrders("buy");
    toast("Đã xác nhận nhận hàng.");
  }catch(err){
    console.error("confirmReceipt error:", err);
    const msg = err?.error?.message || err?.data?.message || err?.message || String(err);
    toast("Thao tác thất bại:\n" + msg);
  }
}

async function refundIfExpired(orderId){
  try{
    const tx = await muaban.refundIfExpired(ethers.BigNumber.from(String(orderId)));
    await tx.wait();
    await loadMyOrders();
    showOrders("buy");
    toast("Đã yêu cầu hoàn tiền.");
  }catch(err){
    console.error("refundIfExpired error:", err);
    const msg = err?.error?.message || err?.data?.message || err?.message || String(err);
    toast("Thao tác thất bại:\n" + msg);
  }
}

/* ======================= HẾT FILE app.js ======================= */

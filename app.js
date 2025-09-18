/* =========================================================
   muaban.vin — app.js (ethers v5)
   Đồng bộ: index.html + style.css
   Tính năng:
   - Kết nối ví (Viction Mainnet 88), hiển thị số dư VIN/VIC
   - Lấy tỷ giá: 1 VIN = VICUSDT * 100 * (USDT→VND từ CoinGecko)
   - Đăng ký ví: approve(0.001 VIN) → payRegistration()
   - Đăng SP: createProduct(...)
   - Danh sách SP: scan sự kiện ProductCreated + getProduct(pid)
   - Mua hàng: số lượng + tính tổng VIN (ceil), approve + placeOrder(...)
   - Đơn mua/đơn bán: scan OrderPlaced, getOrder(oid)
   - Buyer: confirmReceipt(oid), refundIfExpired(oid)
   - Tìm kiếm theo tên (client-side)
========================================================= */

/* -------------------- DOM helpers -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show=(el)=>el && el.classList.remove("hidden");
const hide=(el)=>el && el.classList.add("hidden");
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`:"";
const fmt4=(x)=>Number(x).toFixed(4);
const fmt0=(x)=>Math.floor(Number(x)).toString();
const toast=(m)=>{
  const t=$("#toast"); if(!t) return;
  t.textContent = m; t.classList.add("show"); t.classList.remove("hidden");
  setTimeout(()=>{ t.classList.remove("show"); t.classList.add("hidden"); }, 3000);
};

/* -------------------- Cấu hình -------------------- */
const CONFIG = {
  CHAIN_ID: 88,
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://vicscan.xyz",
  MUABAN_ADDR: window.MUABAN_ADDR, // từ index.html
  VIN_ADDR: window.VIN_ADDR,       // từ index.html
  // API giá
  BINANCE_VICUSDT: "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",
  COINGECKO_USDTVND: "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",
  // UI
  GAS_LIMIT: "600000", // rộng tay cho mọi tx
};

/* -------------------- Biến toàn cục -------------------- */
let providerRead, providerWrite, signer, account;
let muaban, vin;
let vinRateVND = null;        // 1 VIN = X VND (float)
let vinPerVNDWei = null;      // VIN wei per 1 VND (BigNumber)
let products = [];            // [{pid, data}]
let orders = [];              // [{oid, data}] (toàn mạng, lọc theo buyer/seller khi render)
let isRegistered = false;

/* -------------------- ABI (nhúng từ file) -------------------- */
// Muaban ABI (rút từ Muaban_ABI.json)
const MUABAN_ABI = /* abridged but complete for used methods */ 
<?php /* This line is ignored by browser; just a delimiter for readability. */ ?>
[
  {"inputs":[{"internalType":"address","name":"vinToken","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"orderId","type":"uint256"},{"indexed":true,"internalType":"uint256","name":"productId","type":"uint256"},{"indexed":true,"internalType":"address","name":"buyer","type":"address"},{"indexed":false,"internalType":"uint256","name":"quantity","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"vinAmount","type":"uint256"}],"name":"OrderPlaced","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"orderId","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"vinAmount","type":"uint256"}],"name":"OrderRefunded","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"orderId","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"vinAmount","type":"uint256"}],"name":"OrderReleased","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"productId","type":"uint256"},{"indexed":true,"internalType":"address","name":"seller","type":"address"},{"indexed":false,"internalType":"string","name":"name","type":"string"},{"indexed":false,"internalType":"uint256","name":"priceVND","type":"uint256"}],"name":"ProductCreated","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"productId","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"priceVND","type":"uint256"},{"indexed":false,"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"indexed":false,"internalType":"bool","name":"active","type":"bool"}],"name":"ProductUpdated","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"user","type":"address"}],"name":"Registered","type":"event"},
  {"inputs":[],"name":"REG_FEE","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],"name":"confirmReceipt","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"string","name":"name","type":"string"},{"internalType":"string","name":"descriptionCID","type":"string"},{"internalType":"string","name":"imageCID","type":"string"},{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"bool","name":"active","type":"bool"}],"name":"createProduct","outputs":[{"internalType":"uint256","name":"pid","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"oid","type":"uint256"}],"name":"getOrder","outputs":[{"components":[{"internalType":"uint256","name":"orderId","type":"uint256"},{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"address","name":"buyer","type":"address"},{"internalType":"address","name":"seller","type":"address"},{"internalType":"uint256","name":"quantity","type":"uint256"},{"internalType":"uint256","name":"vinAmount","type":"uint256"},{"internalType":"uint256","name":"placedAt","type":"uint256"},{"internalType":"uint256","name":"deadline","type":"uint256"},{"internalType":"enum MuabanVND.OrderStatus","name":"status","type":"uint8"},{"internalType":"string","name":"buyerInfoCipher","type":"string"}],"internalType":"struct MuabanVND.Order","name":"","type":"tuple"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"}],"name":"getProduct","outputs":[{"components":[{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"address","name":"seller","type":"address"},{"internalType":"string","name":"name","type":"string"},{"internalType":"string","name":"descriptionCID","type":"string"},{"internalType":"string","name":"imageCID","type":"string"},{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"bool","name":"active","type":"bool"},{"internalType":"uint64","name":"createdAt","type":"uint64"},{"internalType":"uint64","name":"updatedAt","type":"uint64"}],"internalType":"struct MuabanVND.Product","name":"","type":"tuple"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"seller","type":"address"}],"name":"getSellerProductIds","outputs":[{"internalType":"uint256[]","name":""}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":""}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"payRegistration","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"uint256","name":"quantity","type":"uint256"},{"internalType":"uint256","name":"vinPerVND","type":"uint256"},{"internalType":"string","name":"buyerInfoCipher","type":"string"}],"name":"placeOrder","outputs":[{"internalType":"uint256","name":"oid","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],"name":"refundIfExpired","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"registered","outputs":[{"internalType":"bool","name":""}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"},{"internalType":"bool","name":"active","type":"bool"}],"name":"setProductActive","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"},{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"bool","name":"active","type":"bool"}],"name":"updateProduct","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[],"name":"vin","outputs":[{"internalType":"contract IERC20","name":"","type":"address"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"vinDecimals","outputs":[{"internalType":"uint8","name":""}],"stateMutability":"view","type":"function"}
];
// VIN ERC20 (trích đủ hàm dùng)
const VIN_ABI = [
  {"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"}],"name":"allowance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":""}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"owner","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":""}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"decimals","outputs":[{"internalType":"uint8","name":""}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"transfer","outputs":[{"internalType":"bool","name":""}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"sender","type":"address"},{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"transferFrom","outputs":[{"internalType":"bool","name":""}],"stateMutability":"nonpayable","type":"function"}
];

/* -------------------- Khởi tạo Provider/Contract -------------------- */
function initProviders() {
  providerRead  = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
  if (window.ethereum) {
    providerWrite = new ethers.providers.Web3Provider(window.ethereum, "any");
  }
  muaban = new ethers.Contract(CONFIG.MUABAN_ADDR, MUABAN_ABI, providerRead);
  vin    = new ethers.Contract(CONFIG.VIN_ADDR, VIN_ABI, providerRead);
}

/* -------------------- Kết nối ví -------------------- */
async function connectWallet() {
  if (!window.ethereum) { toast("Vui lòng cài MetaMask."); return; }
  await providerWrite.send("eth_requestAccounts", []);
  const network = await providerWrite.getNetwork();
  if (Number(network.chainId) !== CONFIG.CHAIN_ID) {
    toast("Sai mạng. Chuyển sang Viction (chainId 88).");
    // Cố gắng switch
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x58" }]
      });
    } catch (e) {
      // Nếu chưa add
      try {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: "0x58",
            chainName: "Viction Mainnet",
            rpcUrls: [CONFIG.RPC_URL],
            blockExplorerUrls: [CONFIG.EXPLORER],
            nativeCurrency: { name: "VIC", symbol: "VIC", decimals: 18 }
          }]
        });
      } catch (e2) {
        console.error(e2); return;
      }
    }
  }
  signer = providerWrite.getSigner();
  account = (await signer.getAddress()).toLowerCase();

  // Gắn write signer cho contracts
  muaban = muaban.connect(signer);
  vin    = vin.connect(signer);

  $("#accountShort").textContent = short(account);
  hide($("#btnConnect")); show($("#walletInfo")); show($("#menu"));

  await refreshBalances();
  await checkRegistered();
  await refreshRate();
  await loadAllProducts();     // hiển thị sản phẩm
  await loadAllOrders();       // lưu bộ nhớ tất cả order (để lọc theo buyer/seller)
  renderOrdersForMe();
}

/* -------------------- Ngắt ví -------------------- */
function disconnectWallet() {
  signer = null; account = null;
  hide($("#walletInfo")); show($("#btnConnect")); hide($("#menu"));
}

/* -------------------- Balances -------------------- */
async function refreshBalances() {
  try {
    if (!account) return;
    const [vinBal, vicBal] = await Promise.all([
      vin.balanceOf(account),
      providerWrite.getBalance(account)
    ]);
    $("#vinBalance").textContent = fmt4(ethers.utils.formatEther(vinBal));
    $("#vicBalance").textContent = fmt4(ethers.utils.formatEther(vicBal));
  } catch (e) { console.error(e); }
}

/* -------------------- Đăng ký ví -------------------- */
async function checkRegistered() {
  if (!account) return;
  try {
    isRegistered = await muaban.registered(account);
    if (!isRegistered) { show($("#registerBox")); } else { hide($("#registerBox")); }
  } catch (e){ console.error(e); }
}

async function ensureAllowance(needed) {
  // needed: BigNumber
  const allowance = await vin.allowance(account, CONFIG.MUABAN_ADDR);
  if (allowance.gte(needed)) return;
  const tx = await vin.approve(CONFIG.MUABAN_ADDR, needed, { gasLimit: CONFIG.GAS_LIMIT });
  toast("Đang approve VIN...");
  await tx.wait();
}

async function doRegister() {
  try {
    const regFee = await muaban.REG_FEE(); // 0.001 VIN
    await ensureAllowance(regFee);
    const tx = await muaban.payRegistration({ gasLimit: CONFIG.GAS_LIMIT });
    toast("Đang đăng ký ví...");
    await tx.wait();
    toast("Đăng ký thành công.");
    await checkRegistered();
  } catch (e){ console.error(e); toast("Lỗi đăng ký ví."); }
}

/* -------------------- Tỷ giá VIN/VND -------------------- */
async function refreshRate() {
  try {
    // VIC/USDT từ Binance
    const r1 = await fetch(CONFIG.BINANCE_VICUSDT).then(r=>r.json());
    const vicUsdt = Number(r1?.price || 0);

    // USDT → VND từ CoinGecko
    const r2 = await fetch(CONFIG.COINGECKO_USDTVND).then(r=>r.json());
    const usdtVnd = Number(r2?.tether?.vnd || 0);

    if (!vicUsdt || !usdtVnd) throw new Error("rate fetch fail");

    // 1 VIN = (VIC/USDT * 100) * (USDT→VND)
    vinRateVND = vicUsdt * 100 * usdtVnd;

    // VIN wei per 1 VND = ceil(1e18 / vinRateVND)
    const wei1e18 = ethers.BigNumber.from("1000000000000000000");
    const denom = ethers.BigNumber.from(Math.ceil(vinRateVND).toString());
    vinPerVNDWei = wei1e18.div(denom).add( wei1e18.mod(denom).isZero() ? 0 : 1 ); // ceil

    $("#vinRate").textContent = `1 VIN = ${Number(vinRateVND).toLocaleString("vi-VN")} VND`;
  } catch (e) {
    console.error(e);
    $("#vinRate").textContent = "1 VIN = … VND";
  }
}

/* -------------------- SẢN PHẨM -------------------- */
// Quét sự kiện ProductCreated để biết các pid, rồi getProduct(pid)
async function loadAllProducts() {
  try {
    products = [];
    const fromBlock = 0; // có thể đặt block bắt đầu nếu muốn tối ưu
    const toBlock = "latest";
    const filter = muaban.filters.ProductCreated();
    const logs = await muaban.queryFilter(filter, fromBlock, toBlock);

    const pidSet = new Set();
    logs.forEach(l => { const pid = l.args?.productId?.toNumber?.() ?? Number(l.args.productId); pidSet.add(pid); });

    const pids = Array.from(pidSet).sort((a,b)=>a-b);
    const detailPromises = pids.map(async (pid)=>{
      const p = await muaban.getProduct(pid);
      return { pid, data: p };
    });
    products = await Promise.all(detailPromises);

    renderProducts(products);
  } catch (e){ console.error(e); }
}

function renderProducts(list) {
  const box = $("#productList");
  box.innerHTML = "";
  const tpl = $("#productItemTpl");

  list.forEach(({pid, data})=>{
    const clone = document.importNode(tpl.content, true);
    const el = clone.querySelector(".product");
    const img = clone.querySelector(".thumb");
    const title = clone.querySelector(".title");
    const price = clone.querySelector(".price");
    const status= clone.querySelector(".status");
    const actions= clone.querySelector(".actions");

    img.src = data.imageCID || "";
    img.alt = data.name || "";
    title.textContent = data.name || (`Sản phẩm #${pid}`);

    price.textContent = `${Number(data.priceVND).toLocaleString("vi-VN")} VND`;
    status.textContent = `Trạng thái: ${data.active ? "Còn hàng" : "Hết hàng"} • Giao tối đa ${data.deliveryDaysMax} ngày`;

    // Nút hành động
    actions.innerHTML = "";
    if (data.active) {
      const btnBuy = document.createElement("button");
      btnBuy.className = "btn primary";
      btnBuy.textContent = "Mua";
      btnBuy.onclick = ()=> openBuyForm(pid, data);
      actions.appendChild(btnBuy);
    }
    // Nếu là seller của sản phẩm
    if (account && data.seller?.toLowerCase?.() === account) {
      const btnUpd = document.createElement("button");
      btnUpd.className = "btn";
      btnUpd.textContent = "Cập nhật";
      btnUpd.onclick = ()=> quickUpdateProduct(pid, data);
      actions.appendChild(btnUpd);
    }

    box.appendChild(clone);
  });
}

/* Tìm kiếm theo tên (client-side) */
function doSearch() {
  const kw = ($("#searchInput").value || "").trim().toLowerCase();
  if (!kw) { renderProducts(products); return; }
  const filtered = products.filter(({data}) => (data.name||"").toLowerCase().includes(kw));
  renderProducts(filtered);
}

/* Đăng sản phẩm */
async function submitCreate() {
  try {
    if (!signer || !account) { toast("Vui lòng kết nối ví."); return; }
    if (!isRegistered) { toast("Bạn cần đăng ký ví trước."); return; }

    const name = ($("#createName").value||"").trim();
    const imageCID = ($("#createIPFS").value||"").trim();
    const unit = ($("#createUnit").value||"").trim();
    const priceVNDNum = Number($("#createPrice").value||0);
    const payoutWallet = ($("#createWallet").value||"").trim();
    const days = Number($("#createDays").value||0);

    if (!name || !imageCID || !unit || !priceVNDNum || !payoutWallet || !days) { toast("Vui lòng nhập đủ thông tin."); return; }

    // descriptionCID nhúng "unit:<...>" để UI đọc đơn vị
    const descriptionCID = `unit:${unit}`;

    // priceVND là số nguyên theo hợp đồng
    const priceVND = ethers.BigNumber.from(String(Math.floor(priceVNDNum)));

    const tx = await muaban.createProduct(
      name,
      descriptionCID,
      imageCID,
      priceVND,
      days,
      payoutWallet,
      true,
      { gasLimit: CONFIG.GAS_LIMIT }
    );
    toast("Đang đăng sản phẩm...");
    const rc = await tx.wait();

    // Lấy pid từ event ProductCreated
    const ev = rc.events?.find(e=>e.event==="ProductCreated");
    if (ev) {
      const pid = ev.args.productId.toNumber();
      const p = await muaban.getProduct(pid);
      products.push({pid, data: p});
      renderProducts(products);
    } else {
      await loadAllProducts();
    }

    // clear form
    $("#createName").value="";
    $("#createIPFS").value="";
    $("#createUnit").value="";
    $("#createPrice").value="";
    $("#createWallet").value="";
    $("#createDays").value="";
    hide($("#createForm"));
    toast("Đăng sản phẩm thành công.");
  } catch (e){
    console.error("submitCreate error:", e);
    toast("Lỗi đăng sản phẩm.");
  }
}

/* Cập nhật nhanh (prompt-based) cho seller */
async function quickUpdateProduct(pid, data) {
  try {
    const price = prompt("Giá mới (VND):", String(data.priceVND||""));
    if (price===null) return;
    const delivery = prompt("Thời gian giao tối đa (ngày):", String(data.deliveryDaysMax||""));
    if (delivery===null) return;
    const wallet = prompt("Ví nhận thanh toán:", data.payoutWallet||"");
    if (wallet===null) return;
    const active = confirm("Bật bán (OK = Còn hàng / Cancel = Hết hàng)?");

    const tx = await muaban.updateProduct(
      pid,
      ethers.BigNumber.from(String(Math.floor(Number(price)||0))),
      Number(delivery||0),
      wallet,
      active,
      { gasLimit: CONFIG.GAS_LIMIT }
    );
    toast("Đang cập nhật sản phẩm...");
    await tx.wait();
    await loadAllProducts();
  } catch (e){ console.error(e); toast("Cập nhật thất bại."); }
}

/* -------------------- MUA HÀNG -------------------- */
function openBuyForm(pid, p) {
  $("#buyProductId").value = String(pid);
  $("#buyName").value = "";
  $("#buyAddress").value = "";
  $("#buyPhone").value = "";
  $("#buyNote").value = "";
  $("#buyQuantity").value = "1";
  $("#buyTotalVIN").textContent = "0";

  show($("#buyForm"));

  // cập nhật tổng VIN theo số lượng hiện tại
  updateBuyTotal();
}

function encodeBuyerInfo(obj) {
  // Tạm: JSON -> base64 (obfuscation nhẹ; có thể nâng cấp AES-GCM sau)
  const s = JSON.stringify(obj);
  return btoa(unescape(encodeURIComponent(s)));
}

function updateBuyTotal() {
  try {
    const pid = Number($("#buyProductId").value);
    const p = products.find(x=>x.pid===pid)?.data;
    if (!p || !vinPerVNDWei) { $("#buyTotalVIN").textContent = "0"; return; }
    const qty = Math.max(1, Number($("#buyQuantity").value||1));
    const totalVND = ethers.BigNumber.from(String(p.priceVND)).mul(ethers.BigNumber.from(String(qty)));

    // vin = ceil(totalVND * vinPerVNDWei / 1)
    const vin = totalVND.mul(vinPerVNDWei); // đã là ceil cho 1 VND → seller-safe
    $("#buyTotalVIN").textContent = ethers.utils.formatEther(vin);
  } catch (e){ console.error(e); $("#buyTotalVIN").textContent = "0"; }
}

async function submitBuy() {
  try {
    if (!signer || !account) { toast("Vui lòng kết nối ví."); return; }
    if (!isRegistered) { toast("Bạn cần đăng ký ví trước."); return; }

    const pid = Number($("#buyProductId").value||0);
    const p = products.find(x=>x.pid===pid)?.data;
    if (!p) { toast("Không tìm thấy sản phẩm."); return; }

    const name = ($("#buyName").value||"").trim();
    const addr = ($("#buyAddress").value||"").trim();
    const phone= ($("#buyPhone").value||"").trim();
    const note = ($("#buyNote").value||"").trim();
    const qty  = Math.max(1, Number($("#buyQuantity").value||1));

    if (!name || !addr || !phone) { toast("Vui lòng điền đủ thông tin giao hàng."); return; }
    if (!vinPerVNDWei) { toast("Chưa có tỷ giá. Hãy thử lại sau."); return; }

    // Tính số VIN cần escrow (ceil)
    const totalVND = ethers.BigNumber.from(String(p.priceVND)).mul(ethers.BigNumber.from(String(qty)));
    const vinAmount = totalVND.mul(vinPerVNDWei); // BigNumber wei

    // Approve đủ vinAmount
    await ensureAllowance(vinAmount);

    // Mã hoá thông tin buyer
    const buyerInfoCipher = encodeBuyerInfo({name, addr, phone, note});

    // Gọi placeOrder(productId, quantity, vinPerVND, buyerInfoCipher)
    const tx = await muaban.placeOrder(
      pid,
      ethers.BigNumber.from(String(qty)),
      vinPerVNDWei,
      buyerInfoCipher,
      { gasLimit: CONFIG.GAS_LIMIT }
    );
    toast("Đang đặt hàng...");
    const rc = await tx.wait();

    // Cập nhật orders cache
    const ev = rc.events?.find(e=>e.event==="OrderPlaced");
    if (ev) {
      const oid = ev.args.orderId.toNumber();
      const od = await muaban.getOrder(oid);
      orders.push({ oid, data: od });
    } else {
      await loadAllOrders();
    }
    hide($("#buyForm"));
    renderOrdersForMe();
    toast("Đặt hàng thành công.");
  } catch (e){
    console.error("submitBuy error:", e);
    toast("Lỗi đặt hàng.");
  }
}

/* -------------------- ĐƠN HÀNG -------------------- */
async function loadAllOrders() {
  try {
    orders = [];
    const filter = muaban.filters.OrderPlaced();
    const logs = await muaban.queryFilter(filter, 0, "latest");
    const oids = logs.map(l => l.args?.orderId?.toNumber?.() ?? Number(l.args.orderId));
    const tasks = oids.map(async (oid)=>({oid, data: await muaban.getOrder(oid)}));
    orders = await Promise.all(tasks);
  } catch (e){ console.error(e); }
}

function renderOrdersForMe() {
  const buyBox = $("#ordersBuyList"); const sellBox = $("#ordersSellList");
  buyBox.innerHTML=""; sellBox.innerHTML="";

  if (!account) return;

  const myBuys  = orders.filter(o => o.data.buyer?.toLowerCase?.() === account);
  const mySells = orders.filter(o => o.data.seller?.toLowerCase?.() === account);

  myBuys.forEach(o=>{
    const div = document.createElement("div");
    div.className = "order";
    div.innerHTML = `
      <div><b>Đơn #${o.oid}</b> • SP #${o.data.productId} • SL: ${o.data.quantity}</div>
      <div>VIN: ${ethers.utils.formatEther(o.data.vinAmount)}</div>
      <div>Deadline: ${new Date(Number(o.data.deadline)*1000).toLocaleString("vi-VN")}</div>
      <div>Trạng thái: ${["","PLACED","RELEASED","REFUNDED"][o.data.status]||o.data.status}</div>
      <div class="actions"></div>
    `;
    const actions = div.querySelector(".actions");
    if (o.data.status === 1) { // PLACED
      const b1 = document.createElement("button");
      b1.className="btn primary"; b1.textContent="Xác nhận đã nhận hàng";
      b1.onclick = ()=> confirmReceipt(o.oid);

      const b2 = document.createElement("button");
      b2.className="btn"; b2.textContent="Hoàn tiền (quá hạn)";
      b2.onclick = ()=> refundIfExpired(o.oid);

      actions.appendChild(b1); actions.appendChild(b2);
    }
    buyBox.appendChild(div);
  });

  mySells.forEach(o=>{
    const div = document.createElement("div");
    div.className = "order";
    div.innerHTML = `
      <div><b>Đơn #${o.oid}</b> • SP #${o.data.productId} • SL: ${o.data.quantity}</div>
      <div>VIN: ${ethers.utils.formatEther(o.data.vinAmount)}</div>
      <div>Deadline: ${new Date(Number(o.data.deadline)*1000).toLocaleString("vi-VN")}</div>
      <div>Trạng thái: ${["","PLACED","RELEASED","REFUNDED"][o.data.status]||o.data.status}</div>
    `;
    sellBox.appendChild(div);
  });
}

async function confirmReceipt(oid) {
  try {
    const tx = await muaban.confirmReceipt(oid, { gasLimit: CONFIG.GAS_LIMIT });
    toast("Đang xác nhận nhận hàng...");
    await tx.wait();
    await loadAllOrders();
    renderOrdersForMe();
    toast("Đã giải ngân cho người bán.");
  } catch (e){ console.error(e); toast("Lỗi xác nhận."); }
}

async function refundIfExpired(oid) {
  try {
    const tx = await muaban.refundIfExpired(oid, { gasLimit: CONFIG.GAS_LIMIT });
    toast("Đang yêu cầu hoàn tiền...");
    await tx.wait();
    await loadAllOrders();
    renderOrdersForMe();
    toast("Hoàn tiền thành công (nếu đơn đã quá hạn).");
  } catch (e){ console.error(e); toast("Lỗi hoàn tiền."); }
}

/* -------------------- Hiển thị form/section -------------------- */
function openCreate() { hide($("#ordersBuy")); hide($("#ordersSell")); show($("#createForm")); }
function openOrdersBuy() { hide($("#createForm")); hide($("#ordersSell")); show($("#ordersBuy")); renderOrdersForMe(); }
function openOrdersSell() { hide($("#createForm")); hide($("#ordersBuy")); show($("#ordersSell")); renderOrdersForMe(); }

/* -------------------- Sự kiện UI -------------------- */
function bindUI() {
  $("#btnConnect")?.addEventListener("click", connectWallet);
  $("#btnDisconnect")?.addEventListener("click", disconnectWallet);

  $("#btnRegister")?.addEventListener("click", doRegister);

  $("#btnCreate")?.addEventListener("click", openCreate);
  $("#btnOrdersBuy")?.addEventListener("click", openOrdersBuy);
  $("#btnOrdersSell")?.addEventListener("click", openOrdersSell);

  $("#btnSubmitCreate")?.addEventListener("click", submitCreate);
  $("#btnCancelCreate")?.addEventListener("click", ()=> hide($("#createForm")));

  $("#btnSearch")?.addEventListener("click", doSearch);
  $("#searchInput")?.addEventListener("keydown", (e)=>{ if(e.key==="Enter") doSearch(); });

  $("#buyQuantity")?.addEventListener("input", updateBuyTotal);
  $("#btnSubmitBuy")?.addEventListener("click", submitBuy);
  $("#btnCancelBuy")?.addEventListener("click", ()=> hide($("#buyForm")));

  // Wallet events
  if (window.ethereum) {
    window.ethereum.on("accountsChanged", ()=> window.location.reload());
    window.ethereum.on("chainChanged", ()=> window.location.reload());
  }
}

/* -------------------- Khởi động -------------------- */
(async function start(){
  initProviders();
  bindUI();

  // Luôn hiển thị tỷ giá cho khách chưa connect
  await refreshRate();
  // Hiển thị sản phẩm (khách vẫn xem được)
  await loadAllProducts();
})();

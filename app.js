/* ========== muaban.vin — app.js ========== */
/* Phụ thuộc: ethers.js (5.x UMD) đã nhúng trong index.html */

/* -------------------- CẤU HÌNH -------------------- */
const CONFIG = {
  CHAIN_ID: 88, // Viction mainnet
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://vicscan.xyz",
  MUABAN_ADDR: window.MUABAN_ADDR,
  VIN_ADDR: window.VIN_ADDR,
};

/* -------------------- BIẾN TOÀN CỤC -------------------- */
let providerRead, providerWrite, signer, account;
let muaban, vin;
let isRegistered = false;
let vinRate = null; // VND per 1 VIN

/* -------------------- DOM helpers -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show=(el)=>el && el.classList.remove("hidden");
const hide=(el)=>el && el.classList.add("hidden");
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`:"";
const toast=(m)=>{
  const t=$("#toast");
  t.textContent=m;
  t.classList.add("show");
  show(t);
  setTimeout(()=>{ hide(t); t.classList.remove("show"); },3000);
};

/* -------------------- KẾT NỐI VÍ -------------------- */
async function connectWallet(){
  if(!window.ethereum){ toast("Vui lòng cài MetaMask"); return; }
  providerWrite = new ethers.providers.Web3Provider(window.ethereum);
  await providerWrite.send("eth_requestAccounts",[]);
  signer = providerWrite.getSigner();
  account = await signer.getAddress();

  // Khởi tạo provider đọc
  providerRead = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);

  // Nạp ABI
  const muabanABI = await fetch("Muaban_ABI.json").then(r=>r.json());
  const vinABI    = await fetch("VinToken_ABI.json").then(r=>r.json());

  muaban = new ethers.Contract(CONFIG.MUABAN_ADDR, muabanABI, signer);
  vin    = new ethers.Contract(CONFIG.VIN_ADDR, vinABI, signer);

  $("#accountShort").textContent = short(account);
  hide($("#btnConnect"));
  show($("#walletInfo"));

  await refreshBalances();
  await checkRegistration();
}

/* -------------------- NGẮT KẾT NỐI -------------------- */
function disconnectWallet(){
  account=null; signer=null; providerWrite=null;
  hide($("#walletInfo"));
  show($("#btnConnect"));
  hide($("#menu"));
  hide($("#registerBox"));
}
$("#btnDisconnect").onclick=disconnectWallet;
$("#btnConnect").onclick=connectWallet;

/* -------------------- SỐ DƯ -------------------- */
async function refreshBalances(){
  if(!account) return;
  try{
    const vinBal = await vin.balanceOf(account);
    const vicBal = await providerWrite.getBalance(account);
    $("#vinBalance").textContent = Number(ethers.utils.formatUnits(vinBal,18)).toFixed(4);
    $("#vicBalance").textContent = Number(ethers.utils.formatEther(vicBal)).toFixed(4);
  }catch(e){ console.error("refreshBalances",e); }
}
/* -------------------- TỶ GIÁ VIN/VND -------------------- */
/*
  VIN/VND = (VIC/USDT từ Binance × 100) × (USDT/VND từ CoinGecko)
  -> Đây là số VND cho 1 VIN. Dùng để hiển thị & tính vinPerVND = ceil(1e18 / VND_per_VIN)
*/
async function fetchVinRateVND(){
  try{
    const vicRes = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT");
    const vicJson = await vicRes.json();
    const vicUsdt = Number(vicJson.price); // USDT cho 1 VIC

    const usdtRes = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd");
    const usdtJson = await usdtRes.json();
    const usdtVnd = Number(usdtJson.tether.vnd); // VND cho 1 USDT

    const vndPerVin = vicUsdt * 100 * usdtVnd; // VND cho 1 VIN
    vinRate = Math.max(1, Math.floor(vndPerVin)); // làm tròn xuống số nguyên >=1
    $("#vinRate").textContent = `1 VIN = ${formatVND(vinRate)} VND`;
    return vinRate;
  }catch(e){
    console.error("fetchVinRateVND", e);
    toast("Không lấy được tỷ giá VIN/VND");
    return null;
  }
}
function formatVND(n){
  // hiển thị 631.214 dạng có dấu chấm ngăn nghìn
  try{
    return Number(n).toLocaleString("vi-VN");
  }catch{return String(n);}
}

/* -------------------- ĐĂNG KÝ VÍ (0.001 VIN) -------------------- */
async function checkRegistration(){
  try{
    const reg = await muaban.registered(account);
    isRegistered = reg;
    if(reg){
      hide($("#registerBox"));
      show($("#menu"));
    }else{
      show($("#registerBox"));
      hide($("#menu"));
    }
  }catch(e){ console.error("checkRegistration", e); }
}

async function registerWallet(){
  try{
    // Lấy REG_FEE từ contract (wei VIN)
    const regFee = await muaban.REG_FEE();

    // approve hợp đồng Muaban để nó gọi transferFrom(...)
    const allow = await vin.allowance(account, CONFIG.MUABAN_ADDR);
    if(allow.lt(regFee)){
      const tx1 = await vin.approve(CONFIG.MUABAN_ADDR, regFee);
      toast("Đang approve 0.001 VIN...");
      await tx1.wait();
    }

    const tx2 = await muaban.payRegistration();
    toast("Đang đăng ký ví...");
    await tx2.wait();
    toast("Đăng ký thành công!");
    await checkRegistration();
    await refreshBalances();
  }catch(e){
    console.error("registerWallet", e);
    toast("Đăng ký ví thất bại (xem console).");
  }
}
$("#btnRegister").onclick = registerWallet;

/* -------------------- DANH SÁCH SẢN PHẨM -------------------- */
/*
  Hợp đồng không có total/iterator cho products, nên ta lấy từ Event ProductCreated
  => Query toàn bộ logs ProductCreated, sau đó gọi getProduct(pid) để lấy chi tiết (đảm bảo active)
*/
async function loadProducts(queryText=""){
  try{
    const muabanABI = await fetch("Muaban_ABI.json").then(r=>r.json());
    const iFace = new ethers.utils.Interface(muabanABI);
    const topicCreated = iFace.getEventTopic("ProductCreated(uint256,address,string,uint256)");
    // Lấy logs từ block 0 -> latest (có thể giới hạn phạm vi nếu cần)
    const logs = await providerRead.getLogs({
      address: CONFIG.MUABAN_ADDR,
      topics: [topicCreated],
      fromBlock: 0,
      toBlock: "latest"
    });

    // Duyệt logs mới nhất trước
    const items = [];
    for(let i=logs.length-1; i>=0; i--){
      const l = logs[i];
      const parsed = iFace.parseLog(l);
      const pid = parsed.args.productId.toString();
      const p = await muaban.getProduct(pid);
      if(!p.active) continue;

      // Lọc theo tên nếu có query
      if(queryText && !p.name.toLowerCase().includes(queryText.toLowerCase())) continue;

      items.push(p);
      // Giới hạn 50 sản phẩm mới nhất để nhẹ UI
      if(items.length>=50) break;
    }
    renderProductList(items);
  }catch(e){
    console.error("loadProducts", e);
    toast("Không tải được danh sách sản phẩm.");
  }
}

function renderProductList(products){
  const wrap = $("#productList");
  wrap.innerHTML = "";
  if(!products || products.length===0){
    wrap.innerHTML = `<p>Chưa có sản phẩm phù hợp.</p>`;
    return;
  }
  for(const p of products){
    wrap.appendChild(renderProductItem(p));
  }
}

function ipfsToHttp(cid){
  if(!cid) return "";
  if(cid.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${cid.slice(7)}`;
  if(cid.includes("ipfs/")) return cid; // đã là link gateway
  return cid; // fallback
}

function renderProductItem(p){
  const tpl = $("#productItemTpl").content.cloneNode(true);
  const img = tpl.querySelector("img.thumb");
  const ttl = tpl.querySelector(".title");
  const price = tpl.querySelector(".price");
  const st = tpl.querySelector(".status");
  const act = tpl.querySelector(".actions");

  img.src = ipfsToHttp(p.imageCID) || "logo.png";
  img.alt = p.name;
  ttl.textContent = p.name;

  price.textContent = `${formatVND(p.priceVND)} VND / (đv)`;
  st.textContent = p.active ? "Trạng thái: Còn hàng" : "Trạng thái: Hết hàng";

  // Nút hành động
  const btnBuy = document.createElement("button");
  btnBuy.className="btn primary";
  btnBuy.textContent="Mua";
  btnBuy.onclick=()=>openBuyForm(p.productId.toString(), p.priceVND.toString(), p.name);

  // Seller cập nhật: chỉ hiện nếu p.seller == account
  const btnUpdate = document.createElement("button");
  btnUpdate.className="btn";
  btnUpdate.textContent="Cập nhật";
  btnUpdate.onclick=()=>openUpdateFromProduct(p);

  // Nếu đã kết nối & đã đăng ký
  if(account && isRegistered){
    act.appendChild(btnBuy);
    if(p.seller.toLowerCase()===account.toLowerCase()){
      act.appendChild(btnUpdate);
    }
  }
  return tpl;
}

/* -------------------- TÌM KIẾM -------------------- */
$("#btnSearch").onclick = ()=>{
  const q = ($("#searchInput").value||"").trim();
  loadProducts(q);
};
/* -------------------- TIỆN ÍCH CHUỖI & BIG -------------------- */
const BN = ethers.BigNumber;
const ONE_E18 = BN.from("1000000000000000000");

/* ceil(ONE_E18 / vndPerVin) để ra số VIN-wei cho 1 VND */
function calcVinPerVND(vndPerVin){
  if(!vndPerVin || vndPerVin<=0) return null;
  const v = BN.from(String(vndPerVin));
  // vinPerVND = ceil(1e18 / vndPerVin)
  return ONE_E18.add(v).sub(1).div(v);
}

function encodeBuyerInfo(name, addr, phone, note){
  const obj = {name, addr, phone, note};
  // Với bản đầu: base64 (placeholder). Sau có thể thay bằng mã hoá khoá công khai seller.
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
}

/* -------------------- UI: MỞ/ĐÓNG FORM -------------------- */
function openCreateForm(){
  if(!account){ toast("Vui lòng kết nối ví"); return; }
  if(!isRegistered){ toast("Cần đăng ký ví trước"); show($("#registerBox")); return; }
  // Chế độ tạo mới
  $("#createForm").dataset.mode = "create";
  $("#createForm").dataset.pid  = "";
  $("#createName").value="";
  $("#createIPFS").value="";
  $("#createUnit").value="";
  $("#createPrice").value="";
  $("#createWallet").value=account||"";
  $("#createDays").value="";
  hide($("#buyForm"));
  show($("#createForm"));
  window.scrollTo({top:0, behavior:"smooth"});
}
function openUpdateFromProduct(p){
  if(!account){ toast("Vui lòng kết nối ví"); return; }
  if(p.seller.toLowerCase()!==account.toLowerCase()){ toast("Bạn không phải người bán của sản phẩm này"); return; }
  $("#createForm").dataset.mode = "update";
  $("#createForm").dataset.pid  = p.productId.toString();

  // parse unit từ descriptionCID nếu có dạng "unit:..."
  let unit = "";
  if(p.descriptionCID && p.descriptionCID.startsWith("unit:")){
    unit = p.descriptionCID.slice(5);
  }
  $("#createName").value   = p.name || "";
  $("#createIPFS").value   = p.imageCID || "";
  $("#createUnit").value   = unit;
  $("#createPrice").value  = p.priceVND?.toString() || "";
  $("#createWallet").value = p.payoutWallet || account || "";
  $("#createDays").value   = String(p.deliveryDaysMax || 1);

  hide($("#buyForm"));
  show($("#createForm"));
  window.scrollTo({top:0, behavior:"smooth"});
}
function closeCreateForm(){ hide($("#createForm")); }
$("#btnCreate").onclick = openCreateForm;
$("#btnCancelCreate").onclick = closeCreateForm;

/* -------------------- SUBMIT: TẠO HOẶC CẬP NHẬT SẢN PHẨM -------------------- */
async function submitCreateOrUpdate(){
  try{
    if(!account || !signer) { toast("Chưa kết nối ví"); return; }
    if(!isRegistered){ toast("Cần đăng ký ví trước"); return; }

    const mode = $("#createForm").dataset.mode || "create";
    const pid  = $("#createForm").dataset.pid || "";

    const name = ($("#createName").value||"").trim();
    const ipfs = ($("#createIPFS").value||"").trim();
    const unit = ($("#createUnit").value||"").trim();
    const priceVND = BN.from(String(Math.max(1, Number($("#createPrice").value||0))));
    const wallet = ($("#createWallet").value||"").trim();
    const days = Number($("#createDays").value||0);

    if (!name || !ipfs || !priceVND || !wallet || !days){
      toast("Vui lòng nhập đủ thông tin."); return;
    }
    const descriptionCID = unit ? `unit:${unit}` : "";
    const imageCID = ipfs;

    if(mode==="create"){
      // createProduct(name, descriptionCID, imageCID, priceVND, deliveryDaysMax, payoutWallet, active)
      const tx = await muaban.createProduct(
        name, descriptionCID, imageCID, priceVND, days, wallet, true,
        { gasLimit: 1_500_000 }
      );
      toast("Đang tạo sản phẩm...");
      await tx.wait();
      toast("Đăng sản phẩm thành công.");
    }else{
      // updateProduct(pid, priceVND, deliveryDaysMax, payoutWallet, active)
      const tx1 = await muaban.updateProduct(
        BN.from(pid), priceVND, days, wallet, true,
        { gasLimit: 1_000_000 }
      );
      toast("Đang cập nhật sản phẩm...");
      await tx1.wait();

      // Nếu cần cập nhật name/descriptionCID/imageCID => không có hàm riêng trong contract mẫu,
      // nên tạm thời giữ nguyên như thiết kế (name/imageCID set khi tạo). Có thể mở PR sau.
      toast("Cập nhật thành công.");
    }

    closeCreateForm();
    await loadProducts($("#searchInput").value||"");
  }catch(err){
    console.error("submitCreateOrUpdate error:", err);
    // Hay gặp: Internal JSON-RPC error khi tham số sai kiểu/thiếu approve/chain sai
    toast("Giao dịch thất bại. Kiểm tra lại dữ liệu & mạng VIC (chain 88).");
  }
}
$("#btnSubmitCreate").onclick = submitCreateOrUpdate;

/* -------------------- UI: MUA HÀNG -------------------- */
function openBuyForm(pid, priceVND, productName){
  if(!account){ toast("Vui lòng kết nối ví"); return; }
  if(!isRegistered){ toast("Cần đăng ký ví trước"); show($("#registerBox")); return; }
  $("#buyProductId").value = String(pid);
  $("#buyName").value=""; $("#buyAddress").value=""; $("#buyPhone").value=""; $("#buyNote").value="";
  $("#buyQuantity").value = "1";
  $("#buyTotalVIN").textContent = "0";
  show($("#buyForm"));
  hide($("#createForm"));
  window.scrollTo({top:0, behavior:"smooth"});
  // Cập nhật tổng VIN ngay khi mở
  updateBuyTotalVIN();
}
function closeBuyForm(){ hide($("#buyForm")); }
$("#btnCancelBuy").onclick = closeBuyForm;

$("#buyQuantity").addEventListener("input", updateBuyTotalVIN);

async function updateBuyTotalVIN(){
  try{
    const pid = $("#buyProductId").value;
    if(!pid) return;
    // Lấy product để có priceVND hiện tại
    const p = await muaban.getProduct(pid);
    const qty = Math.max(1, Number($("#buyQuantity").value||1));
    // vndPerVin -> vinPerVND
    if(!vinRate){ await fetchVinRateVND(); }
    if(!vinRate){ $("#buyTotalVIN").textContent = "0"; return; }

    const vinPerVND = calcVinPerVND(vinRate);
    // vinAmount = ceil(priceVND * qty * vinPerVND)
    const totalVND = BN.from(p.priceVND.toString()).mul(BN.from(String(qty)));
    const vinAmount = totalVND.mul(vinPerVND); // vì vinPerVND đã là VIN-wei cho 1 VND và contract cũng đang ceil
    $("#buyTotalVIN").textContent = Number(ethers.utils.formatUnits(vinAmount,18)).toFixed(6);
  }catch(e){
    console.error("updateBuyTotalVIN", e);
  }
}

/* -------------------- SUBMIT: MUA HÀNG -------------------- */
async function submitBuy(){
  try{
    if(!account || !signer) { toast("Chưa kết nối ví"); return; }
    if(!isRegistered){ toast("Cần đăng ký ví trước"); return; }

    const pid = $("#buyProductId").value;
    const qty = Math.max(1, Number($("#buyQuantity").value||1));

    // Tính vinPerVND theo công thức mô tả
    if(!vinRate){ await fetchVinRateVND(); }
    if(!vinRate){ toast("Không có tỷ giá VIN/VND"); return; }
    const vinPerVND = calcVinPerVND(vinRate); // BigNumber

    // Tính trước số VIN để approve (theo công thức trong contract)
    const p = await muaban.getProduct(pid);
    const totalVND = BN.from(p.priceVND.toString()).mul(BN.from(String(qty)));
    const vinAmount = totalVND.mul(vinPerVND); // đủ để escrow

    // 1) Approve đủ VIN cho hợp đồng Muaban
    const currentAllow = await vin.allowance(account, CONFIG.MUABAN_ADDR);
    if(currentAllow.lt(vinAmount)){
      const tx1 = await vin.approve(CONFIG.MUABAN_ADDR, vinAmount);
      toast("Đang approve VIN...");
      await tx1.wait();
    }

    // 2) buyerInfoCipher (mã hoá nhẹ)
    const infoCipher = encodeBuyerInfo(
      ($("#buyName").value||"").trim(),
      ($("#buyAddress").value||"").trim(),
      ($("#buyPhone").value||"").trim(),
      ($("#buyNote").value||"").trim()
    );

    // 3) placeOrder(productId, quantity, vinPerVND, buyerInfoCipher)
    const tx2 = await muaban.placeOrder(
      BN.from(pid), BN.from(String(qty)), vinPerVND, infoCipher,
      { gasLimit: 2_000_000 }
    );
    toast("Đang tạo đơn hàng...");
    await tx2.wait();
    toast("Đặt mua thành công. VIN đã ký gửi vào hợp đồng.");

    closeBuyForm();
    await refreshBalances();
    // Có thể reload danh sách / đơn hàng
  }catch(err){
    console.error("submitBuy", err);
    toast("Mua hàng thất bại. Kiểm tra số dư VIN, allow & mạng VIC.");
  }
}
$("#btnSubmitBuy").onclick = submitBuy;
/* -------------------- ĐƠN HÀNG: TẢI & HIỂN THỊ -------------------- */
function renderOrderCard(o, product) {
  const div = document.createElement("div");
  div.className = "order";

  const statusMap = ["NONE","PLACED","RELEASED","REFUNDED"];
  const deadline = new Date(Number(o.deadline)*1000);
  const qty = o.quantity.toString();
  const vin = Number(ethers.utils.formatUnits(o.vinAmount, 18)).toFixed(6);

  div.innerHTML = `
    <div><b>Đơn #${o.orderId}</b> • Sản phẩm #${o.productId}${product?.name?(" – "+product.name):""}</div>
    <div>Trạng thái: <b>${statusMap[o.status]}</b></div>
    <div>Số lượng: ${qty} • Ký gửi: <b>${vin} VIN</b></div>
    <div>Đặt lúc: ${new Date(Number(o.placedAt)*1000).toLocaleString("vi-VN")}</div>
    <div>Hạn giao: ${deadline.toLocaleString("vi-VN")}</div>
    <div class="actions"></div>
  `;

  const actions = div.querySelector(".actions");
  // Nếu còn ở trạng thái PLACED
  if (o.status === 1) {
    // Nếu là buyer -> xác nhận đã nhận / hoàn tiền sau hạn
    if (account && o.buyer.toLowerCase() === account.toLowerCase()) {
      const btnConfirm = document.createElement("button");
      btnConfirm.className = "btn primary";
      btnConfirm.textContent = "Xác nhận đã nhận";
      btnConfirm.onclick = ()=>confirmReceipt(o.orderId);

      const btnRefund = document.createElement("button");
      btnRefund.className = "btn";
      btnRefund.textContent = "Hoàn tiền (nếu quá hạn)";
      btnRefund.onclick = ()=>refundIfExpired(o.orderId);

      actions.appendChild(btnConfirm);
      actions.appendChild(btnRefund);
    }
    // Seller không có hành động on-chain ở contract hiện tại, chỉ theo dõi hạn
  }
  return div;
}

async function fetchOrder(orderId) {
  try {
    const o = await muaban.getOrder(orderId);
    return o;
  } catch (e) {
    console.error("fetchOrder", e);
    return null;
  }
}

/* Buyer: lấy từ event OrderPlaced (buyer là topic[3]) */
async function loadBuyerOrders() {
  if (!account) return;
  try {
    const muabanABI = await fetch("Muaban_ABI.json").then(r=>r.json());
    const iFace = new ethers.utils.Interface(muabanABI);
    const topicPlaced = iFace.getEventTopic("OrderPlaced(uint256,uint256,address,uint256,uint256)");

    const logs = await providerRead.getLogs({
      address: CONFIG.MUABAN_ADDR,
      topics: [topicPlaced, null, null, ethers.utils.hexZeroPad(account, 32)],
      fromBlock: 0,
      toBlock: "latest"
    });

    const list = $("#ordersBuyList");
    list.innerHTML = "";
    if (logs.length === 0) {
      list.innerHTML = "<p>Chưa có đơn hàng.</p>";
      return;
    }

    // Mới nhất trước
    for (let i = logs.length - 1; i >= 0; i--) {
      const parsed = iFace.parseLog(logs[i]);
      const orderId = parsed.args.orderId.toString();
      const productId = parsed.args.productId.toString();
      const o = await fetchOrder(orderId);
      const p = await muaban.getProduct(productId);
      list.appendChild(renderOrderCard(o, p));
    }
  } catch (e) {
    console.error("loadBuyerOrders", e);
    toast("Không tải được đơn hàng mua.");
  }
}

/* Seller: duyệt sản phẩm của mình => query OrderPlaced theo productId (topic[1]) */
async function loadSellerOrders() {
  if (!account) return;
  try {
    const productIds = await muaban.getSellerProductIds(account);
    const muabanABI = await fetch("Muaban_ABI.json").then(r=>r.json());
    const iFace = new ethers.utils.Interface(muabanABI);
    const topicPlaced = iFace.getEventTopic("OrderPlaced(uint256,uint256,address,uint256,uint256)");

    const list = $("#ordersSellList");
    list.innerHTML = "";
    if (!productIds || productIds.length === 0) {
      list.innerHTML = "<p>Bạn chưa đăng sản phẩm nào.</p>";
      return;
    }

    // Gom logs cho từng sản phẩm
    for (let k = productIds.length - 1; k >= 0; k--) {
      const pid = productIds[k].toString();
      const pidTopic = ethers.utils.hexZeroPad(ethers.BigNumber.from(pid).toHexString(), 32);

      const logs = await providerRead.getLogs({
        address: CONFIG.MUABAN_ADDR,
        topics: [topicPlaced, null, pidTopic],
        fromBlock: 0,
        toBlock: "latest"
      });

      // Mới nhất trước
      for (let i = logs.length - 1; i >= 0; i--) {
        const parsed = iFace.parseLog(logs[i]);
        const orderId = parsed.args.orderId.toString();
        const productId = parsed.args.productId.toString();
        const o = await fetchOrder(orderId);
        const p = await muaban.getProduct(productId);
        list.appendChild(renderOrderCard(o, p));
      }
    }

    if (!list.innerHTML) list.innerHTML = "<p>Chưa có đơn hàng mới.</p>";
  } catch (e) {
    console.error("loadSellerOrders", e);
    toast("Không tải được đơn hàng bán.");
  }
}

/* -------------------- HÀNH ĐỘNG: XÁC NHẬN & HOÀN TIỀN -------------------- */
async function confirmReceipt(orderId) {
  try {
    const tx = await muaban.confirmReceipt(ethers.BigNumber.from(String(orderId)), { gasLimit: 800_000 });
    toast("Đang xác nhận đã nhận hàng...");
    await tx.wait();
    toast("Đã giải ngân cho người bán.");
    await loadBuyerOrders();
    await refreshBalances();
  } catch (e) {
    console.error("confirmReceipt", e);
    toast("Xác nhận thất bại (chỉ buyer của đơn & trạng thái PLACED).");
  }
}

async function refundIfExpired(orderId) {
  try {
    const tx = await muaban.refundIfExpired(ethers.BigNumber.from(String(orderId)), { gasLimit: 800_000 });
    toast("Đang yêu cầu hoàn tiền...");
    await tx.wait();
    toast("Đã hoàn VIN về ví nếu đơn quá hạn.");
    await loadBuyerOrders();
    await refreshBalances();
  } catch (e) {
    console.error("refundIfExpired", e);
    toast("Hoàn tiền thất bại (chưa quá hạn hoặc không phải buyer).");
  }
}

/* -------------------- MENU & HIỂN THỊ -------------------- */
$("#btnOrdersBuy").onclick = async ()=>{
  show($("#ordersBuy"));
  hide($("#ordersSell"));
  hide($("#createForm"));
  hide($("#buyForm"));
  await loadBuyerOrders();
  window.scrollTo({top:0, behavior:"smooth"});
};

$("#btnOrdersSell").onclick = async ()=>{
  show($("#ordersSell"));
  hide($("#ordersBuy"));
  hide($("#createForm"));
  hide($("#buyForm"));
  await loadSellerOrders();
  window.scrollTo({top:0, behavior:"smooth"});
};

/* -------------------- KIỂM TRA & CHUYỂN MẠNG VIC -------------------- */
async function ensureVictionNetwork() {
  if (!window.ethereum) return;
  try {
    const net = await providerWrite.getNetwork();
    if (net.chainId !== CONFIG.CHAIN_ID) {
      // Thử switch
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x58" }], // 88
      });
    }
  } catch (e) {
    // Nếu chưa có mạng thì add
    try {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0x58",
          chainName: "Viction Mainnet",
          rpcUrls: [CONFIG.RPC_URL],
          nativeCurrency: { name: "VIC", symbol: "VIC", decimals: 18 },
          blockExplorerUrls: [CONFIG.EXPLORER],
        }]
      });
    } catch (ee) {
      console.warn("ensureVictionNetwork add/switch failed", ee);
    }
  }
}

/* -------------------- SỰ KIỆN ví/metamask -------------------- */
if (window.ethereum) {
  window.ethereum.on("accountsChanged", async (accs)=>{
    if (!accs || accs.length===0) { disconnectWallet(); return; }
    await connectWallet();
  });
  window.ethereum.on("chainChanged", async (_chainId)=>{
    // _chainId là hex
    await connectWallet();
    await ensureVictionNetwork();
  });
}

/* -------------------- KHỞI ĐỘNG -------------------- */
async function init() {
  try {
    // Provider đọc để load sản phẩm ngay cả khi chưa kết nối ví
    providerRead = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);

    // Tỷ giá & danh sách sản phẩm
    await fetchVinRateVND();
    await loadProducts("");

    // Sự kiện UI nhỏ
    setInterval(fetchVinRateVND, 5*60*1000); // cập nhật tỷ giá mỗi 5 phút
  } catch (e) {
    console.error("init", e);
  }
}
document.addEventListener("DOMContentLoaded", init);

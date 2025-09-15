/* ====================================================================
   muaban.vin — app.js (ethers v5) — FIX “Internal JSON-RPC error”
   - Load ABI từ Muaban_ABI.json & VinToken_ABI.json
   - Lấy địa chỉ contract từ <body data-muaban-addr ... data-vin-addr ...>
   - Preflight: provider.call(txData) để bắt revert reason trước khi gửi tx
==================================================================== */

/* -------------------- Helpers DOM -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show = el=>el&&el.classList.remove('hidden');
const hide = el=>el&&el.classList.add('hidden');
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`:"";
const toast=(m)=>alert(m);

/* -------------------- Cấu hình -------------------- */
const DEFAULTS = {
  CHAIN_ID: 88,
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://scan.viction.xyz",
  // Fallback: nếu index.html chưa gắn data-*, dùng mặc định này
  MUABAN_ADDR: "0xe01e2213A899E9B3b1921673D2d13a227a8df638",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",
  REG_FEE_WEI: "1000000000000000", // 0.001 VIN
  BINANCE_VICUSDT: "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT"
};

/* -------------------- State -------------------- */
let providerRead, providerWrite, signer, account;
let MUABAN_ABI, VIN_ABI;
let muaban, vin;
let isRegistered = false;
let vinPerVNDWei = ethers.BigNumber.from(0);
let vinVND = 0;

/* -------------------- Parse revert -------------------- */
function parseRevert(err){
  const raw = err?.error?.message || err?.data?.message || err?.reason || err?.message || "";
  const m = /execution reverted(?::| with reason string)?\s*("?)([^"\n]+)\1/i.exec(raw);
  if (m) return m[2];
  try{
    // Một số node trả về data dạng { originalError: { data: '0x..' } }
    const data = err?.error?.data || err?.data;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10){
      const iface = new ethers.utils.Interface(["function Error(string)"]);
      const reason = iface.parseError(data)?.args?.[0];
      if (reason) return String(reason);
    }
  }catch(_) {}
  return raw || "Giao dịch bị từ chối/không hợp lệ.";
}

/* -------------------- Load ABI + init -------------------- */
async function loadAbis(){
  const [ma, va] = await Promise.all([
    fetch("Muaban_ABI.json").then(r=>r.json()),
    fetch("VinToken_ABI.json").then(r=>r.json())
  ]);
  MUABAN_ABI = ma;
  VIN_ABI = va;
}

function readAddrs(){
  const b = document.body;
  const a1 = b?.dataset?.muabanAddr;
  const a2 = b?.dataset?.vinAddr;
  return {
    MUABAN_ADDR: (a1 && ethers.utils.isAddress(a1) ? a1 : DEFAULTS.MUABAN_ADDR),
    VIN_ADDR:    (a2 && ethers.utils.isAddress(a2) ? a2 : DEFAULTS.VIN_ADDR)
  };
}

function initProviders(){
  providerRead  = new ethers.providers.JsonRpcProvider(DEFAULTS.RPC_URL);
  if (window.ethereum) providerWrite = new ethers.providers.Web3Provider(window.ethereum, "any");
}

/* -------------------- Giá VIN/VND -------------------- */
async function fetchVinToVND(){
  try{
    const vic = await fetch(DEFAULTS.BINANCE_VICUSDT).then(r=>r.json());
    const vicUsdt = Number(vic?.price||0);
    if (!vicUsdt) throw new Error("No VIC/USDT");
    // 1 VIN = 100 VIC
    const vinUsdt = vicUsdt * 100;
    // tạm thời lấy 1 USDT = 24,000 VND (hoặc bạn có thể fetch từ 1 API khác)
    const USDT_VND = 24000;
    vinVND = Math.floor(vinUsdt * USDT_VND);
    const ONE = ethers.BigNumber.from("1000000000000000000");
    vinPerVNDWei = ONE.div(vinVND);
    if (ONE.mod(vinVND).gt(0)) vinPerVNDWei = vinPerVNDWei.add(1);
    const el = $("#vinPrice");
    if (el) el.textContent = `1 VIN = ${vinVND.toLocaleString("vi-VN")} VND`;
  }catch(e){
    console.error("fetchVinToVND", e);
    const el = $("#vinPrice");
    if (el) el.textContent = "Đang tải giá…";
  }
}

/* -------------------- Kết nối ví -------------------- */
async function connectWallet(){
  if (!window.ethereum){ toast("Vui lòng cài MetaMask."); return; }
  await providerWrite.send("eth_requestAccounts", []);
  const net = await providerWrite.getNetwork();
  if (Number(net.chainId)!==DEFAULTS.CHAIN_ID){
    toast("Sai mạng. Chọn Viction (chainId=88)."); return;
  }
  signer  = providerWrite.getSigner();
  account = (await signer.getAddress()).toLowerCase();
  $("#btnConnect")?.classList.add("hidden");
  $("#walletBox")?.classList.remove("hidden");
  $("#accountShort").textContent = short(account);
  $("#accountShort").href = `${DEFAULTS.EXPLORER}/address/${account}`;

  const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
  muaban = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);
  vin    = new ethers.Contract(VIN_ADDR, VIN_ABI, signer);

  // trạng thái đã đăng ký?
  try{
    isRegistered = await muaban.registered(account);
  }catch(e){
    // nếu vào đây rất có thể ĐỊA CHỈ CONTRACT SAI → hiển thị cảnh báo rõ ràng
    console.error(e);
    toast("Không đọc được trạng thái đăng ký. Vui lòng kiểm tra địa chỉ Muaban contract trong index.html (data-muaban-addr).");
    return;
  }

  // số dư
  const [vinBal, vicBal] = await Promise.all([vin.balanceOf(account), providerWrite.getBalance(account)]);
  $("#vinBalance").textContent = `VIN: ${parseFloat(ethers.utils.formatUnits(vinBal,18)).toFixed(4)}`;
  $("#vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;

  // menu
  if (isRegistered){
    $("#btnRegister")?.classList.add("hidden");
    $("#btnCreate")?.classList.remove("hidden");
    $("#btnOrdersBuy")?.classList.remove("hidden");
    $("#btnOrdersSell")?.classList.remove("hidden");
  }else{
    $("#btnRegister")?.classList.remove("hidden");
  }
}

$("#btnConnect")?.addEventListener("click", connectWallet);

/* -------------------- Đăng ký -------------------- */
$("#btnRegister")?.addEventListener("click", async ()=>{
  if (!account){ toast("Hãy kết nối ví."); return; }
  try{
    const need = ethers.BigNumber.from(DEFAULTS.REG_FEE_WEI);
    const allow = await vin.allowance(account, muaban.address);
    if (allow.lt(need)){
      const txA = await vin.approve(muaban.address, need);
      await txA.wait();
    }
    // preflight
    try{
      await muaban.callStatic.payRegistration({ from: account });
    }catch(simErr){
      toast(parseRevert(simErr)); return;
    }
    const tx = await muaban.payRegistration();
    await tx.wait();
    isRegistered = true;
    toast("Đăng ký thành công.");
    $("#btnRegister")?.classList.add("hidden");
    $("#btnCreate")?.classList.remove("hidden");
    $("#btnOrdersBuy")?.classList.remove("hidden");
    $("#btnOrdersSell")?.classList.remove("hidden");
  }catch(e){ console.error(e); toast(parseRevert(e)); }
});

/* -------------------- ĐĂNG SẢN PHẨM -------------------- */
$("#btnCreate")?.addEventListener("click", ()=>{
  if (!isRegistered){ toast("Ví chưa đăng ký. Bấm ‘Đăng ký’ trước."); return; }
  $("#createName").value=""; $("#createIPFS").value="";
  $("#createUnit").value=""; $("#createPrice").value="";
  $("#createWallet").value=account||""; $("#createDays").value="3";
  show($("#formCreate"));
});
$(".modal#formCreate .close")?.addEventListener("click", ()=>hide($("#formCreate")));
$("#btnSubmitCreate")?.addEventListener("click", submitCreate);

async function submitCreate(){
  try{
    // --- user input ---
    const name  = ($("#createName").value||"").trim();
    const ipfs  = ($("#createIPFS").value||"").trim();
    const unit  = ($("#createUnit").value||"").trim();
    const price = Math.floor(Number($("#createPrice").value||0));
    const wallet= ($("#createWallet").value||"").trim();
    const days  = parseInt($("#createDays").value||"0", 10);

    if (!name||!ipfs||!unit||!wallet){ toast("Điền đủ thông tin."); return; }
    if (!ethers.utils.isAddress(wallet)){ toast("Ví nhận thanh toán không hợp lệ."); return; }
    if (!(Number.isFinite(price)&&price>0)){ toast("Giá (VND) phải > 0."); return; }
    if (!(Number.isInteger(days)&&days>0)){ toast("Số ngày giao ≥ 1."); return; }
    if (!isRegistered){ toast("Ví chưa đăng ký."); return; }

    const descriptionCID = `unit:${unit}`;
    const imageCID = ipfs;
    const priceVND = ethers.BigNumber.from(String(price));

    // --- PRE-FLIGHT: dùng provider.call để bắt revert reason rõ nhất ---
    const txData = await muaban.populateTransaction.createProduct(
      name, descriptionCID, imageCID, priceVND, days, wallet, true
    );
    txData.from = account;  // quan trọng để qua modifier onlyRegistered
    try{
      await providerWrite.call(txData); // static call ở client
    }catch(simErr){
      toast(parseRevert(simErr)); return;
    }

    // --- SEND TX ---
    const tx = await muaban.createProduct(name, descriptionCID, imageCID, priceVND, days, wallet, true);
    await tx.wait();
    hide($("#formCreate"));
    toast("Đăng sản phẩm thành công.");
    // có thể gọi loadAllProducts() ở đây nếu bạn đã có hàm
  }catch(e){ console.error(e); toast(parseRevert(e)); }
}

/* -------------------- MAIN -------------------- */
(async function main(){
  try{
    await loadAbis();
    initProviders();
    await fetchVinToVND();
    setInterval(fetchVinToVND, 60_000);
  }catch(e){
    console.error("init error", e);
    toast("Không tải được ABI. Hãy đảm bảo Muaban_ABI.json & VinToken_ABI.json nằm cùng thư mục.");
  }
})();

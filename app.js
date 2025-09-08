/* ==========================================================================
   muaban — app.js (Part 1/4)
   - Khởi tạo Ethers, nhúng ABI (Muaban + ERC20 VIN)
   - Kết nối ví (MetaMask / EVM wallet), kiểm tra chain Viction (88)
   - Kiểm tra đăng ký nền tảng (0.001 VIN) & bật/ẩn nút đăng ký
   - Hiển thị địa chỉ ví rút gọn, tên mạng, số dư VIN (ERC20) & VIC (native)
   - Gắn event cho 3 nút: Kiểm tra / Approve / Trả phí đăng ký
   ========================================================================== */

/** ====== 0) Helpers DOM ====== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ui = {
  btnConnect: $('#btnConnect'),
  walletInfo: $('#walletInfo'),
  accountShort: $('#accountShort'),
  networkName: $('#networkName'),

  // Đăng ký nền tảng
  regStatus: $('#regStatus'),
  btnCheckReg: $('#btnCheckReg'),
  btnApproveReg: $('#btnApproveReg'),
  btnPayReg: $('#btnPayReg'),
};

/** ====== 1) Config từ index.html ====== */
const CFG = (window.MUABAN_CONFIG || {});
const MUABAN_ADDRESS = CFG.MUABAN_ADDRESS;
const VIN_TOKEN_ADDRESS = CFG.VIN_TOKEN;
const VIC_CHAIN_ID_DEC = CFG.VIC_CHAIN_ID_DEC || 88;
const VIC_CHAIN_ID_HEX = CFG.VIC_CHAIN_ID_HEX || '0x58';
const VIC_NAME        = CFG.VIC_NAME || 'Viction Mainnet';
const VIC_SYMBOL      = CFG.VIC_SYMBOL || 'VIC';
const VIC_DECIMALS    = CFG.VIC_DECIMALS || 18;

/** ====== 2) ABI (Muaban + ERC20 VIN) ======
 *  Chọn đủ hàm/sự kiện theo hợp đồng Muaban.sol + ABI JSON.
 *  (Các phần đặt hàng/sản phẩm dùng ở Part 2/3.)
 *  Nguồn: Muaban.sol & Muaban_ABI.json
 */
const MUABAN_ABI = [
  // ---- Events ----
  { "anonymous": false, "inputs":[
      {"indexed":true,"internalType":"address","name":"previousOwner","type":"address"},
      {"indexed":true,"internalType":"address","name":"newOwner","type":"address"}],
    "name":"OwnershipTransferred","type":"event" },

  { "anonymous": false, "inputs":[
      {"indexed":true,"internalType":"address","name":"wallet","type":"address"},
      {"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"}],
    "name":"RegistrationPaid","type":"event" },

  { "anonymous": false, "inputs":[
      {"indexed":true,"internalType":"uint256","name":"productId","type":"uint256"},
      {"indexed":true,"internalType":"address","name":"seller","type":"address"},
      {"indexed":false,"internalType":"string","name":"name","type":"string"},
      {"indexed":false,"internalType":"string","name":"descriptionCID","type":"string"},
      {"indexed":false,"internalType":"string","name":"imageCID","type":"string"},
      {"indexed":false,"internalType":"uint256","name":"priceUsdCents","type":"uint256"},
      {"indexed":false,"internalType":"uint256","name":"shippingUsdCents","type":"uint256"},
      {"indexed":false,"internalType":"uint16","name":"taxRateBps","type":"uint16"},
      {"indexed":false,"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},
      {"indexed":false,"internalType":"address","name":"revenueWallet","type":"address"},
      {"indexed":false,"internalType":"address","name":"taxWallet","type":"address"},
      {"indexed":false,"internalType":"address","name":"shippingWallet","type":"address"},
      {"indexed":false,"internalType":"bytes","name":"sellerEncryptPubKey","type":"bytes"},
      {"indexed":false,"internalType":"uint256","name":"stock","type":"uint256"}],
    "name":"ProductCreated","type":"event" },

  { "anonymous": false, "inputs":[
      {"indexed":true,"internalType":"uint256","name":"productId","type":"uint256"},
      {"indexed":false,"internalType":"uint256","name":"priceUsdCents","type":"uint256"},
      {"indexed":false,"internalType":"uint256","name":"shippingUsdCents","type":"uint256"},
      {"indexed":false,"internalType":"uint16","name":"taxRateBps","type":"uint16"},
      {"indexed":false,"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},
      {"indexed":false,"internalType":"address","name":"revenueWallet","type":"address"},
      {"indexed":false,"internalType":"address","name":"taxWallet","type":"address"},
      {"indexed":false,"internalType":"address","name":"shippingWallet","type":"address"},
      {"indexed":false,"internalType":"uint256","name":"stock","type":"uint256"},
      {"indexed":false,"internalType":"bytes","name":"sellerEncryptPubKey","type":"bytes"}],
    "name":"ProductUpdated","type":"event" },

  { "anonymous": false, "inputs":[
      {"indexed":true,"internalType":"uint256","name":"productId","type":"uint256"},
      {"indexed":false,"internalType":"bool","name":"active","type":"bool"}],
    "name":"ProductStatusChanged","type":"event" },

  { "anonymous": false, "inputs":[
      {"indexed":true,"internalType":"uint256","name":"orderId","type":"uint256"},
      {"indexed":true,"internalType":"uint256","name":"productId","type":"uint256"},
      {"indexed":true,"internalType":"address","name":"buyer","type":"address"},
      {"indexed":false,"internalType":"address","name":"seller","type":"address"},
      {"indexed":false,"internalType":"uint256","name":"quantity","type":"uint256"},
      {"indexed":false,"internalType":"uint256","name":"vinAmountTotal","type":"uint256"},
      {"indexed":false,"internalType":"uint256","name":"placedAt","type":"uint256"},
      {"indexed":false,"internalType":"uint256","name":"deadline","type":"uint256"},
      {"indexed":false,"internalType":"bytes","name":"shippingInfoCiphertext","type":"bytes"}],
    "name":"OrderPlaced","type":"event" },

  { "anonymous": false, "inputs":[
      {"indexed":true,"internalType":"uint256","name":"orderId","type":"uint256"},
      {"indexed":true,"internalType":"uint256","name":"productId","type":"uint256"},
      {"indexed":true,"internalType":"address","name":"buyer","type":"address"},
      {"indexed":false,"internalType":"address","name":"seller","type":"address"},
      {"indexed":false,"internalType":"uint256","name":"vinAmountTotal","type":"uint256"}],
    "name":"OrderReleased","type":"event" },

  { "anonymous": false, "inputs":[
      {"indexed":true,"internalType":"uint256","name":"orderId","type":"uint256"},
      {"indexed":true,"internalType":"uint256","name":"productId","type":"uint256"},
      {"indexed":true,"internalType":"address","name":"buyer","type":"address"},
      {"indexed":false,"internalType":"address","name":"seller","type":"address"},
      {"indexed":false,"internalType":"uint256","name":"vinAmountTotal","type":"uint256"}],
    "name":"OrderRefunded","type":"event" },

  { "anonymous": false, "inputs":[
      {"indexed":true,"internalType":"uint256","name":"orderId","type":"uint256"},
      {"indexed":true,"internalType":"address","name":"seller","type":"address"},
      {"indexed":false,"internalType":"uint8","name":"rating","type":"uint8"},
      {"indexed":false,"internalType":"bool","name":"scamFlag","type":"bool"}],
    "name":"Reviewed","type":"event" },

  // ---- Views / constants ----
  { "inputs":[], "name":"owner", "outputs":[{"internalType":"address","name":"","type":"address"}], "stateMutability":"view","type":"function" },
  { "inputs":[], "name":"PLATFORM_FEE", "outputs":[{"internalType":"uint256","name":"","type":"uint256"}], "stateMutability":"view","type":"function" },
  { "inputs":[{"internalType":"address","name":"","type":"address"}], "name":"isRegistered", "outputs":[{"internalType":"bool","name":"","type":"bool"}], "stateMutability":"view","type":"function" },
  { "inputs":[], "name":"vin", "outputs":[{"internalType":"address","name":"","type":"address"}], "stateMutability":"view","type":"function" },
  { "inputs":[], "name":"vinDecimals", "outputs":[{"internalType":"uint8","name":"","type":"uint8"}], "stateMutability":"view","type":"function" },

  // ---- Minimal reads for later features (kept here for full ABI pack) ----
  { "inputs":[{"internalType":"uint256","name":"productId","type":"uint256"}],
    "name":"getProduct",
    "outputs":[{"components":[
      {"internalType":"uint256","name":"productId","type":"uint256"},
      {"internalType":"address","name":"seller","type":"address"},
      {"internalType":"string","name":"name","type":"string"},
      {"internalType":"string","name":"descriptionCID","type":"string"},
      {"internalType":"string","name":"imageCID","type":"string"},
      {"internalType":"uint256","name":"priceUsdCents","type":"uint256"},
      {"internalType":"uint256","name":"shippingUsdCents","type":"uint256"},
      {"internalType":"uint16","name":"taxRateBps","type":"uint16"},
      {"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},
      {"internalType":"address","name":"revenueWallet","type":"address"},
      {"internalType":"address","name":"taxWallet","type":"address"},
      {"internalType":"address","name":"shippingWallet","type":"address"},
      {"internalType":"bytes","name":"sellerEncryptPubKey","type":"bytes"},
      {"internalType":"bool","name":"active","type":"bool"},
      {"internalType":"uint64","name":"createdAt","type":"uint64"},
      {"internalType":"uint64","name":"updatedAt","type":"uint64"},
      {"internalType":"uint256","name":"stock","type":"uint256"}
    ],"internalType":"struct Muaban.Product","name":"","type":"tuple"}],
    "stateMutability":"view","type":"function" },

  { "inputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],
    "name":"getOrder",
    "outputs":[{"components":[
      {"internalType":"uint256","name":"orderId","type":"uint256"},
      {"internalType":"uint256","name":"productId","type":"uint256"},
      {"internalType":"address","name":"buyer","type":"address"},
      {"internalType":"address","name":"seller","type":"address"},
      {"internalType":"uint256","name":"quantity","type":"uint256"},
      {"internalType":"uint256","name":"vinAmountTotal","type":"uint256"},
      {"internalType":"uint256","name":"placedAt","type":"uint256"},
      {"internalType":"uint256","name":"deadline","type":"uint256"},
      {"internalType":"bytes","name":"shippingInfoCiphertext","type":"bytes"},
      {"internalType":"uint8","name":"status","type":"uint8"},
      {"internalType":"bool","name":"reviewed","type":"bool"}
    ],"internalType":"struct Muaban.Order","name":"","type":"tuple"}],
    "stateMutability":"view","type":"function" },

  { "inputs":[{"internalType":"address","name":"sellerAddr","type":"address"}],
    "name":"getSellerProductIds",
    "outputs":[{"internalType":"uint256[]","name":"","type":"uint256[]"}],
    "stateMutability":"view","type":"function" },

  { "inputs":[{"internalType":"address","name":"sellerAddr","type":"address"}],
    "name":"getSellerStats",
    "outputs":[{"components":[
      {"internalType":"uint256","name":"expiredRefundCount","type":"uint256"},
      {"internalType":"uint256","name":"scamCount","type":"uint256"},
      {"internalType":"uint256","name":"ratingSum","type":"uint256"},
      {"internalType":"uint256","name":"ratingCount","type":"uint256"}
    ],"internalType":"struct Muaban.SellerStats","name":"","type":"tuple"}],
    "stateMutability":"view","type":"function" },

  { "inputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],
    "name":"isOrderActive", "outputs":[{"internalType":"bool","name":"","type":"bool"}],
    "stateMutability":"view","type":"function" },

  // ---- Writes used now/later ----
  { "inputs":[], "name":"payRegistration", "outputs":[], "stateMutability":"nonpayable","type":"function" },
  { "inputs":[
      {"internalType":"string","name":"name_","type":"string"},
      {"internalType":"string","name":"descriptionCID_","type":"string"},
      {"internalType":"string","name":"imageCID_","type":"string"},
      {"internalType":"uint256","name":"priceUsdCents_","type":"uint256"},
      {"internalType":"uint256","name":"shippingUsdCents_","type":"uint256"},
      {"internalType":"uint16","name":"taxRateBps_","type":"uint16"},
      {"internalType":"uint32","name":"deliveryDaysMax_","type":"uint32"},
      {"internalType":"address","name":"revenueWallet_","type":"address"},
      {"internalType":"address","name":"taxWallet_","type":"address"},
      {"internalType":"address","name":"shippingWallet_","type":"address"},
      {"internalType":"bytes","name":"sellerEncryptPubKey_","type":"bytes"},
      {"internalType":"uint256","name":"stock_","type":"uint256"},
      {"internalType":"bool","name":"active_","type":"bool"}
    ],
    "name":"createProduct", "outputs":[{"internalType":"uint256","name":"productId","type":"uint256"}],
    "stateMutability":"nonpayable","type":"function" },

  { "inputs":[
      {"internalType":"uint256","name":"productId","type":"uint256"},
      {"internalType":"uint256","name":"priceUsdCents_","type":"uint256"},
      {"internalType":"uint256","name":"shippingUsdCents_","type":"uint256"},
      {"internalType":"uint16","name":"taxRateBps_","type":"uint16"},
      {"internalType":"uint32","name":"deliveryDaysMax_","type":"uint32"},
      {"internalType":"address","name":"revenueWallet_","type":"address"},
      {"internalType":"address","name":"taxWallet_","type":"address"},
      {"internalType":"address","name":"shippingWallet_","type":"address"},
      {"internalType":"uint256","name":"stock_","type":"uint256"},
      {"internalType":"bytes","name":"sellerEncryptPubKey_","type":"bytes"}],
    "name":"updateProduct", "outputs":[], "stateMutability":"nonpayable","type":"function" },

  { "inputs":[{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"bool","name":"active_","type":"bool"}],
    "name":"setProductActive","outputs":[], "stateMutability":"nonpayable","type":"function" },

  { "inputs":[
      {"internalType":"uint256","name":"productId","type":"uint256"},
      {"internalType":"uint256","name":"quantity","type":"uint256"},
      {"internalType":"uint256","name":"vinPerUSD","type":"uint256"},
      {"internalType":"bytes","name":"shippingInfoCiphertext_","type":"bytes"}],
    "name":"placeOrder","outputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],
    "stateMutability":"nonpayable","type":"function" },

  { "inputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],
    "name":"confirmReceipt","outputs":[], "stateMutability":"nonpayable","type":"function" },

  { "inputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],
    "name":"refundIfExpired","outputs":[], "stateMutability":"nonpayable","type":"function" }
];

const ERC20_ABI = [
  // events
  { "anonymous": false, "inputs":[
      {"indexed":true,"internalType":"address","name":"owner","type":"address"},
      {"indexed":true,"internalType":"address","name":"spender","type":"address"},
      {"indexed":false,"internalType":"uint256","name":"value","type":"uint256"}],
    "name":"Approval","type":"event" },
  { "anonymous": false, "inputs":[
      {"indexed":true,"internalType":"address","name":"from","type":"address"},
      {"indexed":true,"internalType":"address","name":"to","type":"address"},
      {"indexed":false,"internalType":"uint256","name":"value","type":"uint256"}],
    "name":"Transfer","type":"event" },
  // views
  { "inputs":[],"name":"name","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function" },
  { "inputs":[],"name":"symbol","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function" },
  { "inputs":[],"name":"decimals","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function" },
  { "inputs":[],"name":"totalSupply","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function" },
  { "inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function" },
  { "inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"}],
    "name":"allowance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function" },
  // writes
  { "inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],
    "name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function" },
  { "inputs":[{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],
    "name":"transfer","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function" },
  { "inputs":[{"internalType":"address","name":"from","type":"address"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],
    "name":"transferFrom","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function" }
];

/** ====== 3) Ethers & App state ====== */
const { ethers } = window.ethers || {};
const app = {
  provider: null,
  signer: null,
  account: null,
  chainIdHex: null,

  muaban: null,
  vin: null,

  vinDecimals: 18
};

function shortAddr(a){
  if (!a) return '—';
  return a.slice(0,6) + '…' + a.slice(-4);
}

function fmtUnits(bn, dec=18, fixed=4){
  try{
    const s = ethers.utils.formatUnits(bn || 0, dec);
    const n = Number(s);
    return isFinite(n) ? n.toFixed(fixed) : s;
  }catch(e){ return '0'; }
}

/** ====== 4) Kết nối ví & kiểm tra chain ====== */
async function connectWallet(){
  if (!window.ethereum || !ethers) {
    alert('Chưa phát hiện ví EVM. Hãy cài MetaMask hoặc ví tương thích.');
    return;
  }

  app.provider = new ethers.providers.Web3Provider(window.ethereum, 'any');

  // Yêu cầu tài khoản
  const accounts = await app.provider.send('eth_requestAccounts', []);
  app.account = (accounts && accounts[0]) ? ethers.utils.getAddress(accounts[0]) : null;
  app.signer = app.provider.getSigner();

  // Kiểm tra chain
  const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
  app.chainIdHex = chainIdHex;

  if (chainIdHex !== VIC_CHAIN_ID_HEX) {
    // cố gắng switch (nếu ví đã có chain 88)
    try{
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: VIC_CHAIN_ID_HEX }]
      });
      app.chainIdHex = VIC_CHAIN_ID_HEX;
    }catch(err){
      // Nếu ví chưa cài chain 88, hiển thị hướng dẫn thủ công để tránh sai RPC
      alert(`Hãy chuyển ví sang mạng ${VIC_NAME} (chainId ${VIC_CHAIN_ID_DEC}).\nChainID hex: ${VIC_CHAIN_ID_HEX}\nBiểu tượng: ${VIC_SYMBOL}`);
      // Không tự add mạng để tránh dùng sai RPC. Người dùng có thể tự thêm theo tài liệu chính thức.
      // Sau khi người dùng đổi mạng, tải lại trang hoặc bấm kết nối lại.
      return;
    }
  }

  // Khởi tạo contract
  app.muaban = new ethers.Contract(MUABAN_ADDRESS, MUABAN_ABI, app.signer);
  app.vin = new ethers.Contract(VIN_TOKEN_ADDRESS, ERC20_ABI, app.signer);

  try{
    app.vinDecimals = await app.vin.decimals();
  }catch(e){
    app.vinDecimals = 18;
  }

  // Cập nhật Header
  ui.walletInfo.classList.remove('hidden');
  ui.accountShort.textContent = shortAddr(app.account);
  ui.networkName.textContent = VIC_NAME;
  ui.btnConnect.style.display = 'none';

  // Đăng ký listener thay đổi account/chain
  setupWalletListeners();

  // Render số dư & trạng thái đăng ký
  await refreshBalances();
  await refreshRegistrationUI();
}

/** ====== 5) Số dư VIN & VIC ====== */
async function refreshBalances(){
  if (!app.signer) return;
  try{
    const [vinBal, vicBal] = await Promise.all([
      app.vin.balanceOf(app.account),
      app.provider.getBalance(app.account)
    ]);
    // Hiển thị ở header (dưới walletInfo) nếu muốn: tạm thời hiển thị qua title tooltip
    ui.walletInfo.title = `VIN: ${fmtUnits(vinBal, app.vinDecimals, 4)} · VIC: ${fmtUnits(vicBal, VIC_DECIMALS, 4)}`;
  }catch(e){
    console.warn('refreshBalances error', e);
  }
}

/** ====== 6) Trạng thái đăng ký (0.001 VIN / ví) ====== */
async function isRegistered(addr){
  try{
    return await app.muaban.isRegistered(addr);
  }catch(e){
    console.warn('isRegistered() failed', e);
    return false;
  }
}

async function getPlatformFee(){
  try{
    const fee = await app.muaban.PLATFORM_FEE(); // 0.001 VIN (wei)
    return fee;
  }catch(e){
    // fallback: 1e15 wei (0.001 VIN)
    return ethers.BigNumber.from('1000000000000000');
  }
}

function setRegUI(registered){
  if (!ui.regStatus) return;

  ui.regStatus.textContent = registered ? 'Đã đăng ký' : 'Chưa đăng ký';
  ui.regStatus.classList.toggle('badge--ok', registered);

  // Ẩn hiện 2 nút approve/pay
  if (ui.btnApproveReg) ui.btnApproveReg.style.display = registered ? 'none' : '';
  if (ui.btnPayReg)     ui.btnPayReg.style.display     = registered ? 'none' : '';
}

async function refreshRegistrationUI(){
  if (!app.account) return;
  const registered = await isRegistered(app.account);
  setRegUI(registered);
}

/** ====== 7) Approve & Trả phí đăng ký ====== */
async function approveRegistration(){
  if (!app.signer) return alert('Vui lòng kết nối ví trước.');
  const fee = await getPlatformFee();
  try{
    ui.btnApproveReg.disabled = true;
    ui.btnApproveReg.textContent = 'Approving…';
    const tx = await app.vin.approve(MUABAN_ADDRESS, fee);
    await tx.wait();
  }catch(e){
    console.error(e);
    alert('Approve thất bại. Kiểm tra số dư VIN và gas.');
  }finally{
    ui.btnApproveReg.textContent = 'Approve 0.001 VIN';
    ui.btnApproveReg.disabled = false;
  }
}

async function payRegistration(){
  if (!app.signer) return alert('Vui lòng kết nối ví trước.');
  const fee = await getPlatformFee();

  try{
    // Kiểm tra allowance đủ chưa
    const allowance = await app.vin.allowance(app.account, MUABAN_ADDRESS);
    if (allowance.lt(fee)) {
      const ok = confirm('Chưa Approve đủ 0.001 VIN. Bạn có muốn Approve ngay không?');
      if (!ok) return;
      await approveRegistration();
    }

    ui.btnPayReg.disabled = true;
    ui.btnPayReg.textContent = 'Đang trả phí…';

    const tx = await app.muaban.payRegistration(); // contract sẽ transferFrom fee → owner
    await tx.wait();

    // Cập nhật UI sau khi đăng ký xong
    await refreshBalances();
    await refreshRegistrationUI();
    alert('Đăng ký nền tảng thành công!');
  }catch(e){
    console.error(e);
    alert('Thanh toán phí đăng ký thất bại. Vui lòng thử lại.');
  }finally{
    ui.btnPayReg.textContent = 'Trả phí 0.001 VIN';
    ui.btnPayReg.disabled = false;
  }
}

/** ====== 8) Wallet listeners ====== */
function setupWalletListeners(){
  if (!window.ethereum) return;

  // đổi account
  window.ethereum.on?.('accountsChanged', async (accs)=>{
    if (!accs || !accs.length){
      // Disconnected
      location.reload();
      return;
    }
    app.account = ethers.utils.getAddress(accs[0]);
    ui.accountShort.textContent = shortAddr(app.account);
    await refreshBalances();
    await refreshRegistrationUI();
  });

  // đổi chain
  window.ethereum.on?.('chainChanged', ()=>{
    // metamask khuyến nghị reload
    location.reload();
  });

  // disconnect (Trust, Rabby…)
  window.ethereum.on?.('disconnect', ()=>{
    location.reload();
  });
}

/** ====== 9) Wire up UI ====== */
document.addEventListener('DOMContentLoaded', ()=>{
  // Connect
  if (ui.btnConnect) ui.btnConnect.addEventListener('click', connectWallet);

  // Đăng ký
  if (ui.btnCheckReg) ui.btnCheckReg.addEventListener('click', refreshRegistrationUI);
  if (ui.btnApproveReg) ui.btnApproveReg.addEventListener('click', approveRegistration);
  if (ui.btnPayReg) ui.btnPayReg.addEventListener('click', payRegistration);
});

// Expose for debug
window.muabanApp = app;
/* ==========================================================================
   muaban — app.js (Part 2/4)
   - Readonly provider + contract để tải SP khi chưa kết nối ví
   - Nạp danh sách sản phẩm từ events ProductCreated, sau đó getProduct()
   - Tìm kiếm/lọc và render card
   - Modal chi tiết + quote VIN (dùng vinPerUSD = wei/USD)
   ========================================================================== */

/** ====== 10) Bổ sung ABI nếu thiếu: quoteVinForProduct ====== */
// (Phần 1 có thể chưa include; ta thêm an toàn)
(function ensureQuoteAbi(){
  if (!Array.isArray(MUABAN_ABI)) return;
  if (!MUABAN_ABI.some(x => x && x.type === 'function' && x.name === 'quoteVinForProduct')) {
    MUABAN_ABI.push({
      "inputs":[
        {"internalType":"uint256","name":"productId","type":"uint256"},
        {"internalType":"uint256","name":"quantity","type":"uint256"},
        {"internalType":"uint256","name":"vinPerUSD","type":"uint256"}
      ],
      "name":"quoteVinForProduct",
      "outputs":[
        {"internalType":"uint256","name":"vinRevenue","type":"uint256"},
        {"internalType":"uint256","name":"vinShipping","type":"uint256"},
        {"internalType":"uint256","name":"vinTax","type":"uint256"},
        {"internalType":"uint256","name":"vinTotal","type":"uint256"}
      ],
      "stateMutability":"view",
      "type":"function"
    });
  }
})();

/** ====== 11) UI refs: Browse + Modal ====== */
const browseUI = {
  grid:        $('#productGrid'),
  tplCard:     $('#tplProductCard'),

  kw:          $('#searchKeyword'),
  seller:      $('#searchSeller'),
  priceMin:    $('#priceMin'),
  priceMax:    $('#priceMax'),
  inStock:     $('#filterInStock'),
  btnSearch:   $('#btnSearch'),
  btnReset:    $('#btnReset'),
};

const modalUI = {
  dlg:       $('#dlgProduct'),
  name:      $('#dlgProdName'),
  img:       $('#dlgProdImg'),
  descLink:  $('#dlgDescLink'),
  seller:    $('#dlgSeller'),

  priceUsd:  $('#dlgPriceUsd'),
  shipUsd:   $('#dlgShipUsd'),
  taxRate:   $('#dlgTaxRate'),
  delivDays: $('#dlgDelivDays'),
  stock:     $('#dlgStock'),

  vinUsdTxt: $('#dlgVinUsd'),   // "1 VIN ≈ X.XX USD"
  // VIC trong modal bị ẩn ở index.html để không lộ ra, nhưng vẫn tồn tại để không lỗi phần khác.

  qty:       $('#buyQty'),
  qRev:      $('#qRev'),
  qShip:     $('#qShip'),
  qTax:      $('#qTax'),
  qTotal:    $('#qTotal'),
  buyStatus: $('#buyStatus'),

  btnApprove: $('#btnApproveBuy'),
  btnPlace:   $('#btnPlaceOrder'),
};

/** ====== 12) Readonly provider & contracts ====== */
const RO = {
  provider: null,
  muaban: null,
  vin: null,
};
async function ensureReadonly(){
  if (RO.provider) return;
  const { ethers } = window.ethers || {};
  if (!ethers) return;

  // Ưu tiên dùng ethereum provider hiện có (không đòi quyền), fallback RPC public
  if (window.ethereum) {
    RO.provider = new ethers.providers.Web3Provider(window.ethereum, 'any'); // đọc-only không cần requestAccounts
  } else {
    // Bạn có thể thay RPC nếu muốn
    const fallbackRPC = 'https://rpc.viction.xyz';
    RO.provider = new ethers.providers.JsonRpcProvider(fallbackRPC);
  }
  RO.muaban = new ethers.Contract(MUABAN_ADDRESS, MUABAN_ABI, RO.provider);
  RO.vin    = new ethers.Contract(VIN_TOKEN_ADDRESS, ERC20_ABI, RO.provider);
}

/** ====== 13) Giá VIC/USDT → USD/VIN → vinPerUSD (wei/USD) ====== */
// USD/VIN để hiển thị: vinUsd = vicUsd * 100 (2 chữ số)
// vinPerUSD (wei / USD) để quote on-chain: = (1 / vinUsd) * 1e18
const priceState = {
  vinUsd: null,             // USD per 1 VIN (số thực)
  vinPerUSDWei: null        // BigNumber (wei per USD)
};

async function fetchVinUsd(){
  try{
    const url = (CFG && CFG.BINANCE_VICUSDT) ? CFG.BINANCE_VICUSDT
              : "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT";
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();
    const vicUsd = parseFloat(data?.price);
    if (!isFinite(vicUsd)) throw new Error('VIC price invalid');
    const vinUsd = vicUsd * 100; // 1 VIN ≈ vinUsd USD (hiển thị)
    priceState.vinUsd = vinUsd;

    // vinPerUSD = wei per 1 USD (tham số contract yêu cầu) —> 1 USD cần bao nhiêu wei VIN
    // Nếu 1 VIN ≈ vinUsd USD ⇒ 1 USD ≈ (1 / vinUsd) VIN ⇒ (1 / vinUsd) * 1e18 wei
    const inv = 1 / vinUsd;
    const weiPerUSD = inv * 1e18;
    priceState.vinPerUSDWei = window.ethers.BigNumber.from(
      window.ethers.utils.parseUnits(inv.toString(), 18) // chính xác hơn (parseUnits)
    );
  }catch(e){
    console.warn('fetchVinUsd failed', e);
    priceState.vinUsd = null;
    priceState.vinPerUSDWei = null;
  }
}

function approxVinFromUsd(usd){
  // ≈ USD / (USD per VIN)
  if (!priceState.vinUsd || !isFinite(usd)) return null;
  const vin = usd / priceState.vinUsd;
  return vin;
}

/** ====== 14) Tải sản phẩm ====== */
// Lấy productIds từ event ProductCreated để duyệt getProduct()
const productsState = {
  ids: [],
  byId: new Map(),   // productId -> product struct
};

async function loadAllProducts(){
  await ensureReadonly();
  if (!RO.provider || !RO.muaban) return;

  const iface = new window.ethers.utils.Interface(MUABAN_ABI);
  const topic = iface.getEventTopic('ProductCreated');

  // Quét toàn chuỗi — có thể thay fromBlock khi biết block deploy
  const logs = await RO.provider.getLogs({
    address: MUABAN_ADDRESS,
    topics: [topic],
    fromBlock: 0,
    toBlock: 'latest'
  });

  const ids = new Set();
  for (const log of logs){
    try{
      const parsed = iface.parseLog(log);
      const pid = window.ethers.BigNumber.from(parsed.args.productId).toString();
      ids.add(pid);
    }catch(e){}
  }
  productsState.ids = Array.from(ids);

  // Lấy chi tiết từng SP
  for (const pid of productsState.ids){
    try{
      const p = await RO.muaban.getProduct(pid);
      productsState.byId.set(String(p.productId), p);
    }catch(e){
      // sản phẩm có thể đã bị xoá/không tìm thấy (nếu thay đổi), bỏ qua
    }
  }
}

/** ====== 15) Render & Tìm kiếm ====== */
function usdCentsToUSD(c){ return Number(c || 0) / 100; }

function matchFilter(p, kw, seller, priceMin, priceMax, inStock){
  const name = (p.name || '').toLowerCase();
  const fKw = kw ? kw.toLowerCase() : '';
  const okKw = fKw ? name.includes(fKw) : true;

  const okSeller = seller ? (p.seller?.toLowerCase() === seller.toLowerCase()) : true;

  const priceUSD = usdCentsToUSD(p.priceUsdCents);
  let okPrice = true;
  if (isFinite(priceMin)) okPrice = okPrice && (priceUSD >= priceMin);
  if (isFinite(priceMax)) okPrice = okPrice && (priceUSD <= priceMax);

  const okStock = inStock ? (window.ethers.BigNumber.from(p.stock || 0).gt(0)) : true;

  return okKw && okSeller && okPrice && okStock && !!p.active;
}

function renderProducts(){
  const g = browseUI.grid;
  if (!g || !browseUI.tplCard) return;
  g.innerHTML = '';

  const kw = browseUI.kw?.value?.trim() || '';
  const seller = browseUI.seller?.value?.trim() || '';
  const priceMin = parseFloat(browseUI.priceMin?.value || '');
  const priceMax = parseFloat(browseUI.priceMax?.value || '');
  const inStock = !!browseUI.inStock?.checked;

  const arr = [];
  for (const pid of productsState.ids){
    const p = productsState.byId.get(String(pid));
    if (!p) continue;
    if (!matchFilter(p, kw, seller, priceMin, priceMax, inStock)) continue;
    arr.push(p);
  }

  if (!arr.length){
    g.innerHTML = `<div class="card muted">Không có sản phẩm phù hợp bộ lọc.</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  for (const p of arr){
    const node = browseUI.tplCard.content.cloneNode(true);
    const el = node.querySelector('article.card.product');

    // Ảnh
    const img = el.querySelector('.prod-img');
    const urlImg = p.imageCID ? `https://ipfs.io/ipfs/${p.imageCID}` : '';
    img.src = urlImg; img.alt = p.name || 'Ảnh sản phẩm';

    // Tên + người bán
    el.querySelector('.prod-name').textContent = p.name || '—';
    el.querySelector('.seller-addr').textContent = p.seller || '—';

    // Giá USD + VIN ước tính
    const priceUSD = usdCentsToUSD(p.priceUsdCents);
    const shipUSD  = usdCentsToUSD(p.shippingUsdCents);
    const taxRate  = Number(p.taxRateBps || 0)/100; // %
    el.querySelector('.usd-val').textContent = priceUSD.toFixed(2);

    let approxVin = null;
    if (priceState.vinUsd) {
      const totalUSDNoTax = priceUSD + shipUSD;
      const taxUSD = (priceUSD * (Number(p.taxRateBps || 0) / 10000));
      const totalUSD = totalUSDNoTax + taxUSD;
      approxVin = approxVinFromUsd(totalUSD);
    }
    el.querySelector('.vin-val').textContent = (approxVin!=null && isFinite(approxVin))
      ? approxVin.toFixed(6) : '—';

    // Thông tin phụ
    el.querySelector('.ship-usd').textContent = shipUSD.toFixed(2);
    el.querySelector('.tax-rate').textContent = taxRate.toFixed(2);
    el.querySelector('.delivery-days').textContent = String(p.deliveryDaysMax || 0);
    el.querySelector('.stock').textContent = window.ethers.BigNumber.from(p.stock||0).toString();

    // Nút xem chi tiết
    el.querySelector('.btn-view').addEventListener('click', ()=> openProductModal(p));

    frag.appendChild(node);
  }

  g.appendChild(frag);
}

/** ====== 16) Mở modal chi tiết + quote VIN ====== */
function ipfsLink(cid){ return cid ? `https://ipfs.io/ipfs/${cid}` : '#'; }

async function openProductModal(p){
  if (!modalUI.dlg) return;

  // fill tĩnh
  modalUI.name.textContent = p.name || 'Chi tiết sản phẩm';
  modalUI.img.src = p.imageCID ? `https://ipfs.io/ipfs/${p.imageCID}` : '';
  modalUI.img.alt = p.name || 'Ảnh sản phẩm';
  modalUI.descLink.href = ipfsLink(p.descriptionCID);
  modalUI.seller.textContent = p.seller || '—';

  const priceUSD = usdCentsToUSD(p.priceUsdCents);
  const shipUSD  = usdCentsToUSD(p.shippingUsdCents);
  modalUI.priceUsd.textContent = priceUSD.toFixed(2);
  modalUI.shipUsd.textContent  = shipUSD.toFixed(2);
  modalUI.taxRate.textContent  = (Number(p.taxRateBps || 0)/100).toFixed(2);
  modalUI.delivDays.textContent= String(p.deliveryDaysMax || 0);
  modalUI.stock.textContent    = window.ethers.BigNumber.from(p.stock || 0).toString();

  // Cập nhật "1 VIN ≈ X.XX USD" trong modal (đã set ở index.html script),
  // ở đây không cần nhưng ta đồng bộ nếu giá vừa fetch xong.
  if (priceState.vinUsd && modalUI.vinUsdTxt){
    modalUI.vinUsdTxt.textContent = Number(priceState.vinUsd).toFixed(2);
  }

  // Quote VIN theo quantity hiện tại
  await updateQuote(p);

  // Mở dialog
  try{ modalUI.dlg.showModal(); }catch{ /* Safari polyfill có thể cần */ }

  // Lắng nghe đổi số lượng → quote lại
  modalUI.qty.oninput = ()=> updateQuote(p);
}

async function updateQuote(p){
  await ensureReadonly();
  if (!RO.muaban) return;

  // Bảo đảm đã có tỷ giá
  if (!priceState.vinUsd || !priceState.vinPerUSDWei){
    await fetchVinUsd();
    if (priceState.vinUsd && modalUI.vinUsdTxt){
      modalUI.vinUsdTxt.textContent = Number(priceState.vinUsd).toFixed(2);
    }
  }

  const qty = Math.max(1, parseInt(modalUI.qty?.value || '1', 10));
  if (!priceState.vinPerUSDWei){
    modalUI.qRev.textContent = modalUI.qShip.textContent = modalUI.qTax.textContent = modalUI.qTotal.textContent = '—';
    modalUI.buyStatus.textContent = 'Không lấy được tỷ giá để tính VIN. Vui lòng thử lại.';
    return;
  }
  modalUI.buyStatus.textContent = '';

  try{
    const useContract = app?.muaban || RO.muaban; // nếu đã connect dùng signer, else dùng readonly
    const [vinRev, vinShip, vinTax, vinTotal] = await useContract.quoteVinForProduct(
      p.productId, qty, priceState.vinPerUSDWei
    );
    const dec = app?.vinDecimals || 18;
    modalUI.qRev.textContent   = window.ethers.utils.formatUnits(vinRev,  dec);
    modalUI.qShip.textContent  = window.ethers.utils.formatUnits(vinShip, dec);
    modalUI.qTax.textContent   = window.ethers.utils.formatUnits(vinTax,  dec);
    modalUI.qTotal.textContent = window.ethers.utils.formatUnits(vinTotal,dec);
  }catch(e){
    console.warn('quote error', e);
    modalUI.qRev.textContent = modalUI.qShip.textContent = modalUI.qTax.textContent = modalUI.qTotal.textContent = '—';
    modalUI.buyStatus.textContent = 'Không quote được VIN cho sản phẩm này.';
  }
}

/** ====== 17) Tìm kiếm / Reset ====== */
function setupBrowseEvents(){
  browseUI.btnSearch?.addEventListener('click', renderProducts);
  browseUI.btnReset?.addEventListener('click', ()=>{
    if (browseUI.kw) browseUI.kw.value = '';
    if (browseUI.seller) browseUI.seller.value = '';
    if (browseUI.priceMin) browseUI.priceMin.value = '';
    if (browseUI.priceMax) browseUI.priceMax.value = '';
    if (browseUI.inStock) browseUI.inStock.checked = true;
    renderProducts();
  });
}

/** ====== 18) Khởi động Browse ====== */
document.addEventListener('DOMContentLoaded', async ()=>{
  // Lấy tỷ giá sớm để hiện VIN ước tính trên cards
  await fetchVinUsd();

  // Tải sản phẩm và render
  await loadAllProducts();
  renderProducts();
  setupBrowseEvents();
});
/* ==========================================================================
   muaban — app.js (Part 3/4)
   - Mã hoá shipping info cục bộ (ECDH P-256 + AES-GCM)
   - Approve VIN theo quote tổng (vinTotal)
   - Gọi placeOrder(productId, quantity, vinPerUSD, shippingInfoCiphertext)
   - Thông báo & VicScan link
   ========================================================================== */

/** ====== 19) Utils: bytes/base64/utf8 ====== */
const utf8 = {
  enc: (s)=> new TextEncoder().encode(s),
  dec: (ab)=> new TextDecoder().decode(ab),
};
function toHex(u8){
  return '0x' + Array.from(u8).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function fromHexToU8(hex){
  return window.ethers.utils.arrayify(hex);
}
function b64enc(u8){
  // browser-safe base64
  let s = '';
  for (let i=0; i<u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

/** ====== 20) Crypto: ECDH(P-256) + AES-GCM ====== */
/**
 * importSellerPubKey: nhận bytes SPKI (P-256) -> CryptoKey
 */
async function importSellerPubKey(spkiBytes){
  try{
    return await crypto.subtle.importKey(
      'spki',
      spkiBytes,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    );
  }catch(e){
    console.warn('importSellerPubKey failed', e);
    throw new Error('Khoá mã hoá người bán không hợp lệ (cần SPKI P-256).');
  }
}

/**
 * encryptShipping: tạo khoá tạm (ephemeral), deriveKey -> AES-GCM, mã hoá JSON
 * Trả về envelope JSON (alg, epk[spki b64], iv b64, ct b64) dưới dạng Uint8Array
 */
async function encryptShipping(sellerSpkiBytes, shippingObj){
  const sellerKey = await importSellerPubKey(sellerSpkiBytes);

  // ephemeral keypair
  const eph = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  );

  // derive AES-GCM key
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: sellerKey },
    eph.privateKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt']
  );

  // iv ngẫu nhiên 12 bytes
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // plaintext = JSON shipping info
  const plaintext = utf8.enc(JSON.stringify(shippingObj));
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext);
  const ct = new Uint8Array(ctBuf);

  // export ephemeral pubkey (spki)
  const epkSpkiBuf = await crypto.subtle.exportKey('spki', eph.publicKey);
  const epkSpki = new Uint8Array(epkSpkiBuf);

  const envelope = {
    alg: 'ECDH-P256+AES-GCM',
    epk_spki_b64: b64enc(epkSpki),
    iv_b64: b64enc(iv),
    ct_b64: b64enc(ct),
  };
  const bytes = utf8.enc(JSON.stringify(envelope));
  return bytes;
}

/** ====== 21) Thu thập form giao hàng trong modal ====== */
function collectShippingForm(){
  const name = $('#shipName')?.value?.trim();
  const phone = $('#shipPhone')?.value?.trim();
  const addr = $('#shipAddr')?.value?.trim();
  const note = $('#shipNote')?.value?.trim();

  if (!name || !phone || !addr){
    throw new Error('Vui lòng điền đủ Tên, SĐT và Địa chỉ giao hàng.');
  }
  return { name, phone, addr, note: note || '' };
}

/** ====== 22) Helpers: quote lại và tính vinTotal (BigNumber) ====== */
async function getFreshQuoteVinTotal(p, qty){
  const useContract = app?.muaban || RO.muaban;
  if (!useContract) throw new Error('Không có contract để quote.');
  // đảm bảo tỷ giá
  if (!priceState.vinUsd || !priceState.vinPerUSDWei) await fetchVinUsd();

  const [ , , , vinTotal ] = await useContract.quoteVinForProduct(
    p.productId, qty, priceState.vinPerUSDWei
  );
  return vinTotal; // BigNumber 18 decimals
}

/** ====== 23) Approve VIN cho đơn ====== */
async function approveVinForOrder(amountWei){
  if (!app.signer) throw new Error('Vui lòng kết nối ví trước.');
  ui.btnApproveReg?.blur();

  const allowance = await app.vin.allowance(app.account, MUABAN_ADDRESS);
  if (allowance.gte(amountWei)) return true;

  // Gửi approve
  try{
    modalUI.btnApprove.disabled = true;
    modalUI.btnApprove.textContent = 'Approving VIN…';
    const tx = await app.vin.approve(MUABAN_ADDRESS, amountWei);
    await tx.wait();
    return true;
  }catch(e){
    console.error(e);
    throw new Error('Approve VIN thất bại.');
  }finally{
    modalUI.btnApprove.textContent = 'Approve VIN';
    modalUI.btnApprove.disabled = false;
  }
}

/** ====== 24) Gọi placeOrder ====== */
async function placeOrderFlow(currentProduct){
  try{
    if (!app.signer) throw new Error('Vui lòng kết nối ví trước.');

    // phải là ví đã đăng ký (hợp đồng dùng modifier onlyRegistered cho buyer/seller)
    const reg = await isRegistered(app.account);
    if (!reg) throw new Error('Ví chưa đăng ký nền tảng. Vui lòng đăng ký 0.001 VIN trước.');

    // số lượng
    const qty = Math.max(1, parseInt(modalUI.qty?.value || '1', 10));

    // quote lại vinTotal để approve chính xác
    const vinTotal = await getFreshQuoteVinTotal(currentProduct, qty);

    // thu thập shipping info
    const ship = collectShippingForm();

    // lấy sellerEncryptPubKey từ product -> bytes
    const sellerKeyBytes = fromHexToU8(currentProduct.sellerEncryptPubKey || '0x');
    if (!sellerKeyBytes?.length) throw new Error('Sản phẩm chưa cấu hình khoá mã hoá của người bán.');

    // mã hoá shipping
    const cipherBytes = await encryptShipping(sellerKeyBytes, ship);

    // đảm bảo allowance đủ
    await approveVinForOrder(vinTotal);

    // gọi placeOrder(productId, quantity, vinPerUSD, shippingInfoCiphertext_)
    // chú ý: vinPerUSD = wei per 1 USD (đã tính ở Part 2)
    modalUI.btnPlace.disabled = true;
    modalUI.btnPlace.textContent = 'Đang đặt hàng…';

    const tx = await app.muaban.placeOrder(
      currentProduct.productId,
      qty,
      priceState.vinPerUSDWei,
      toHex(cipherBytes)
    );
    modalUI.buyStatus.textContent = 'Đang chờ xác nhận giao dịch…';
    const rc = await tx.wait();

    // done
    modalUI.buyStatus.textContent = 'Đặt hàng thành công!';
    await refreshBalances();

    // mở VicScan nếu muốn
    const open = confirm('Mở giao dịch trên VicScan?');
    if (open && rc && rc.transactionHash){
      window.open(`https://vicscan.xyz/tx/${rc.transactionHash}`, '_blank', 'noopener');
    }
  }catch(e){
    console.error(e);
    modalUI.buyStatus.textContent = e?.message || 'Lỗi đặt hàng. Vui lòng thử lại.';
    alert(modalUI.buyStatus.textContent);
  }finally{
    modalUI.btnPlace.textContent = 'Mua (escrow)';
    modalUI.btnPlace.disabled = false;
  }
}

/** ====== 25) Gắn sự kiện cho 2 nút trong modal ====== */
// Lưu product hiện mở để dùng khi nhấn nút
let _currentModalProduct = null;

const __openProductModal_orig = openProductModal;
openProductModal = async function(p){
  _currentModalProduct = p;
  await __openProductModal_orig(p);

  // wiring nút nếu chưa gắn
  if (modalUI && modalUI.btnApprove && !modalUI.btnApprove.__wired){
    modalUI.btnApprove.addEventListener('click', async ()=>{
      try{
        if (!_currentModalProduct) return;
        const qty = Math.max(1, parseInt(modalUI.qty?.value || '1', 10));
        const vinTotal = await getFreshQuoteVinTotal(_currentModalProduct, qty);
        await approveVinForOrder(vinTotal);
        modalUI.buyStatus.textContent = 'Approve VIN thành công.';
      }catch(e){
        modalUI.buyStatus.textContent = e?.message || 'Approve thất bại.';
        alert(modalUI.buyStatus.textContent);
      }
    });
    modalUI.btnApprove.__wired = true;
  }

  if (modalUI && modalUI.btnPlace && !modalUI.btnPlace.__wired){
    modalUI.btnPlace.addEventListener('click', async ()=>{
      if (!_currentModalProduct) return;
      await placeOrderFlow(_currentModalProduct);
    });
    modalUI.btnPlace.__wired = true;
  }
};
/* ==========================================================================
   muaban — app.js (Part 4/4)
   - Tabs nhẹ
   - ĐƠN HÀNG CỦA TÔI: load từ events, render, countdown, Confirm/Refund
   - BÁN HÀNG: tạo sản phẩm, xem "Sản phẩm của tôi", ẩn/hiện, sửa nhanh
   ========================================================================== */

/** ====== 26) Tabs (đơn giản) ====== */
(function setupTabs(){
  document.addEventListener('DOMContentLoaded', ()=>{
    const tabs = $$('.tab');
    const panels = $$('.tab-panel');
    tabs.forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const tab = btn.dataset.tab;
        tabs.forEach(x=>x.classList.toggle('active', x===btn));
        panels.forEach(p=>p.classList.toggle('active', p.id === `tab-${tab}`));
      });
    });
  });
})();

/** ====== 27) ĐƠN HÀNG CỦA TÔI ====== */
const ordersUI = {
  list: $('#orderList'),
  tpl:  $('#tplOrderItem')
};

const ordersState = {
  items: [],  // {orderId, productId, qty, buyer, seller, vinTotal, placedAt, deadline, active}
  tickTimer: null
};

// Load orders theo buyer = app.account, dựa vào events OrderPlaced
async function loadMyOrders(){
  if (!app?.account){ 
    if (ordersUI.list) ordersUI.list.innerHTML = `<div class="card muted">Hãy kết nối ví để xem đơn hàng.</div>`;
    return;
  }
  await ensureReadonly();
  if (!RO.provider) return;

  const iface = new ethers.utils.Interface(MUABAN_ABI);
  const topic = iface.getEventTopic('OrderPlaced');
  const buyerTopic = ethers.utils.hexZeroPad(app.account, 32);

  const logs = await RO.provider.getLogs({
    address: MUABAN_ADDRESS,
    topics: [topic, null, null, buyerTopic], // Indexed: orderId?, productId?, buyer (indexed)
    fromBlock: 0, toBlock: 'latest'
  });

  const items = [];
  for (const log of logs){
    try{
      const ev = iface.parseLog(log).args;
      const orderId  = ev.orderId.toString();
      const productId= ev.productId.toString();
      const buyer    = ev.buyer;
      const seller   = ev.seller;
      const quantity = ev.quantity.toString();
      const vinTotal = ev.vinAmountTotal;
      const placedAt = ev.placedAt.toNumber ? ev.placedAt.toNumber() : Number(ev.placedAt);
      const deadline = ev.deadline.toNumber ? ev.deadline.toNumber() : Number(ev.deadline);

      // kiểm tra trạng thái hiện tại
      let active = true;
      try{ active = await RO.muaban.isOrderActive(orderId); }catch{}
      items.push({ orderId, productId, buyer, seller, qty: quantity, vinTotal, placedAt, deadline, active, log });
    }catch(e){}
  }
  // Sắp xếp mới nhất trước
  items.sort((a,b)=> b.placedAt - a.placedAt);
  ordersState.items = items;
  renderOrders();
  startOrdersTick();
}

function renderOrders(){
  const root = ordersUI.list;
  if (!root || !ordersUI.tpl) return;
  root.innerHTML = '';

  if (!ordersState.items.length){
    root.innerHTML = `<div class="card muted">Bạn chưa có đơn hàng nào.</div>`;
    return;
  }

  const dec = app?.vinDecimals || 18;
  const frag = document.createDocumentFragment();
  for (const it of ordersState.items){
    const node = ordersUI.tpl.content.cloneNode(true);
    const el   = node.querySelector('article.card.order');

    el.querySelector('.oid').textContent = it.orderId;
    el.querySelector('.pid').textContent = it.productId;
    el.querySelector('.qty').textContent = it.qty;

    const st = el.querySelector('.status');
    st.textContent = it.active ? 'Đang escrow' : 'Đã kết thúc';

    el.querySelector('.vin-total').textContent =
      ethers.utils.formatUnits(it.vinTotal, dec);

    el.querySelector('.placed-at').textContent =
      new Date(it.placedAt * 1000).toLocaleString('vi-VN');

    el.querySelector('.deadline').textContent =
      new Date(it.deadline * 1000).toLocaleString('vi-VN');

    const ticking = el.querySelector('.ticking');
    ticking.dataset.deadline = String(it.deadline);

    const btnC = el.querySelector('.btn-confirm');
    const btnR = el.querySelector('.btn-refund');
    const btnScan = el.querySelector('.btn-vicscan');

    // Enable/disable theo thời gian & active
    const nowSec = Math.floor(Date.now()/1000);
    const beforeDeadline = nowSec <= it.deadline;

    btnC.disabled = !(it.active && beforeDeadline);
    btnR.disabled = !(it.active && !beforeDeadline);

    // Xử lý buttons
    btnC.addEventListener('click', ()=> confirmReceiptFlow(it.orderId, el));
    btnR.addEventListener('click', ()=> refundIfExpiredFlow(it.orderId, el));
    btnScan.addEventListener('click', ()=>{
      window.open(`https://vicscan.xyz/address/${MUABAN_ADDRESS}`, '_blank', 'noopener');
    });

    frag.appendChild(node);
  }

  root.appendChild(frag);
}

function startOrdersTick(){
  stopOrdersTick();
  ordersState.tickTimer = setInterval(()=>{
    $$('#orderList .ticking').forEach(span=>{
      const dl = parseInt(span.dataset.deadline, 10);
      const remain = dl - Math.floor(Date.now()/1000);
      span.textContent = remain > 0 ? formatRemain(remain) : 'Hết hạn';
    });
  }, 1000);
}
function stopOrdersTick(){
  if (ordersState.tickTimer){ clearInterval(ordersState.tickTimer); ordersState.tickTimer = null; }
}
function formatRemain(sec){
  const d = Math.floor(sec/86400);
  const h = Math.floor((sec%86400)/3600);
  const m = Math.floor((sec%3600)/60);
  const s = sec%60;
  const parts = [];
  if (d>0) parts.push(`${d}d`);
  if (h>0) parts.push(`${h}h`);
  if (m>0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

async function confirmReceiptFlow(orderId, cardEl){
  try{
    if (!app.signer) return alert('Vui lòng kết nối ví.');
    const btn = cardEl.querySelector('.btn-confirm');
    btn.disabled = true; btn.textContent = 'Đang xác nhận…';
    const tx = await app.muaban.confirmReceipt(orderId);
    await tx.wait();
    alert('Đã xác nhận nhận hàng.');
    await loadMyOrders();
  }catch(e){
    console.error(e);
    alert('Xác nhận thất bại. Có thể đơn đã hết hạn hoặc đã kết thúc.');
  }finally{
    const btn = cardEl.querySelector('.btn-confirm');
    btn.textContent = 'Đã nhận hàng';
  }
}

async function refundIfExpiredFlow(orderId, cardEl){
  try{
    if (!app.signer) return alert('Vui lòng kết nối ví.');
    const btn = cardEl.querySelector('.btn-refund');
    btn.disabled = true; btn.textContent = 'Đang hoàn tiền…';
    const tx = await app.muaban.refundIfExpired(orderId);
    await tx.wait();
    alert('Yêu cầu hoàn tiền đã thực hiện.');
    await loadMyOrders();
  }catch(e){
    console.error(e);
    alert('Hoàn tiền thất bại. Có thể đơn chưa hết hạn hoặc đã kết thúc.');
  }finally{
    const btn = cardEl.querySelector('.btn-refund');
    btn.textContent = 'Hoàn tiền';
  }
}

/** ====== 28) BÁN HÀNG ====== */
const sellUI = {
  formCreate: $('#formCreate'),
  btnLoadMyProducts: $('#btnLoadMyProducts'),
  myProducts: $('#myProducts'),
  tplMyProduct: $('#tplMyProduct'),

  dlgEdit: $('#dlgEditProduct'),
  formEdit: $('#formEdit'),
  btnDoUpdate: $('#btnDoUpdate'),
};

const ZERO = '0x0000000000000000000000000000000000000000';

function parseUsdToCents(v){ const n = Number(v); if (!isFinite(n)) return 0; return Math.round(n*100); }
function parsePercentToBps(v){ const n = Number(v); if (!isFinite(n)) return 0; return Math.round(n*100); }
function hexFromMaybeB64(s){
  const t = (s||'').trim();
  if (!t) return '0x';
  if (t.startsWith('0x') || t.startsWith('0X')) return t;
  // assume base64
  try{
    const bin = atob(t);
    const u8 = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) u8[i] = bin.charCodeAt(i);
    return toHex(u8);
  }catch(e){
    // fallback: treat as hex without 0x
    const cleaned = t.replace(/^([a-fA-F0-9]+)/,'$1');
    return cleaned.startsWith('0x') ? cleaned : ('0x'+cleaned);
  }
}
function addrOrZero(s){ const t=(s||'').trim(); return t ? t : ZERO; }

async function createProductFlow(ev){
  ev?.preventDefault?.();
  if (!app.signer) return alert('Vui lòng kết nối ví.');
  // cần đã đăng ký
  const reg = await isRegistered(app.account);
  if (!reg) return alert('Ví chưa đăng ký 0.001 VIN.');

  const fd = new FormData(sellUI.formCreate);
  const name  = String(fd.get('name')||'').trim();
  const imageCID = String(fd.get('imageCID')||'').trim();
  const descriptionCID = String(fd.get('descriptionCID')||'').trim();

  const priceUsdCents   = parseUsdToCents(fd.get('priceUsd'));
  const shippingUsdCents= parseUsdToCents(fd.get('shippingUsd'));
  const taxRateBps      = parsePercentToBps(fd.get('taxRate'));
  const deliveryDaysMax = parseInt(fd.get('deliveryDays')||'0', 10) || 0;

  const revenueWallet = String(fd.get('revenueWallet')||'').trim();
  const taxWallet     = String(fd.get('taxWallet')||'').trim();
  const shippingWallet= addrOrZero(fd.get('shippingWallet'));

  const sellerEncryptPubKey = hexFromMaybeB64(fd.get('pubkey'));

  const stock = parseInt(fd.get('stock')||'0',10) || 0;
  const active= String(fd.get('active')||'true') === 'true';

  if (!name || !imageCID || !descriptionCID || !revenueWallet || !taxWallet){
    return alert('Vui lòng nhập đủ các trường bắt buộc.');
  }

  try{
    const tx = await app.muaban.createProduct(
      name, descriptionCID, imageCID,
      priceUsdCents, shippingUsdCents, taxRateBps, deliveryDaysMax,
      revenueWallet, taxWallet, shippingWallet,
      sellerEncryptPubKey,
      stock, active
    );
    sellUI.formCreate.querySelector('#btnCreate').disabled = true;
    sellUI.formCreate.querySelector('#btnCreate').textContent = 'Đang tạo…';
    const rc = await tx.wait();
    alert('Đăng sản phẩm thành công!');
    sellUI.formCreate.reset();
    await loadMyProducts();
  }catch(e){
    console.error(e);
    alert('Tạo sản phẩm thất bại. Kiểm tra dữ liệu/chi phí gas.');
  }finally{
    const b = sellUI.formCreate.querySelector('#btnCreate');
    if (b){ b.disabled=false; b.textContent='Đăng sản phẩm'; }
  }
}

async function loadMyProducts(){
  if (!app?.account){
    sellUI.myProducts.innerHTML = `<div class="card muted">Hãy kết nối ví để xem sản phẩm của bạn.</div>`;
    return;
  }
  await ensureReadonly();
  const ids = await RO.muaban.getSellerProductIds(app.account).catch(()=>[]);
  const list = [];
  for (const id of ids){
    try{
      const p = await RO.muaban.getProduct(id);
      list.push(p);
    }catch{}
  }
  // render
  renderMyProducts(list);
}

function renderMyProducts(items){
  const root = sellUI.myProducts;
  if (!root || !sellUI.tplMyProduct){ return; }
  root.innerHTML = '';

  if (!items.length){
    root.innerHTML = `<div class="card muted">Chưa có sản phẩm nào.</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  for (const p of items){
    const node = sellUI.tplMyProduct.content.cloneNode(true);
    const el   = node.querySelector('article.card.my-product');

    const idStr = ethers.BigNumber.from(p.productId).toString();
    el.querySelector('.mp-name').textContent = p.name || '—';
    el.querySelector('.mp-id').textContent = idStr;
    el.querySelector('.mp-updated').textContent = p.updatedAt
      ? new Date(Number(p.updatedAt)*1000).toLocaleString('vi-VN')
      : '—';

    el.querySelector('.mp-active').textContent = p.active ? 'Đang bán' : 'Đang ẩn';

    el.querySelector('.mp-price').textContent = (Number(p.priceUsdCents||0)/100).toFixed(2);
    el.querySelector('.mp-ship').textContent  = (Number(p.shippingUsdCents||0)/100).toFixed(2);
    el.querySelector('.mp-tax').textContent   = (Number(p.taxRateBps||0)/100).toFixed(2);
    el.querySelector('.mp-deliv').textContent = String(p.deliveryDaysMax||0);
    el.querySelector('.mp-stock').textContent = ethers.BigNumber.from(p.stock||0).toString();

    el.querySelector('.mp-revenue').textContent   = p.revenueWallet || ZERO;
    el.querySelector('.mp-taxWallet').textContent = p.taxWallet || ZERO;
    el.querySelector('.mp-shipWallet').textContent= p.shippingWallet || ZERO;

    // Nút toggle ẩn/hiện
    const btnToggle = el.querySelector('.mp-toggle');
    btnToggle.addEventListener('click', ()=> toggleProductActive(idStr, !p.active));

    // Nút sửa
    const btnEdit = el.querySelector('.mp-edit');
    btnEdit.addEventListener('click', ()=> openEditDialog(p));

    frag.appendChild(node);
  }

  root.appendChild(frag);
}

async function toggleProductActive(productId, active){
  if (!app.signer) return alert('Vui lòng kết nối ví.');
  try{
    const tx = await app.muaban.setProductActive(productId, active);
    await tx.wait();
    await loadMyProducts();
  }catch(e){
    console.error(e);
    alert('Đổi trạng thái thất bại.');
  }
}

function openEditDialog(p){
  if (!sellUI.dlgEdit) return;
  const f = sellUI.formEdit;
  f.productId.value = ethers.BigNumber.from(p.productId).toString();
  f.priceUsd.value  = (Number(p.priceUsdCents||0)/100).toFixed(2);
  f.shippingUsd.value = (Number(p.shippingUsdCents||0)/100).toFixed(2);
  f.taxRate.value   = (Number(p.taxRateBps||0)/100).toFixed(2);
  f.deliveryDays.value = String(p.deliveryDaysMax||0);
  f.revenueWallet.value = p.revenueWallet || '';
  f.taxWallet.value     = p.taxWallet || '';
  f.shippingWallet.value= p.shippingWallet || '';
  f.stock.value = ethers.BigNumber.from(p.stock||0).toString();
  // pubkey hiện tại hiển thị dạng hex
  f.pubkey.value = p.sellerEncryptPubKey || '0x';

  try{ sellUI.dlgEdit.showModal(); }catch{}
}

async function doUpdateProduct(){
  if (!app.signer) return alert('Vui lòng kết nối ví.');
  const f = sellUI.formEdit;
  const productId = f.productId.value;
  const priceUsdCents    = parseUsdToCents(f.priceUsd.value);
  const shippingUsdCents = parseUsdToCents(f.shippingUsd.value);
  const taxRateBps       = parsePercentToBps(f.taxRate.value);
  const deliveryDaysMax  = parseInt(f.deliveryDays.value||'0',10) || 0;
  const revenueWallet    = (f.revenueWallet.value||'').trim();
  const taxWallet        = (f.taxWallet.value||'').trim();
  const shippingWallet   = addrOrZero(f.shippingWallet.value);
  const stock            = parseInt(f.stock.value||'0',10) || 0;
  const sellerEncryptPubKey = hexFromMaybeB64(f.pubkey.value);

  try{
    sellUI.btnDoUpdate.disabled = true;
    sellUI.btnDoUpdate.textContent = 'Đang cập nhật…';
    const tx = await app.muaban.updateProduct(
      productId,
      priceUsdCents, shippingUsdCents, taxRateBps, deliveryDaysMax,
      revenueWallet, taxWallet, shippingWallet,
      stock, sellerEncryptPubKey
    );
    await tx.wait();
    alert('Cập nhật sản phẩm thành công!');
    sellUI.dlgEdit.close();
    await loadMyProducts();
  }catch(e){
    console.error(e);
    alert('Cập nhật thất bại.');
  }finally{
    sellUI.btnDoUpdate.disabled = false;
    sellUI.btnDoUpdate.textContent = 'Cập nhật';
  }
}

/** ====== 29) Wire-up Sell & Orders on DOMReady ====== */
document.addEventListener('DOMContentLoaded', ()=>{
  // SELL
  sellUI.formCreate?.addEventListener('submit', createProductFlow);
  $('#btnClearCreate')?.addEventListener('click', ()=> sellUI.formCreate?.reset());
  sellUI.btnLoadMyProducts?.addEventListener('click', loadMyProducts);
  sellUI.btnDoUpdate?.addEventListener('click', doUpdateProduct);

  // ORDERS: tự load khi chuyển tab (đã kết nối)
  const tabOrdersBtn = $('.tab[data-tab="orders"]');
  tabOrdersBtn?.addEventListener('click', ()=>{
    loadMyOrders();
  });

  // Nếu đã kết nối từ lần trước (ví tự inject), có thể load ngay sau 1s (optional)
  setTimeout(()=>{
    if (app?.account) { loadMyOrders(); }
  }, 1000);
});

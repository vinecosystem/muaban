// ================== Cấu hình kết nối ví và mạng ==================
const RPC_URL = "https://rpc.viction.xyz";
const CHAIN_ID = 88; // Viction Chain ID
const VIC_TOKEN_ADDRESS = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4";
const MUABAN_CONTRACT_ADDRESS = "0xe01e2213A899E9B3b1921673D2d13a227a8df638";
const abiVinToken = fetchABI('VinToken_ABI.json'); // ABI của token VIN
const abiMuaban = fetchABI('Muaban_ABI.json'); // ABI của hợp đồng Muaban

let provider;
let signer;
let userAddress = null;
let contractMuaban;
let vinBalance = 0;
let vicBalance = 0;
let vinPriceUsd = 0; // Biến lưu trữ giá VIN theo USD

// ================== Kết nối ví và xử lý giao dịch ==================
async function connectWallet() {
  if (window.ethereum) {
    provider = new ethers.providers.Web3Provider(window.ethereum);
    signer = provider.getSigner();

    try {
      await window.ethereum.request({ method: 'eth_requestAccounts' });
      userAddress = await signer.getAddress();
      updateWalletInfo();
    } catch (error) {
      console.error("User denied wallet connection");
    }
  } else {
    alert("Please install MetaMask or another Web3 wallet to connect");
  }
}

async function updateWalletInfo() {
  // Hiển thị địa chỉ ví rút gọn
  document.getElementById('accountShort').textContent = `${userAddress.slice(0, 6)}...${userAddress.slice(-4)}`;
  document.getElementById('walletInfo').classList.remove('hidden'); // Hiển thị thông tin ví khi kết nối

  // Lấy số dư VIN và VIC
  const vinContract = new ethers.Contract(VIC_TOKEN_ADDRESS, abiVinToken, provider);
  vinBalance = await vinContract.balanceOf(userAddress);
  document.getElementById('vinBalance').textContent = ethers.utils.formatUnits(vinBalance, 18); // Format to VIN decimal
  vicBalance = await provider.getBalance(userAddress);
  document.getElementById('vicBalance').textContent = ethers.utils.formatEther(vicBalance); // Format to VIC (same base as ETH)

  // Kiểm tra ví đã đăng ký chưa
  checkRegistration();

  // Cập nhật giá VIN theo USD từ Binance
  vinPriceUsd = await getVinPrice();

  // Cập nhật trạng thái kết nối ví
  document.getElementById('btnConnect').classList.add('hidden');
  document.getElementById('btnDisconnect').classList.remove('hidden');
}

function disconnectWallet() {
  userAddress = null;
  document.getElementById('walletInfo').classList.add('hidden'); // Ẩn thông tin ví khi ngắt kết nối
  document.getElementById('btnConnect').classList.remove('hidden');
  document.getElementById('btnDisconnect').classList.add('hidden');
}

// ================== Kiểm tra đăng ký ví ==================
async function checkRegistration() {
  const contract = new ethers.Contract(MUABAN_CONTRACT_ADDRESS, abiMuaban, provider);
  const isRegistered = await contract.isRegistered(userAddress);
  
  if (!isRegistered) {
    document.getElementById('btnRegister').classList.remove('hidden');
  } else {
    document.getElementById('btnRegister').classList.add('hidden');
    document.getElementById('btnCreateProduct').classList.remove('hidden');
  }
}

// ================== Đăng ký ví ==================
document.getElementById('btnRegister').addEventListener('click', async () => {
  const contract = new ethers.Contract(MUABAN_CONTRACT_ADDRESS, abiMuaban, signer);
  
  // Gửi 0.001 VIN để đăng ký
  const amountToSend = ethers.utils.parseUnits('0.001', 18); // 0.001 VIN
  try {
    const tx = await contract.register({ value: amountToSend });
    await tx.wait();
    alert('Đăng ký thành công!');
    
    // Sau khi đăng ký, ẩn nút đăng ký và hiện nút tạo sản phẩm
    document.getElementById('btnRegister').classList.add('hidden');
    document.getElementById('btnCreateProduct').classList.remove('hidden');
  } catch (error) {
    console.error('Error registering:', error);
    alert('Lỗi khi đăng ký');
  }
}

// ================== Tạo sản phẩm ==================
document.getElementById('btnCreateProduct').addEventListener('click', () => {
  const createModal = document.getElementById('createModal');
  createModal.classList.remove('hidden');
});

document.getElementById('createClose').addEventListener('click', () => {
  document.getElementById('createModal').classList.add('hidden');
});

document.getElementById('createSubmit').addEventListener('click', async () => {
  const name = document.getElementById('pName').value;
  const imageCID = document.getElementById('pImageCID').value;
  const descCID = document.getElementById('pDescCID').value;
  const priceUsd = parseFloat(document.getElementById('pPriceUsd').value);
  const shippingUsd = parseFloat(document.getElementById('pShippingUsd').value);
  const taxPercent = parseFloat(document.getElementById('pTaxPercent').value);
  const deliveryDays = parseInt(document.getElementById('pDeliveryDays').value);
  const stock = parseInt(document.getElementById('pStock').value);
  const revenueWallet = document.getElementById('pRevenueWallet').value;
  const taxWallet = document.getElementById('pTaxWallet').value;
  const shippingWallet = document.getElementById('pShippingWallet').value;
  const sellerPubKey = document.getElementById('pSellerPubKey').value;
  const active = document.getElementById('pActive').value === 'true';

  const productData = {
    name,
    imageCID,
    descCID,
    priceUsd,
    shippingUsd,
    taxPercent,
    deliveryDays,
    stock,
    revenueWallet,
    taxWallet,
    shippingWallet,
    sellerPubKey,
    active,
  };

  const contract = new ethers.Contract(MUABAN_CONTRACT_ADDRESS, abiMuaban, signer);
  try {
    const tx = await contract.createProduct(
      productData.name,
      productData.imageCID,
      productData.descCID,
      ethers.utils.parseUnits(productData.priceUsd.toString(), 18), // Chuyển USD sang VIN
      ethers.utils.parseUnits(productData.shippingUsd.toString(), 18), // Chuyển USD sang VIN
      productData.taxPercent,
      productData.deliveryDays,
      productData.stock,
      productData.revenueWallet,
      productData.taxWallet,
      productData.shippingWallet,
      productData.sellerPubKey,
      productData.active
    );
    await tx.wait();
    alert("Sản phẩm đã được tạo thành công!");
    createModal.classList.add('hidden');
  } catch (error) {
    console.error('Error creating product:', error);
    alert('Lỗi khi tạo sản phẩm');
  }
}

// ================== Mua sản phẩm ==================
document.getElementById('productList').addEventListener('click', async (event) => {
  if (event.target.classList.contains('buy-btn')) {
    const productId = event.target.dataset.productId;
    const contract = new ethers.Contract(MUABAN_CONTRACT_ADDRESS, abiMuaban, signer);

    // Lấy thông tin sản phẩm từ hợp đồng
    const product = await contract.getProduct(productId);
    const priceUsd = product.priceUsd.toNumber(); // Lấy giá USD của sản phẩm
    const vinAmount = (priceUsd * vinPriceUsd).toFixed(2); // Tính số VIN cần trả

    const totalVin = ethers.utils.parseUnits(vinAmount.toString(), 18); // Chuyển đổi sang VIN

    try {
      const tx = await contract.buyProduct(productId, { value: totalVin });
      await tx.wait();
      alert("Mua hàng thành công!");
    } catch (error) {
      console.error('Error buying product:', error);
      alert('Lỗi khi mua sản phẩm');
    }
  }
}

// ================== Fetch ABI ==================
async function fetchABI(fileName) {
  const response = await fetch(`./${fileName}`);
  const data = await response.json();
  return data;
}

// ================== Event listeners khi tải trang ==================
window.addEventListener('load', () => {
  document.getElementById('btnConnect').addEventListener('click', connectWallet);
  document.getElementById('btnDisconnect').addEventListener('click', disconnectWallet);
});

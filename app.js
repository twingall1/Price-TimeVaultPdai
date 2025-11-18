console.log("App.js loaded. Ethers:", typeof window.ethers);

if (!window.ethers) {
  alert("Ethers failed to load.");
  throw new Error("Ethers not loaded");
}

const ethers = window.ethers;

// ---------------------------
// CONTRACT ADDRESSES
// ---------------------------
const FACTORY_ADDRESS = "0xaA5866aAA1184730Dd2926Ed83aCCbD89F128d1d";
const PDAI_ADDRESS    = "0x6B175474E89094C44Da98B954EedeAC495271d0F";
const DAI_ADDRESS     = "0xefd766ccb38eaf1dfd701853bfce31359239f305";
const PAIR_ADDRESS    = "0x1D2be6eFf95Ac5C380a8D6a6143b6a97dd9D8712";

// ---------------------------
// ABIs
// ---------------------------
const factoryAbi = [
  "event VaultCreated(address indexed owner, address vault, uint256 priceThreshold1e18, uint256 unlockTime)",
  "function createVault(uint256 priceThreshold1e18, uint256 unlockTime) external returns (address)"
];

const vaultAbi = [
  "function owner() view returns (address)",
  "function priceThreshold() view returns (uint256)",
  "function unlockTime() view returns (uint256)",
  "function withdrawn() view returns (bool)",
  "function currentPricePDAIinDAI() view returns (uint256)",
  "function canWithdraw() view returns (bool)",
  "function withdraw() external"
];

const pairAbi = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"
];

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)"
];

// ---------------------------
// STATE
// ---------------------------
let walletProvider, signer, userAddress;
let factory, pdai, pairContract;
let locks = [];
let countdownInterval;

// UI
const connectBtn        = document.getElementById("connectBtn");
const walletSpan        = document.getElementById("walletAddress");
const networkInfo       = document.getElementById("networkInfo");
const createForm        = document.getElementById("createForm");
const targetPriceInput  = document.getElementById("targetPrice");
const unlockDateTimeInput = document.getElementById("unlockDateTime");
const createStatus      = document.getElementById("createStatus");
const createBtn         = document.getElementById("createBtn");
const locksContainer    = document.getElementById("locksContainer");
const globalPriceDiv    = document.getElementById("globalPrice");
const globalPriceRawDiv = document.getElementById("globalPriceRaw");
const manualVaultInput  = document.getElementById("manualVaultInput");
const addVaultBtn       = document.getElementById("addVaultBtn");
const manualAddStatus   = document.getElementById("manualAddStatus");

// ---------------------------
// CONNECT WALLET
// ---------------------------
async function connect() {
  try {
    walletProvider = new ethers.providers.Web3Provider(window.ethereum, "any");
    await walletProvider.send("eth_requestAccounts", []);
    signer = walletProvider.getSigner();
    userAddress = await signer.getAddress();

    const network = await walletProvider.getNetwork();
    walletSpan.textContent = userAddress;
    networkInfo.textContent = `Connected (chainId: ${network.chainId})`;

    factory      = new ethers.Contract(FACTORY_ADDRESS, factoryAbi, signer);
    pdai         = new ethers.Contract(PDAI_ADDRESS, erc20Abi, walletProvider);
    pairContract = new ethers.Contract(PAIR_ADDRESS, pairAbi, walletProvider);

    await refreshGlobalPrice();
    await loadLocalVaults();

    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
      if (locks.length) renderLocks();
    }, 1000);

  } catch (err) {
    alert("Connection failed: " + err.message);
  }
}

connectBtn.addEventListener("click", connect);

// ---------------------------
// PRICE FEED
// ---------------------------
async function refreshGlobalPrice() {
  try {
    const [r0, r1] = await pairContract.getReserves();
    if (r0.isZero() || r1.isZero()) {
      globalPriceDiv.textContent = "No liquidity.";
      return;
    }
    const price = r1.mul(ethers.constants.WeiPerEther).div(r0);
    const float = parseFloat(ethers.utils.formatUnits(price, 18));

    globalPriceDiv.textContent = `1 pDAI ≈ ${float.toFixed(6)} DAI`;
    globalPriceRawDiv.textContent = `raw 1e18: ${price.toString()}`;
  } catch (err) {
    globalPriceDiv.textContent = "Price error.";
  }
}

setInterval(refreshGlobalPrice, 15000);

// ---------------------------
// LOCAL VAULT STORAGE
// ---------------------------
function getLocalVaults() {
  return JSON.parse(localStorage.getItem("vaults-" + userAddress) || "[]");
}
function saveLocalVault(vaultAddr

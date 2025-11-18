console.log("App.js loaded. ethers:", typeof window.ethers);

if (!window.ethers) {
  alert("Ethers not loaded");
  throw new Error("Missing ethers");
}

const ethers = window.ethers;

// -----------------------------------
// CONTRACT ADDRESSES (ALL LOWERCASE)
// -----------------------------------
// IMPORTANT: Put your NEW pDAI VaultFactoryV2 address here:
const FACTORY_ADDRESS = "0x78aC5861edDd2A25593eDF13a897200BDe33E468".toLowerCase();

// pDAI + DAI + pDAI/DAI V2 pair (PulseChain)
const PDAI_ADDRESS    = "0x6b175474e89094c44da98b954eedeac495271d0f".toLowerCase();
const DAI_ADDRESS     = "0xefd766ccb38eaf1dfd701853bfce31359239f305".toLowerCase();
const PAIR_ADDRESS    = "0x1d2be6eff95ac5c380a8d6a6143b6a97dd9d8712".toLowerCase();

// -----------------------------------
// ABIs
// -----------------------------------
const factoryAbi = [
  "event VaultCreated(address indexed owner, address vault, uint256 priceThreshold1e18, uint256 unlockTime)",
  "function createVault(uint256,uint256) external returns (address)"
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

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) external returns (bool)"
];

const pairAbi = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)"
];

// -----------------------------------
// STATE
// -----------------------------------
let walletProvider, signer, userAddress;
let factory, pdai, pairContract;
let locks = [];
let countdownInterval;
let pairToken0IsPDAI = true;

// -----------------------------------
// UI
// -----------------------------------
const connectBtn          = document.getElementById("connectBtn");
const walletSpan          = document.getElementById("walletAddress");
const networkInfo         = document.getElementById("networkInfo");
const createForm          = document.getElementById("createForm");
const targetPriceInput    = document.getElementById("targetPrice");
const unlockDateTimeInput = document.getElementById("unlockDateTime");
const createStatus        = document.getElementById("createStatus");
const createBtn           = document.getElementById("createBtn");
const locksContainer      = document.getElementById("locksContainer");
const globalPriceDiv      = document.getElementById("globalPrice");
const globalPriceRawDiv   = document.getElementById("globalPriceRaw");
const manualVaultInput    = document.getElementById("manualVaultInput");
const addVaultBtn         = document.getElementById("addVaultBtn");
const manualAddStatus     = document.getElementById("manualAddStatus");

// -----------------------------------
// CONNECT WALLET
// -----------------------------------
async function connect() {
  try {
    walletProvider = new ethers.providers.Web3Provider(window.ethereum, "any");
    await walletProvider.send("eth_requestAccounts", []);
    signer = walletProvider.getSigner();
    userAddress = (await signer.getAddress()).toLowerCase();

    const net = await walletProvider.getNetwork();
    walletSpan.textContent = userAddress;
    networkInfo.textContent = `Connected (chainId: ${net.chainId})`;

    factory      = new ethers.Contract(FACTORY_ADDRESS, factoryAbi, signer);
    pdai         = new ethers.Contract(PDAI_ADDRESS, erc20Abi, walletProvider);
    pairContract = new ethers.Contract(PAIR_ADDRESS, pairAbi, walletProvider);

    await detectPairOrder();
    await refreshGlobalPrice();
    await loadLocalVaults();

    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
      if (locks.length) renderLocks();
    }, 1000);

  } catch (err) {
    alert("Connection failed: " + err.message);
    console.error(err);
  }
}
connectBtn.addEventListener("click", connect);

// -----------------------------------
// DETECT PAIR ORDER
// -----------------------------------
async function detectPairOrder() {
  try {
    const token0 = (await pairContract.token0()).toLowerCase();
    pairToken0IsPDAI = (token0 === PDAI_ADDRESS);
  } catch {
    pairToken0IsPDAI = true;
  }
}

// -----------------------------------
// GLOBAL PRICE FEED
// -----------------------------------
async function refreshGlobalPrice() {
  try {
    const [r0, r1] = await pairContract.getReserves();

    let pdaiRes, daiRes;
    if (pairToken0IsPDAI) {
      pdaiRes = r0;
      daiRes  = r1;
    } else {
      pdaiRes = r1;
      daiRes  = r0;
    }

    if (pdaiRes.eq(0) || daiRes.eq(0)) {
      globalPriceDiv.textContent = "No liquidity.";
      return;
    }

    const price = daiRes.mul(ethers.constants.WeiPerEther).div(pdaiRes);
    const float = parseFloat(ethers.utils.formatUnits(price, 18));

    globalPriceDiv.textContent = `1 pDAI ≈ ${float.toFixed(6)} DAI`;
    globalPriceRawDiv.textContent = `raw 1e18: ${price.toString()}`;

  } catch (err) {
    globalPriceDiv.textContent = "Price error.";
    console.error(err);
  }
}
setInterval(refreshGlobalPrice, 15000);

// -----------------------------------
// LOCAL STORAGE
// -----------------------------------
function localKey() {
  return "pdai-vaults-" + userAddress;
}

function getLocalVaults() {
  if (!userAddress) return [];
  return JSON.parse(localStorage.getItem(localKey()) || "[]")
    .map(v => ({ ...v, address:v.address.toLowerCase() }));
}

function saveLocalVault(addr, threshold, unlockTime) {
  let list = getLocalVaults();
  addr = addr.toLowerCase();
  if (!list.find(v => v.address === addr)) {
    list.push({ address:addr, threshold, unlockTime });
    localStorage.setItem(localKey(), JSON.stringify(list));
  }
}

function removeVault(addr) {
  let list = getLocalVaults();
  list = list.filter(v => v.address !== addr.toLowerCase());
  localStorage.setItem(localKey(), JSON.stringify(list));
  loadLocalVaults();
}

// -----------------------------------
// MANUAL ADD
// -----------------------------------
addVaultBtn.addEventListener("click", async () => {
  if (!userAddress) {
    manualAddStatus.textContent = "Connect wallet first.";
    return;
  }
  const addr = manualVaultInput.value.trim().toLowerCase();
  if (!ethers.utils.isAddress(addr)) {
    manualAddStatus.textContent = "Invalid address.";
    return;
  }
  saveLocalVault(addr, null, null);
  manualAddStatus.textContent = "Vault added.";
  manualVaultInput.value = "";
  await loadLocalVaults();
});

// -----------------------------------
// CREATE VAULT
// -----------------------------------
createForm.addEventListener("submit", async e => {
  e.preventDefault();

  if (!signer) return alert("Connect wallet first.");

  try {
    createBtn.disabled = true;
    createStatus.textContent = "Sending...";

    const priceStr = targetPriceInput.value.trim();
    const threshold = ethers.utils.parseUnits(priceStr, 18);

    const dt = unlockDateTimeInput.value.trim();
    const ts = Date.parse(dt);
    if (isNaN(ts)) throw new Error("Invalid datetime");
    const unlockTime = Math.floor(ts / 1000);

    const tx = await factory.createVault(threshold, unlockTime);
    const rcpt = await tx.wait();

    const iface = new ethers.utils.Interface(factoryAbi);
    let vaultAddr = null;

    for (const log of rcpt.logs) {
      try {
        const p = iface.parseLog(log);
        if (p.name === "VaultCreated") {
          vaultAddr = p.args.vault;
          break;
        }
      } catch {}
    }

    if (!vaultAddr) {
      createStatus.textContent = "Vault created but not parsed.";
      return;
    }

    vaultAddr = vaultAddr.toLowerCase();
    saveLocalVault(vaultAddr, threshold.toString(), unlockTime);

    createStatus.textContent = "Vault created: " + vaultAddr;
    await loadLocalVaults();

  } catch (err) {
    createStatus.textContent = "Error: " + err.message;
  } finally {
    createBtn.disabled = false;
  }
});

// -----------------------------------
// LOAD LOCAL VAULTS
// -----------------------------------
async function loadLocalVaults() {
  const list = getLocalVaults();
  if (!list.length) {
    locksContainer.textContent = "No locks found.";
    locks = [];
    return;
  }

  locks = list.map(v => ({
    address: v.address,
    threshold: v.threshold ? ethers.BigNumber.from(v.threshold) : null,
    unlockTime: v.unlockTime || null,
    balance: ethers.constants.Zero,
    currentPrice: ethers.constants.Zero,
    canWithdraw: false,
    withdrawn: false
  }));

  await Promise.all(locks.map(loadVaultDetails));
  renderLocks();
}

// -----------------------------------
// LOAD VAULT DETAILS
// -----------------------------------
async function loadVaultDetails(lock) {
  try {
    const vault = new ethers.Contract(lock.address, vaultAbi, walletProvider);

    const [
      withdrawn,
      currentPrice,
      canWithdraw,
      balance,
      threshold,
      unlockTime
    ] = await Promise.all([
      vault.withdrawn(),
      vault.currentPricePDAIinDAI(),
      vault.canWithdraw(),
      pdai.balanceOf(lock.address),
      vault.priceThreshold(),
      vault.unlockTime()
    ]);

    lock.withdrawn   = withdrawn;
    lock.currentPrice = currentPrice;
    lock.canWithdraw  = canWithdraw;
    lock.balance      = balance;
    lock.threshold    = threshold;
    lock.unlockTime   = unlockTime.toNumber();

  } catch (err) {
    console.error

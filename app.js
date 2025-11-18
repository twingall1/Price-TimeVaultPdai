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

// ---------------------------
// UI ELEMENTS
// ---------------------------
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
      globalPriceDiv.textContent = "No liquidity";
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
// LOCAL VAULT STORAGE (with metadata)
// ---------------------------
function getLocalVaults() {
  return JSON.parse(localStorage.getItem("vaults-" + userAddress) || "[]");
}

function saveLocalVault(vaultAddr, threshold, unlockTime) {
  let list = getLocalVaults();
  
  if (!list.find(v => v.address === vaultAddr)) {
    list.push({
      address: vaultAddr,
      threshold: threshold,
      unlockTime: unlockTime
    });
    localStorage.setItem("vaults-" + userAddress, JSON.stringify(list));
  }
}

// ---------------------------
// MANUAL ADD VAULT
// ---------------------------
addVaultBtn.addEventListener("click", async () => {
  const addr = manualVaultInput.value.trim();
  if (!ethers.utils.isAddress(addr)) {
    manualAddStatus.textContent = "Invalid address.";
    return;
  }
  saveLocalVault(addr, null, null);
  manualAddStatus.textContent = "Vault added.";
  manualVaultInput.value = "";
  await loadLocalVaults();
});

// ---------------------------
// CREATE VAULT
// ---------------------------
createForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (!signer) {
    alert("Connect wallet first.");
    return;
  }

  try {
    createBtn.disabled = true;
    createStatus.textContent = "Sending...";

    const priceStr = targetPriceInput.value.trim();
    const threshold1e18 = ethers.utils.parseUnits(priceStr, 18);

    // Parse ISO datetime-local: "2025-11-22T10:10"
    const dtISO = unlockDateTimeInput.value.trim();
    const timestamp = Date.parse(dtISO);
    const unlockTime = Math.floor(timestamp / 1000);

    if (isNaN(unlockTime)) {
      alert("Invalid datetime.");
      throw new Error("Invalid datetime.");
    }

    const tx = await factory.createVault(threshold1e18, unlockTime);
    const receipt = await tx.wait();

    // Extract event
    const iface = new ethers.utils.Interface(factoryAbi);
    let event = null;
    try {
      event = receipt.logs
        .map(l => { try { return iface.parseLog(l).args } catch { return null; } })
        .find(x => x !== null);
    } catch (err) {}

    let vaultAddr = event?.vault || receipt.contractAddress;

    if (vaultAddr) {
      saveLocalVault(vaultAddr, threshold1e18.toString(), unlockTime);
      createStatus.textContent = "Vault created: " + vaultAddr;
      await loadLocalVaults();
    } else {
      createStatus.textContent = "Vault created (address unknown).";
    }

  } catch (err) {
    createStatus.textContent = "Error: " + err.message;
  } finally {
    createBtn.disabled = false;
  }
});

// ---------------------------
// LOAD LOCAL VAULTS
// ---------------------------
async function loadLocalVaults() {
  locks = [];
  const list = getLocalVaults();

  if (!list.length) {
    locksContainer.textContent = "No locks found.";
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

// ---------------------------
// LOAD VAULT DETAILS
// ---------------------------
async function loadVaultDetails(lock) {
  try {
    const vault = new ethers.Contract(lock.address, vaultAbi, walletProvider);

    const [
      withdrawn,
      currentPrice,
      canWithdraw,
      balance,
      unlockTimeOnChain,
      thresholdOnChain
    ] = await Promise.all([
      vault.withdrawn(),
      vault.currentPricePDAIinDAI(),
      vault.canWithdraw(),
      pdai.balanceOf(lock.address),
      vault.unlockTime(),
      vault.priceThreshold()
    ]);

    lock.withdrawn = withdrawn;
    lock.currentPrice = currentPrice;
    lock.canWithdraw = canWithdraw;
    lock.balance = balance;

    if (!lock.unlockTime) lock.unlockTime = unlockTimeOnChain.toNumber();
    if (!lock.threshold)  lock.threshold  = thresholdOnChain;

  } catch (err) {
    console.error("Vault load error:", lock.address, err);
  }
}

// ---------------------------
// RENDER LOCKS
// ---------------------------
function renderLocks() {
  if (!locks.length) {
    locksContainer.textContent = "No locks found.";
    return;
  }

  locksContainer.innerHTML = locks.map(lock => {
    const target = lock.threshold
      ? parseFloat(ethers.utils.formatUnits(lock.threshold, 18))
      : 0;

    const current = parseFloat(ethers.utils.formatUnits(lock.currentPrice, 18));
    const bal = parseFloat(ethers.utils.formatUnits(lock.balance, 18));
    const countdown = formatCountdown(lock.unlockTime);

    let status =
      lock.withdrawn
        ? '<span class="tag status-warn">WITHDRAWN</span>'
        : lock.canWithdraw
        ? '<span class="tag status-ok">UNLOCKABLE</span>'
        : '<span class="tag status-bad">LOCKED</span>';

    return `
      <div class="card">
        <div class="mono">${lock.address}</div>
        ${status}
        <div><strong>Target:</strong> 1 pDAI ≥ ${target.toFixed(6)} DAI</div>
        <div><strong>Current:</strong> ${current.toFixed(6)} DAI</div>
        <div><strong>Backup unlock:</strong> ${formatTimestamp(lock.unlockTime)}</div>
        <div><strong>Countdown:</strong> ${countdown}</div>
        <div><strong>Locked:</strong> ${bal.toFixed(4)} pDAI</div>
        <button onclick="withdrawVault('${lock.address}')"
          ${(!lock.canWithdraw || lock.withdrawn) ? "disabled" : ""}>
          Withdraw
        </button>
      </div>
    `;
  }).join("");
}

// ---------------------------
// WITHDRAW
// ---------------------------
async function withdrawVault(addr) {
  try {
    const vault = new ethers.Contract(addr, vaultAbi, signer);
    const tx = await vault.withdraw();
    await tx.wait();
    await loadLocalVaults();
  } catch (err) {
    alert("Withdraw failed: " + err.message);
  }
}

// ---------------------------
// UTILITIES
// ---------------------------
function formatTimestamp(ts) {
  return new Date(ts * 1000).toLocaleString();
}

function formatCountdown(ts) {
  const now = Math.floor(Date.now() / 1000);
  let diff = ts - now;
  if (diff <= 0) return "0s";

  const d = Math.floor(diff / 86400); diff %= 86400;
  const h = Math.floor(diff / 3600);  diff %= 3600;
  const m = Math.floor(diff / 60);
  const s = diff % 60;

  const parts = [];
  if (d) parts.push(d + "d");
  if (h) parts.push(h + "h");
  if (m) parts.push(m + "m");
  parts.push(s + "s");
  return parts.join(" ");
}

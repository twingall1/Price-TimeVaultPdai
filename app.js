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
const PDAI_ADDRESS    = "0x6b175474e89094c44da98b954eedeac495271d0f";
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
let provider, signer, userAddress;
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

// ---------------------------
// CONNECT WALLET
// ---------------------------
async function connect() {
  try {
    provider = new ethers.providers.Web3Provider(window.ethereum, "any");
    await provider.send("eth_requestAccounts", []);
    signer = provider.getSigner();
    userAddress = await signer.getAddress();

    const network = await provider.getNetwork();
    walletSpan.textContent = userAddress;
    networkInfo.textContent = `Connected (chainId: ${network.chainId})`;

    factory      = new ethers.Contract(FACTORY_ADDRESS, factoryAbi, signer);
    pdai         = new ethers.Contract(PDAI_ADDRESS, erc20Abi, provider);
    pairContract = new ethers.Contract(PAIR_ADDRESS, pairAbi, provider);

    await refreshGlobalPrice();
    await loadUserLocks();

    // Just re-render every second (no separate function name to go missing)
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

// ---------------------------
// GLOBAL PRICE FEED
// ---------------------------
async function refreshGlobalPrice() {
  if (!pairContract) return;
  try {
    // Correct way: ethers v5 returns an array
    const [reserve0, reserve1] = await pairContract.getReserves();
    // reserve0 = pDAI, reserve1 = DAI

    if (!reserve0 || !reserve1) {
      globalPriceDiv.textContent = "No reserves returned.";
      return;
    }

    if (reserve0.isZero() || reserve1.isZero()) {
      globalPriceDiv.textContent = "No liquidity.";
      return;
    }

    const price1e18 = reserve1.mul(ethers.constants.WeiPerEther).div(reserve0);
    const priceFloat = parseFloat(ethers.utils.formatUnits(price1e18, 18));

    globalPriceDiv.textContent =
      `1 pDAI ≈ ${priceFloat.toFixed(6)} DAI`;
    globalPriceRawDiv.textContent = `raw 1e18: ${price1e18.toString()}`;

  } catch (err) {
    console.error("PRICE ERROR:", err);
    globalPriceDiv.textContent = "Error reading price.";
  }
}

setInterval(refreshGlobalPrice, 15000);

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
    // Read raw UK-style datetime produced by your input
    // Read native datetime-local value (ISO format: "2025-11-22T10:10")
    const dtISO = unlockDateTimeInput.value.trim();
    
    // Convert ISO datetime to unix timestamp
    const timestamp = Date.parse(dtISO);
    const unlockTime = Math.floor(timestamp / 1000);
    
    if (isNaN(unlockTime)) {
      alert("Invalid datetime. Please use the picker.");
      throw new Error("Invalid datetime.");
    }

    
    const threshold1e18 = ethers.utils.parseUnits(priceStr, 18);

    const tx = await factory.createVault(threshold1e18, unlockTime);
    await tx.wait();

    createStatus.textContent = "Vault created!";
    await loadUserLocks();

  } catch (err) {
    createStatus.textContent = "Error: " + err.message;
    console.error(err);
  } finally {
    createBtn.disabled = false;
  }
});

// ---------------------------
// LOAD LOCKS
// ---------------------------
async function loadUserLocks() {
  if (!provider || !userAddress) return;

  locksContainer.textContent = "Loading...";

  const iface = new ethers.utils.Interface(factoryAbi);
  const topic = iface.getEventTopic("VaultCreated");

  const logs = await provider.getLogs({
    address: FACTORY_ADDRESS,
    topics: [topic, ownerTopic],
    fromBlock: 1,
    toBlock: "latest"
  });

  locks = logs.map(log => {
    const parsed = iface.decodeEventLog("VaultCreated", log.data, log.topics);
    return {
      address: parsed.vault,
      threshold: parsed.priceThreshold1e18,
      unlockTime: parsed.unlockTime.toNumber(),
      balance: ethers.constants.Zero,
      currentPrice: ethers.constants.Zero,
      canWithdraw: false,
      withdrawn: false
    };
  });

  await Promise.all(locks.map(loadVaultDetails));
  renderLocks();
}

async function loadVaultDetails(lock) {
  const vault = new ethers.Contract(lock.address, vaultAbi, provider);

  const [
    withdrawn,
    currentPrice,
    canWithdraw,
    balance
  ] = await Promise.all([
    vault.withdrawn(),
    vault.currentPricePDAIinDAI(),
    vault.canWithdraw(),
    pdai.balanceOf(lock.address)
  ]);

  lock.withdrawn   = withdrawn;
  lock.currentPrice = currentPrice;
  lock.canWithdraw  = canWithdraw;
  lock.balance      = balance;
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
    const target  = parseFloat(ethers.utils.formatUnits(lock.threshold, 18));
    const current = parseFloat(ethers.utils.formatUnits(lock.currentPrice, 18));
    const bal     = parseFloat(ethers.utils.formatUnits(lock.balance, 18));
    const countdown = formatCountdown(lock.unlockTime);

    let status;
    if (lock.withdrawn) status = `<span class="tag status-warn">WITHDRAWN</span>`;
    else if (lock.canWithdraw) status = `<span class="tag status-ok">UNLOCKABLE</span>`;
    else status = `<span class="tag status-bad">LOCKED</span>`;

    return `
      <div class="card">
        <div class="mono">${lock.address}</div>
        ${status}
        <div><strong>Target:</strong> 1 pDAI ≥ ${target.toFixed(6)} DAI</div>
        <div><strong>Current:</strong> ${current.toFixed(6)} DAI</div>
        <div><strong>Backup:</strong> ${formatTimestamp(lock.unlockTime)}</div>
        <div><strong>Countdown:</strong> ${countdown}</div>
        <div><strong>Locked:</strong> ${bal.toFixed(4)} pDAI</div>
        <button
          onclick="withdrawVault('${lock.address}')"
          ${(!lock.canWithdraw || lock.withdrawn) ? "disabled" : ""}
        >
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
    await loadUserLocks();
  } catch (err) {
    alert("Withdraw failed: " + err.message);
  }
}

window.withdrawVault = withdrawVault;

// ---------------------------
// UTILS
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

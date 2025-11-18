console.log("pDAI App.js loaded. Ethers:", typeof window.ethers);

if (!window.ethers) {
  alert("Ethers failed to load.");
  throw new Error("Ethers missing");
}
const ethers = window.ethers;

// -----------------------------------
// CONTRACT ADDRESSES (ALL LOWERCASE)
// -----------------------------------
// ✨ IMPORTANT: replace with your actual pDAI vault factory V2 address
const FACTORY_ADDRESS = "0x78aC5861edDd2A25593eDF13a897200BDe33E468".toLowerCase();

// pDAI ERC20 token address
const PDAI_ADDRESS = "0x6b175474e89094c44da98b954eedeac495271d0f".toLowerCase();

// True DAI on PulseChain
const DAI_ADDRESS  = "0xefd766ccb38eaf1dfd701853bfce31359239f305".toLowerCase();

// PulseX v2 pair: pDAI / DAI (token0 = pDAI, token1 = DAI)
const PAIR_ADDRESS = "0x1d2be6eff95ac5c380a8d6a6143b6a97dd9d8712".toLowerCase();


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
let factory, pdaiToken, pairContract;
let locks = [];
let countdownInterval;
let pairToken0IsPDAI = true;


// -----------------------------------
// UI ELEMENTS
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
    pdaiToken    = new ethers.Contract(PDAI_ADDRESS, erc20Abi, walletProvider);
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
// DETERMINE LIQUIDITY PAIR ORDERING (token0 == pDAI?)
// -----------------------------------
async function detectPairOrder() {
  try {
    const token0 = (await pairContract.token0()).toLowerCase();
    pairToken0IsPDAI = (token0 === PDAI_ADDRESS);
  } catch {
    pairToken0IsPDAI = true;  // fallback
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
  const list = JSON.parse(localStorage.getItem(localKey()) || "[]");
  return list.map(v => ({ ...v, address: v.address.toLowerCase() }));
}

function saveLocalVault(addr, threshold, unlockTime) {
  let list = getLocalVaults();
  addr = addr.toLowerCase();
  if (!list.find(v => v.address === addr)) {
    list.push({ address: addr, threshold, unlockTime });
    localStorage.setItem(localKey(), JSON.stringify(list));
  }
}

function removeVault(addr) {
  addr = addr.toLowerCase();
  let list = getLocalVaults();
  list = list.filter(v => v.address !== addr);
  localStorage.setItem(localKey(), JSON.stringify(list));
  loadLocalVaults();
}


// -----------------------------------
// MANUAL ADD VAULT
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
  if (!signer) {
    alert("Connect wallet first.");
    return;
  }

  try {
    createBtn.disabled = true;
    createStatus.textContent = "Sending...";

    const priceStr = targetPriceInput.value.trim();
    const th1e18   = ethers.utils.parseUnits(priceStr, 18);

    const dt    = unlockDateTimeInput.value.trim();
    const ts    = Date.parse(dt);
    if (isNaN(ts)) throw new Error("Invalid datetime");

    const unlockTime = Math.floor(ts / 1000);

    const tx = await factory.createVault(th1e18, unlockTime);
    const rcpt = await tx.wait();

    const iface = new ethers.utils.Interface(factoryAbi);
    let vaultAddr = null;

    for (const log of rcpt.logs) {
      try {
        const p = iface.parseLog(log);
        if (p.name === "VaultCreated")
          vaultAddr = p.args.vault;
      } catch {}
    }

    if (!vaultAddr) {
      createStatus.textContent = "Vault created but not parsed.";
      return;
    }

    vaultAddr = vaultAddr.toLowerCase();
    saveLocalVault(vaultAddr, th1e18.toString(), unlockTime);

    createStatus.textContent = "Vault created: " + vaultAddr;
    await loadLocalVaults();

  } catch (err) {
    createStatus.textContent = "Error: " + err.message;
    console.error(err);
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
    address     : v.address,
    threshold   : v.threshold ? ethers.BigNumber.from(v.threshold) : null,
    unlockTime  : v.unlockTime || null,
    balance     : ethers.constants.Zero,
    currentPrice: ethers.constants.Zero,
    canWithdraw : false,
    withdrawn   : false
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
      pdaiToken.balanceOf(lock.address),
      vault.priceThreshold(),
      vault.unlockTime()
    ]);

    lock.withdrawn    = withdrawn;
    lock.currentPrice = currentPrice;
    lock.canWithdraw  = canWithdraw;
    lock.balance      = balance;
    lock.threshold    = threshold;
    lock.unlockTime   = unlockTime.toNumber();

  } catch (err) {
    console.error("Vault load error:", lock.address, err);
  }
}

// --------------
// PART 1 END
// --------------
// -----------------------------------
// RENDER LOCK CARDS
// -----------------------------------
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
    const bal     = parseFloat(ethers.utils.formatUnits(lock.balance, 18));
    const countdown = formatCountdown(lock.unlockTime);

    const nowTs = Math.floor(Date.now() / 1000);
    const progressPct = (timeProgress(nowTs, lock.unlockTime) * 100).toFixed(2);

    let status =
      lock.withdrawn
        ? '<span class="tag status-warn">WITHDRAWN</span>'
        : lock.canWithdraw
        ? '<span class="tag status-ok">UNLOCKABLE</span>'
        : '<span class="tag status-bad">LOCKED</span>';

    return `
      <div class="card vault-card ${lock.canWithdraw ? 'vault-unlockable' : ''}">
        
        <!-- Address + copy -->
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;width:100%;max-width:450px;">
          <input class="mono"
            value="${lock.address}"
            readonly
            style="
              background:#020617;
              color:#a5b4fc;
              border:1px solid #4b5563;
              width:100%;
              padding:4px;
              border-radius:6px;
            " />
        
          <div class="copy-icon-btn" onclick="copyAddr('${lock.address}')">
            <svg viewBox="0 0 24 24">
              <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 
                       0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 
                       2-.9 2-2V7c0-1.1-.9-2-2-2zm0 
                       16H8V7h11v14z"/>
            </svg>
          </div>
        </div>


        ${status}

        <div><strong>Target:</strong> 1 pDAI ≥ ${target.toFixed(6)} DAI</div>
        <div><strong>Current:</strong> ${current.toFixed(6)} DAI</div>
        <div><strong>Backup unlock:</strong> ${formatTimestamp(lock.unlockTime)}</div>
        <div><strong>Countdown:</strong> ${countdown}</div>



        <div style="margin-top:8px;">
          <strong>Locked:</strong> ${bal.toFixed(4)} pDAI
        </div>

        <!-- Withdraw -->
        <button onclick="withdrawVault('${lock.address}')"
          ${(!lock.canWithdraw || lock.withdrawn) ? "disabled" : ""}>
          Withdraw
        </button>

        <!-- Remove -->
        <button onclick="removeVault('${lock.address}')"
          style="margin-left:10px;background:#b91c1c;">
          Remove
        </button>

      </div>
    `;
  }).join("");
}
// -----------------------------------
// WITHDRAW
// -----------------------------------
async function withdrawVault(addr) {
  try {
    const vault = new ethers.Contract(addr, vaultAbi, signer);
    const tx = await vault.withdraw();
    await tx.wait();
    await loadLocalVaults();
  } catch (err) {
    alert("Withdraw failed: " + err.message);
    console.error(err);
  }
}

// -----------------------------------
// COPY ADDRESS TO CLIPBOARD
// -----------------------------------
function copyAddr(addr) {
  navigator.clipboard.writeText(addr).catch(err => {
    console.error("Copy failed:", err);
  });
}

// -----------------------------------
// TIME PROGRESS HELPER
// -----------------------------------
function timeProgress(now, unlockTime, thresholdTime = 0) {
  if (now >= unlockTime) return 1;
  const total = unlockTime - thresholdTime;
  const done  = now - thresholdTime;
  if (total <= 0) return 1;
  return Math.max(0, Math.min(1, done / total));
}

// -----------------------------------
// UTILITIES
// -----------------------------------
function formatTimestamp(ts) {
  return new Date(ts * 1000).toLocaleString();
}

function formatCountdown(ts) {
  const now = Math.floor(Date.now() / 1000);
  let diff = ts - now;

  if (diff <= 0) return "0s";

  const d = Math.floor(diff / 86400);
  diff %= 86400;
  const h = Math.floor(diff / 3600);
  diff %= 3600;
  const m = Math.floor(diff / 60);
  const s = diff % 60;

  const parts = [];
  if (d) parts.push(d + "d");
  if (h) parts.push(h + "h");
  if (m) parts.push(m + "m");
  parts.push(s + "s");

  return parts.join(" ");
}

// -----------------------------------
// END OF FILE
// -----------------------------------


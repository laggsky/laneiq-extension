// ─── License key validation ───────────────────────────────────────────────────
const VALIDATION_URL = 'https://laneiq-backend-production.up.railway.app/validate';
const LICENSE_GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours

async function validateLicenseKey(key, forceRefresh = false) {
  if (!key || typeof key !== 'string' || !key.trim()) {
    return { valid: false, cached: false };
  }
  const trimmedKey = key.trim();

  const stored = await chrome.storage.local.get(['licenseKey', 'licenseValid', 'licenseCheckedAt', 'licenseTier']);
  const cachedKey   = stored.licenseKey;
  const cachedValid = stored.licenseValid;
  const checkedAt   = stored.licenseCheckedAt;

  if (!forceRefresh && cachedKey === trimmedKey && cachedValid && checkedAt) {
    const age = Date.now() - new Date(checkedAt).getTime();
    if (age < LICENSE_GRACE_MS) {
      return { valid: true, cached: true, tier: stored.licenseTier || 'solo' };
    }
  }

  try {
    const resp = await fetch(VALIDATION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: trimmedKey }),
    });
    const data = await resp.json();
    if (data.valid) {
      await chrome.storage.local.set({
        licenseKey: trimmedKey,
        licenseValid: true,
        licenseCheckedAt: new Date().toISOString(),
        licenseTier: data.tier || 'solo',
      });
      return { valid: true, cached: false, tier: data.tier || 'solo' };
    }
    await chrome.storage.local.set({ licenseValid: false });
    return { valid: false, cached: false, tier: null };
  } catch {
    if (cachedKey === trimmedKey && cachedValid && checkedAt) {
      const age = Date.now() - new Date(checkedAt).getTime();
      if (age < LICENSE_GRACE_MS) return { valid: true, cached: true, tier: stored.licenseTier || 'solo' };
    }
    return { valid: false, cached: false, tier: null };
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function showError(msg) {
  const el = document.getElementById('errorMsg');
  el.textContent = msg; el.style.display = 'block';
}

function updateStatus(count, fileCount) {
  document.getElementById('statusBox').className = 'status-box loaded';
  document.getElementById('statusVal').textContent = `${count.toLocaleString()} lanes loaded ✓`;
  document.getElementById('statusSub').textContent = `${fileCount} file${fileCount > 1 ? 's' : ''} · Ready — open DAT now`;
}

// ─── Exports (for unit testing in Node) ──────────────────────────────────────
if (typeof module !== 'undefined') module.exports = { validateLicenseKey };

// ─── Main ─────────────────────────────────────────────────────────────────────
if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', async () => {

  // --- Activation screen gate ---
  const licenseCheck = await chrome.storage.local.get(['licenseValid']);
  if (!licenseCheck.licenseValid) {
    document.getElementById('activation-screen').style.display = 'flex';
    Array.from(document.body.children).forEach(el => {
      if (el.id !== 'activation-screen') el.style.display = 'none';
    });
    const activationBtn    = document.getElementById('activation-activate-btn');
    const activationInput  = document.getElementById('activation-key-input');
    const activationStatus = document.getElementById('activation-status');
    async function attemptActivation() {
      const key = activationInput.value.trim();
      if (!key) { activationStatus.textContent = 'Please enter a license key.'; return; }
      activationBtn.textContent = 'Checking...';
      activationBtn.disabled = true;
      activationStatus.textContent = '';
      const result = await validateLicenseKey(key, true);
      if (result.valid) {
        window.location.reload();
      } else {
        activationStatus.textContent = 'Invalid key — check your key and try again.';
        activationBtn.textContent = 'Activate';
        activationBtn.disabled = false;
      }
    }
    activationBtn.addEventListener('click', attemptActivation);
    activationInput.addEventListener('keydown', e => { if (e.key === 'Enter') attemptActivation(); });
    return;
  }

  // Silent background re-validation
  (async function silentRevalidate() {
    try {
      const { licenseKey } = await chrome.storage.local.get(['licenseKey']);
      if (!licenseKey) return;
      const resp = await fetch(VALIDATION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: licenseKey }),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data.valid) {
        await chrome.storage.local.set({ licenseValid: false });
        window.location.reload();
        return;
      }
      const { licenseTier: storedTier, useDB: storedUseDB } =
        await chrome.storage.local.get(['licenseTier', 'useDB']);
      const backendTier = data.tier || 'solo';
      const updates = {};
      if (storedTier !== backendTier) updates.licenseTier = backendTier;
      if (backendTier !== 'pro' && storedUseDB) updates.useDB = false;
      if (Object.keys(updates).length) await chrome.storage.local.set(updates);
    } catch {
      // Network failure — fail open
    }
  })();

  // Status box — read current lane count from storage
  const stored = await chrome.storage.local.get(['laneCount', 'filesMeta', 'mapsApiKey', 'licenseKey', 'licenseValid', 'licenseCheckedAt', 'licenseTier']);

  if (stored.laneCount && stored.filesMeta && stored.filesMeta.length) {
    updateStatus(stored.laneCount, stored.filesMeta.length);
  } else {
    document.getElementById('statusBox').className = 'status-box';
    document.getElementById('statusVal').textContent = 'No data loaded';
    document.getElementById('statusSub').textContent = 'Open the panel on DAT → Setup tab to upload CSV';
  }

  // ── Maps API Key ─────────────────────────────────────────────────────────────
  document.getElementById('mapsHelpToggle').addEventListener('click', () => {
    const note = document.getElementById('mapsHelpNote');
    note.style.display = note.style.display === 'none' ? 'block' : 'none';
  });

  const mapsKeyInput  = document.getElementById('mapsKeyInput');
  const mapsKeyStatus = document.getElementById('mapsKeyStatus');
  if (stored.mapsApiKey) {
    mapsKeyInput.value = '••••••••••••••••••••';
    mapsKeyStatus.textContent = '✓ API key saved';
    mapsKeyStatus.className = 'gmail-status set';
  }
  document.getElementById('mapsKeySave').addEventListener('click', async () => {
    const key = mapsKeyInput.value.trim();
    if (!key || key.startsWith('•')) { mapsKeyStatus.textContent = 'Paste a new key to update'; return; }
    await chrome.storage.local.set({ mapsApiKey: key });
    mapsKeyInput.value = '••••••••••••••••••••';
    mapsKeyStatus.textContent = '✓ API key saved';
    mapsKeyStatus.className = 'gmail-status set';
  });

  // ── License key ───────────────────────────────────────────────────────────────
  const licenseInput  = document.getElementById('licenseInput');
  const licenseStatus = document.getElementById('licenseStatus');
  const licenseSave   = document.getElementById('licenseSave');

  if (licenseInput && licenseSave && licenseStatus) {
    const saved = await chrome.storage.local.get(['licenseKey', 'licenseValid', 'licenseCheckedAt']);
    if (saved.licenseKey) {
      licenseInput.placeholder = saved.licenseKey.slice(0, 8) + '••••••••';
      const age   = saved.licenseCheckedAt ? Date.now() - new Date(saved.licenseCheckedAt).getTime() : Infinity;
      const fresh = age < LICENSE_GRACE_MS;
      if (saved.licenseValid && fresh) {
        licenseStatus.textContent = '✓ License active';
        licenseStatus.className = 'gmail-status set';
        document.getElementById('manageSubBtn').style.display = 'inline-block';
      } else if (saved.licenseValid && !fresh) {
        licenseStatus.textContent = '⚠ License cached — reconnect to verify';
        licenseStatus.className = 'gmail-status unset';
      } else {
        licenseStatus.textContent = '✗ License invalid';
        licenseStatus.className = 'gmail-status unset';
      }
    }

    document.getElementById('manageSubBtn').addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://billing.stripe.com/p/login/7sY9AScHv3lMaKY2GZ5EY00' });
    });

    document.getElementById('licenseClear').addEventListener('click', async () => {
      await chrome.storage.local.remove(['licenseKey', 'licenseValid', 'licenseCheckedAt', 'licenseTier', 'useCSV', 'useDB']);
      licenseInput.value = '';
      licenseInput.placeholder = 'LANEIQ-XXXX-XXXX-XXXX';
      licenseStatus.textContent = 'License cleared';
      licenseStatus.className = 'gmail-status unset';
      setTimeout(() => {
        licenseStatus.textContent = 'Enter your license key to activate LaneIQ';
      }, 1500);
    });

    licenseSave.addEventListener('click', async () => {
      const key = licenseInput.value.trim();
      if (!key) { licenseStatus.textContent = 'Paste your license key'; return; }
      licenseStatus.textContent = 'Checking…';
      licenseStatus.className = 'gmail-status';
      const { valid, tier } = await validateLicenseKey(key, true);
      if (valid) {
        licenseStatus.textContent = `✓ License active${tier === 'pro' ? ' · Pro' : ''}`;
        licenseStatus.className = 'gmail-status set';
        document.getElementById('manageSubBtn').style.display = 'inline-block';
        licenseInput.value = '';
        licenseInput.placeholder = key.slice(0, 8) + '••••••••';
      } else {
        licenseStatus.textContent = '✗ Invalid key — check your email or contact support';
        licenseStatus.className = 'gmail-status unset';
      }
    });
  }

  // ── Clear all data ────────────────────────────────────────────────────────────
  document.getElementById('clearBtn').addEventListener('click', async () => {
    // Preserve all settings managed by panel tabs and popup
    const keep = await chrome.storage.local.get([
      'gmailEmail', 'gmailIndex',
      'senderEmail', 'senderGmailIndex',
      'emailTemplate', 'emailSubject', 'emailTemplates', 'activeTemplate',
      'signature',
      'mapsApiKey',
      'lovedLoads',
      'licenseKey', 'licenseValid', 'licenseCheckedAt', 'licenseTier',
      'useCSV', 'useDB',
    ]);
    await chrome.storage.local.clear();
    const toRestore = Object.fromEntries(Object.entries(keep).filter(([, v]) => v !== undefined));
    if (Object.keys(toRestore).length) await chrome.storage.local.set(toRestore);
    document.getElementById('statusVal').textContent = 'No data loaded';
    document.getElementById('statusSub').textContent = 'Open the panel on DAT → Setup tab to upload CSV';
    document.getElementById('statusBox').className = 'status-box';
    document.getElementById('errorMsg').style.display = 'none';
  });

  // ── Reload DAT tabs ───────────────────────────────────────────────────────────
  document.getElementById('reloadBtn').addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ url: '*://*.dat.com/*' });
    tabs.forEach(t => chrome.tabs.reload(t.id));
    window.close();
  });

  // ── Setup Help ────────────────────────────────────────────────────────────────
  document.getElementById('setupHelpLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html?screen=2') });
  });

});

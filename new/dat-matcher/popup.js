// ─── License key validation ───────────────────────────────────────────────────
const VALIDATION_URL = 'https://laneiq-backend-production.up.railway.app/validate';
const TEAM_VALIDATION_URL = 'https://laneiq-backend-production.up.railway.app/validate-team';
const LICENSE_GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours

// True when a key is a Team-plan key (manager LANEIQ-TEAM-MGR-… or dispatcher
// LANEIQ-TEAM-…). Team keys route to /validate-team where seats are enforced.
function isTeamKey(key) {
  return /^LANEIQ-TEAM/i.test((key || '').trim());
}

// Map a /validate-team failure reason to friendly UI text.
function teamReasonText(reason, deviceLimit) {
  switch (reason) {
    case 'seat_limit_reached': return 'Team is full (all seats used)';
    case 'device_limit':       return `This person is already on ${deviceLimit || 2} devices`;
    case 'not_team_key':       return 'Not a valid team key';
    case 'invalid_key':        return 'Invalid or inactive key';
    case 'missing_fields':     return 'Key and email required';
    case 'missing_email':      return 'Email required for team activation';
    default:                   return 'Invalid key — check your key and try again.';
  }
}

// Stable per-install device id (privacy-friendly UUID, no fingerprinting).
// Created once and reused; shared across all extension contexts via storage.local.
async function getDeviceId() {
  const { dlmDeviceId } = await chrome.storage.local.get('dlmDeviceId');
  if (dlmDeviceId) return dlmDeviceId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ dlmDeviceId: id });
  return id;
}

async function validateLicenseKey(key, forceRefresh = false, email = '') {
  if (!key || typeof key !== 'string' || !key.trim()) {
    return { valid: false, cached: false };
  }
  const trimmedKey = key.trim();

  // Team keys take a separate path — /validate-team enforces seats and REQUIRES
  // an email. Always live (no offline cache): seat state can change server-side.
  if (isTeamKey(trimmedKey)) {
    const normEmail = (email || '').trim().toLowerCase();
    if (!normEmail) return { valid: false, cached: false, tier: null, reason: 'missing_email' };
    try {
      const deviceId = await getDeviceId();
      const resp = await fetch(TEAM_VALIDATION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: trimmedKey, email: normEmail, deviceId }),
      });
      const data = await resp.json();
      if (data.valid) {
        await chrome.storage.local.set({
          licenseKey: trimmedKey,
          licenseValid: true,
          licenseCheckedAt: new Date().toISOString(),
          licenseTier: 'team',
          teamId: data.team_id || null,
          teamEmail: normEmail,
          teamRole: data.team_role || null,
          seatLimit: data.seat_limit ?? null,
          seatsUsed: data.seats_used ?? null,
          useTeam: true,
        });
        return { valid: true, cached: false, tier: 'team', teamRole: data.team_role || null };
      }
      await chrome.storage.local.set({ licenseValid: false });
      return { valid: false, cached: false, tier: null, reason: data.reason || null, deviceLimit: data.deviceLimit || null };
    } catch {
      return { valid: false, cached: false, tier: null };
    }
  }

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
    const deviceId = await getDeviceId();
    const normEmail = (email || '').trim().toLowerCase();
    const resp = await fetch(VALIDATION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: trimmedKey, email: normEmail, deviceId }),
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
    return { valid: false, cached: false, tier: null, reason: data.reason || null, deviceLimit: data.deviceLimit || null };
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
  const licenseCheck = await chrome.storage.local.get(['licenseValid', 'licenseKey', 'licenseTier']);
  // A stored key + tier counts as "activated" too — a logged-in user (even with a
  // stale/offline licenseValid) sees their plan, not the bare Activate screen.
  const isActivated = licenseCheck.licenseValid || (licenseCheck.licenseKey && licenseCheck.licenseTier);
  if (!isActivated) {
    document.getElementById('activation-screen').style.display = 'flex';
    Array.from(document.body.children).forEach(el => {
      if (el.id !== 'activation-screen') el.style.display = 'none';
    });
    const activationBtn    = document.getElementById('activation-activate-btn');
    const activationInput  = document.getElementById('activation-key-input');
    const activationStatus = document.getElementById('activation-status');
    const activationEmailWrap  = document.getElementById('activation-email-wrap');
    const activationEmailInput = document.getElementById('activation-email-input');
    // Email now required for ALL plans — show the field unconditionally on load.
    function revealEmail(msg) {
      if (activationEmailWrap) activationEmailWrap.style.display = 'block';
      if (msg) { activationStatus.textContent = msg; activationStatus.style.color = '#ff9500'; }
    }
    revealEmail('');
    async function attemptActivation() {
      const key = activationInput.value.trim();
      if (!key) { activationStatus.textContent = 'Please enter a license key.'; return; }
      const email = activationEmailInput ? activationEmailInput.value.trim() : '';
      // Email now required for ALL plans (not just team keys).
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { revealEmail('Please enter a valid email address'); return; }
      activationBtn.textContent = 'Checking...';
      activationBtn.disabled = true;
      activationStatus.style.color = '#ff3b30';
      activationStatus.textContent = '';
      const result = await validateLicenseKey(key, true, email);
      if (result.valid) {
        window.location.reload();
      } else {
        activationBtn.textContent = 'Activate';
        activationBtn.disabled = false;
        // Self-correct: a team key pasted into the normal flow → reveal email, retry.
        if (result.reason === 'use_team_validation' || result.reason === 'missing_email') {
          revealEmail(result.reason === 'missing_email'
            ? 'Email required for team activation'
            : 'This is a team key — please enter your email');
          return;
        }
        if (isTeamKey(key)) {
          activationStatus.textContent = teamReasonText(result.reason, result.deviceLimit);
        } else {
          activationStatus.textContent = result.reason === 'device_limit'
            ? `This license is already active on ${result.deviceLimit || 3} devices. Contact support@laneiq.org to reset a device.`
            : 'Invalid key — check your key and try again.';
        }
      }
    }
    activationBtn.addEventListener('click', attemptActivation);
    activationInput.addEventListener('keydown', e => { if (e.key === 'Enter') attemptActivation(); });
    activationEmailInput?.addEventListener('keydown', e => { if (e.key === 'Enter') attemptActivation(); });
    return;
  }

  // Silent background re-validation
  (async function silentRevalidate() {
    try {
      const { licenseKey, teamEmail } = await chrome.storage.local.get(['licenseKey', 'teamEmail']);
      if (!licenseKey) return;
      const deviceId = await getDeviceId();

      // Team keys must revalidate against /validate-team (the plain /validate
      // now rejects them with use_team_validation, which would loop a reload).
      if (isTeamKey(licenseKey)) {
        if (!teamEmail) return; // can't team-validate without the seat email; leave install alone
        const resp = await fetch(TEAM_VALIDATION_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: licenseKey, email: teamEmail, deviceId }),
        });
        if (!resp.ok) return;
        const data = await resp.json();
        if (!data.valid) {
          if (data.reason === 'device_limit') return; // soft-degrade, same as solo/pro
          await chrome.storage.local.set({ licenseValid: false });
          window.location.reload();
        }
        return; // team keys carry no tier/useDB drift to reconcile
      }

      const resp = await fetch(VALIDATION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: licenseKey, deviceId }),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data.valid) {
        // Soft-degrade: never kill an already-working install over a device-limit
        // response (this device is normally already registered anyway).
        if (data.reason === 'device_limit') return;
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

  // ── License key ───────────────────────────────────────────────────────────────
  const licenseInput  = document.getElementById('licenseInput');
  const licenseStatus = document.getElementById('licenseStatus');

  if (licenseInput && licenseStatus) {
    const saved = await chrome.storage.local.get(['licenseKey', 'licenseValid', 'licenseCheckedAt', 'licenseTier', 'teamEmail']);
    if (saved.licenseKey) {
      licenseInput.style.display = 'none';
      const maskedKey = saved.licenseKey.slice(0, 8) + '••••••••';
      const planLabel = saved.licenseTier === 'team' ? 'Team plan' : saved.licenseTier === 'pro' ? 'Pro' : 'Solo';
      const teamSuffix = (saved.licenseTier === 'team' && saved.teamEmail) ? ' · ' + saved.teamEmail : '';
      const age   = saved.licenseCheckedAt ? Date.now() - new Date(saved.licenseCheckedAt).getTime() : Infinity;
      const fresh = age < LICENSE_GRACE_MS;
      if (saved.licenseValid && fresh) {
        licenseStatus.textContent = `✓ Active — ${planLabel}${teamSuffix} · ${maskedKey}`;
        licenseStatus.className = 'gmail-status set';
        document.getElementById('manageSubBtn').style.display = 'inline-block';
      } else if (saved.licenseValid && !fresh) {
        licenseStatus.textContent = `⚠ ${planLabel} cached (${maskedKey}) — reconnect to verify`;
        licenseStatus.className = 'gmail-status unset';
      } else {
        licenseStatus.textContent = `✗ License invalid — ${maskedKey}`;
        licenseStatus.className = 'gmail-status unset';
      }
    }

    document.getElementById('manageSubBtn').addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://billing.stripe.com/p/login/7sY9AScHv3lMaKY2GZ5EY00' });
    });

    document.getElementById('licenseLogout').addEventListener('click', async () => {
      await chrome.storage.local.remove(['licenseKey', 'licenseValid', 'licenseCheckedAt', 'licenseTier', 'useCSV', 'useDB', 'teamId', 'teamEmail', 'teamRole', 'seatLimit', 'seatsUsed', 'useTeam']);
      window.location.reload();
    });

  }

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

// Bump this when normKey or index key format changes — forces a re-upload prompt
// on any stored index that was built with an older format.
const INDEX_VERSION = 2;

// ─── License key validation ───────────────────────────────────────────────────
// Replace this URL with your Railway deployment URL after deploying the backend.
const VALIDATION_URL = 'https://laneiq-backend-production.up.railway.app/validate';
const LICENSE_GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Returns { valid: bool, cached: bool }
// Exported for testing (CommonJS-safe: no-op if module is undefined).
async function validateLicenseKey(key, forceRefresh = false) {
  if (!key || typeof key !== 'string' || !key.trim()) {
    return { valid: false, cached: false };
  }
  const trimmedKey = key.trim();

  // Check grace period cache first (skipped on manual activation)
  const stored = await chrome.storage.local.get(['licenseKey', 'licenseValid', 'licenseCheckedAt', 'licenseTier']);
  const cachedKey = stored.licenseKey;
  const cachedValid = stored.licenseValid;
  const checkedAt = stored.licenseCheckedAt;

  if (!forceRefresh && cachedKey === trimmedKey && cachedValid && checkedAt) {
    const age = Date.now() - new Date(checkedAt).getTime();
    if (age < LICENSE_GRACE_MS) {
      return { valid: true, cached: true, tier: stored.licenseTier || 'solo' };
    }
  }

  // Cache expired or missing — call backend
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
    // Invalid key — clear cache
    await chrome.storage.local.set({ licenseValid: false });
    return { valid: false, cached: false, tier: null };
  } catch {
    // Network error — fail open only if we have a fresh (within grace period) valid cache
    if (cachedKey === trimmedKey && cachedValid && checkedAt) {
      const age = Date.now() - new Date(checkedAt).getTime();
      if (age < LICENSE_GRACE_MS) return { valid: true, cached: true, tier: stored.licenseTier || 'solo' };
    }
    return { valid: false, cached: false, tier: null };
  }
}
// exports assembled at bottom of file

// ─── CSV Parser ───────────────────────────────────────────────────────────────
function parseCSV(text) {
  // Split into logical rows respecting quoted fields that contain embedded newlines.
  // A bare \n inside a quoted field is part of the value, not a row boundary.
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const logicalLines = [];
  let cur = '', inQ = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') { inQ = !inQ; cur += ch; }
    else if (ch === '\n' && !inQ) { logicalLines.push(cur); cur = ''; }
    else { cur += ch; }
  }
  if (cur) logicalLines.push(cur);

  if (logicalLines.length < 2) return [];
  const headers = splitLine(logicalLines[0]).map(h => h.replace(/"/g,'').trim());
  const rows = [];
  for (let i = 1; i < logicalLines.length; i++) {
    const line = logicalLines[i].trim();
    if (!line) continue;
    const vals = splitLine(line);
    const row = {};
    headers.forEach((h, j) => row[h] = (vals[j]||'').replace(/^"|"$/g,'').trim());
    rows.push(row);
  }
  return rows;
}
function splitLine(line) {
  const vals = []; let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { vals.push(cur); cur = ''; }
    else cur += ch;
  }
  vals.push(cur); return vals;
}

// ─── Normalize ────────────────────────────────────────────────────────────────
function norm(raw) {
  if (!raw) return '';
  return String(raw).toLowerCase()
    .replace(/\bmt\b/g,   'mount')
    .replace(/\bmtn\b/g,  'mountain')
    .replace(/\bft\b/g,   'fort')
    .replace(/\bpt\b/g,   'point')
    .replace(/\blk\b/g,   'lake')
    .replace(/\bcyn\b/g,  'canyon')
    .replace(/\bvly\b/g,  'valley')
    .replace(/\bbch\b/g,  'beach')
    .replace(/\bhls\b/g,  'hills')
    .replace(/\bhts\b/g,  'heights')
    .replace(/\bhgts\b/g, 'heights')
    .replace(/\bspgs\b/g, 'springs')
    .replace(/\bspg\b/g,  'spring')
    .replace(/\bvlg\b/g,  'village')
    .replace(/\bjct\b/g,   'junction')
    .replace(/\bst\.?\b/g, 'saint')
    .replace(/\bfrncsco\b/g,'francisco')
    .replace(/\b(ca|fl|tx|pa|nv|ga|nc|va|ct|mi|in|oh|mo|co|az|or|ut|wa|mn|ne|ks|sc|al|ms|la|ar|ky|tn|wv|md|nj|ny|ma|ri|nh|vt|me|de|nm|id|mt|wy|sd|nd|ok|ia|il|ak|hi|dc|wi)\b/g,'')
    .replace(/\d+/g,'').replace(/[^a-z\s]/g,' ').replace(/\s+/g,' ').trim()
    .replace(/^[nsew] /,'');
}

// Extract state abbreviation from a raw city string e.g. "Charlotte, NC" → "nc"
// Handles zip codes: "Charlotte, NC 28202" → "nc"
function getState(raw) {
  const clean = String(raw).replace(/\b\d{5}(-\d{4})?\s*$/, '').trim();
  const m = clean.match(/([A-Z]{2})\s*$/);
  return m ? m[1].toLowerCase() : '';
}

// Build an index key that normalizes the city name but preserves the state so
// that "Columbia, MO" and "Columbia, PA" land in separate index buckets.
// e.g. "S San Frncsco, CA" → "san francisco, ca"
// Handles zip codes: "San Francisco, CA 94124" → "san francisco, ca"
function normKey(raw) {
  // Strip everything after the state abbreviation (zip codes, badge text, etc.)
  // so "City, ST 12345" and "City, ST" produce the same key.
  const clean = String(raw).replace(/(,\s*[A-Za-z]{2})\b.*$/, '$1').trim();
  // Extract state case-insensitively (CSV may emit "MO", "mo", or "Mo")
  const stMatch = clean.match(/([A-Za-z]{2})\s*$/);
  const st   = stMatch ? stMatch[1].toLowerCase() : '';
  const city = norm(clean);
  return st ? city + ', ' + st : city;
}

// ─── Build indexes from rows ──────────────────────────────────────────────────
// IMPORTANT: we only store the indexes — NOT the raw rows array.
// This halves storage usage and fixes the 5MB overflow.
// Each record inside the index carries its fileIdx so we can remove by file later.
// Normalize broker name for fuzzy matching
function normBroker(raw) {
  if (!raw || raw === 'nan') return '';
  return String(raw).toLowerCase()
    .replace(/logistics|transport|brokerage|freight|group|inc|llc|corp|co/gi, '')
    .replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildIndexesFromRows(rows, fileIdx) {
  const odIndex = {}, oIndex = {}, brokerIndex = {};
  let count = 0;

  for (const row of rows) {
    const origin  = (row['Origin']           || row['PickCity']        || row['Pick City']       ||
                     row['Origin City']     || row['From City']        || row['Shipper City']     || '').trim();
    const dest    = (row['Destination']      || row['DropCity']        || row['Drop City']        ||
                     row['Destination City'] || row['To City']         || row['Consignee City']   || '').trim();
    const rateRaw = (row['Rate'] || row['Total'] || row['Gross'] || row['Revenue'] ||
                     row['Total Rate'] || row['All In'] || row['All-In'] ||
                     row['Pay'] || row['Line Haul'] || row['Linehaul'] || '').trim();
    // Strip $ and whitespace, then handle multi-dot formats like "$4.000.00"
    // (European thousands separator) by removing all dots except the last one.
    let rateClean = rateRaw.replace(/[$\s]/g, '');
    if ((rateClean.match(/\./g) || []).length > 1) rateClean = rateClean.replace(/\.(?=.*\.)/g, '');
    rateClean = rateClean.replace(/,/g, '');
    const rateParsed = parseFloat(rateClean);
    const rate       = isNaN(rateParsed) ? '' : String(rateParsed);
    const loadNum = (row['Load #']      || '').trim();
    const puDate  = (row['PU Date']     || '').trim();
    const weight  = (row['Weight / Pallets / FT'] || row['Weight \\ pallet count \\ FT'] || row['Weight'] || '').trim();

    if (!origin || origin.length < 2) continue;

    const broker        = (row['Broker'] || row['Broker company name'] || '').trim();
    const pickupCompany   = (row['Pickup Company + Full Address']   || row['Pickup company + full address']   || '').trim();
    const deliveryCompany = (row['Delivery Company + Full Address'] || row['Delivery company + full address'] || '').trim();
    const commodity       = (row['Commodity'] || '').trim();
    const record = { origin, destination: dest, puDate, rate, loadNum, weight, broker, pickupCompany, deliveryCompany, commodity, _f: fileIdx };
    count++;

    const no = normKey(origin);
    const nd = normKey(dest);

    if (no && nd) {
      const key = no + '|' + nd;
      if (!odIndex[key]) odIndex[key] = [];
      odIndex[key].push(record);
    }
    if (no) {
      if (!oIndex[no]) oIndex[no] = [];
      oIndex[no].push(record);
    }
    // Broker index — normalized broker name → records
    const nb = normBroker(broker);
    if (nb) {
      if (!brokerIndex[nb]) brokerIndex[nb] = [];
      brokerIndex[nb].push(record);
    }
  }
  return { odIndex, oIndex, brokerIndex, count };
}

// Merge two index objects together
// Merge two flat index objects {key: [records]}
function mergeIndexes(base, incoming) {
  const out = { ...base };
  for (const [key, recs] of Object.entries(incoming || {})) {
    if (!out[key]) out[key] = [];
    out[key] = out[key].concat(recs);
  }
  return out;
}

// Remove all records belonging to a fileIdx from an index
function removeFromIndex(index, fileIdx) {
  const out = {};
  for (const [key, recs] of Object.entries(index || {})) {
    if (!Array.isArray(recs)) continue;
    const filtered = recs.filter(r => r._f !== fileIdx);
    if (filtered.length) out[key] = filtered;
  }
  return out;
}

// Re-index file numbers after a removal
function reIndexFiles(index, removedIdx) {
  const out = {};
  for (const [key, recs] of Object.entries(index)) {
    out[key] = recs.map(r => ({
      ...r,
      _f: r._f > removedIdx ? r._f - 1 : r._f
    }));
  }
  return out;
}

function countFromIndex(odIndex) {
  let n = 0;
  const seen = new Set();
  for (const recs of Object.values(odIndex)) {
    for (const r of recs) {
      const k = r.loadNum || (r.origin + '|' + (r.destination || '') + '|' + r.puDate);
      if (!seen.has(k)) { seen.add(k); n++; }
    }
  }
  return n;
}

// ─── Storage quota check ─────────────────────────────────────────────────────
// Returns a warning string if storage is >= 90% full, null otherwise.
// Exported for testing (CommonJS-safe: no-op if module is undefined).
async function getStorageQuotaWarning() {
  try {
    const used = await chrome.storage.local.getBytesInUse(null);
    const quota = chrome.storage.local.QUOTA_BYTES || 10 * 1024 * 1024;
    const pct = used / quota;
    if (pct >= 0.95) return 'Storage full — remove an existing file before uploading more.';
    if (pct >= 0.90) return `Storage is ${Math.round(pct * 100)}% full — remove an older file before uploading to avoid data loss.`;
    return null;
  } catch {
    return null; // getBytesInUse unavailable (e.g. in tests without Chrome API) — proceed
  }
}
// exports assembled at bottom of file

// ─── UI helpers ───────────────────────────────────────────────────────────────
function showError(msg) {
  const el = document.getElementById('errorMsg');
  el.textContent = msg; el.style.display = 'block';
}
function setProgress(pct, text) {
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressText').textContent = text;
}
function updateStatus(count, fileCount) {
  document.getElementById('statusBox').className = 'status-box loaded';
  document.getElementById('statusVal').textContent = `${count.toLocaleString()} lanes loaded ✓`;
  document.getElementById('statusSub').textContent = `${fileCount} file${fileCount>1?'s':''} · Ready — open DAT now`;
}

function renderFileList(files) {
  const list = document.getElementById('file-list');
  list.innerHTML = files.map((f, i) => `
    <div class="file-item">
      <span class="file-name">📄 ${f.name}</span>
      <span class="file-count">${f.count.toLocaleString()} lanes</span>
      <button class="file-remove" data-idx="${i}">✕</button>
    </div>`).join('');

  list.querySelectorAll('.file-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.idx);
      const stored = await chrome.storage.local.get(['filesMeta','odIndex','oIndex','brokerIndex']);
      let meta    = stored.filesMeta    || [];
      let odIdx   = stored.odIndex      || {};
      let oIdx    = stored.oIndex       || {};
      let brkIdx  = stored.brokerIndex  || {};

      // Remove records from indexes
      odIdx  = removeFromIndex(odIdx,  idx);
      oIdx   = removeFromIndex(oIdx,   idx);
      brkIdx = removeFromIndex(brkIdx, idx);

      // Re-number remaining file indexes
      odIdx  = reIndexFiles(odIdx,  idx);
      oIdx   = reIndexFiles(oIdx,   idx);
      brkIdx = reIndexFiles(brkIdx, idx);

      const newMeta = meta.filter((_, i) => i !== idx);
      const count   = countFromIndex(odIdx);

      await chrome.storage.local.set({ filesMeta: newMeta, odIndex: odIdx, oIndex: oIdx, brokerIndex: brkIdx, laneCount: count, indexVersion: INDEX_VERSION });
      renderFileList(newMeta);

      if (!newMeta.length) {
        document.getElementById('statusVal').textContent = 'No data loaded';
        document.getElementById('statusSub').textContent = 'Add one or more CSV files below';
        document.getElementById('statusBox').className = 'status-box';
      } else {
        updateStatus(count, newMeta.length);
      }
    });
  });
}

// ─── Account selector ─────────────────────────────────────────────────────────
function setActiveBtn(idx) {
  document.querySelectorAll('#acctBtns .acct-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.idx) === idx);
  });
}
function updateGmailStatus(email, idx) {
  const el = document.getElementById('gmailStatus');
  if (email) {
    el.textContent = `✓ ${email} · Account #${idx}`;
    el.className = 'gmail-status set';
  } else {
    el.textContent = 'Not configured yet';
    el.className = 'gmail-status unset';
  }
}

// ─── Exports (for unit testing in Node) ──────────────────────────────────────
if (typeof module !== 'undefined') module.exports = { getStorageQuotaWarning, validateLicenseKey };

// ─── Main ─────────────────────────────────────────────────────────────────────
if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', async () => {
  // --- Activation screen gate ---
  const licenseCheck = await chrome.storage.local.get(['licenseValid']);
  if (!licenseCheck.licenseValid) {
    document.getElementById('activation-screen').style.display = 'flex';
    Array.from(document.body.children).forEach(el => {
      if (el.id !== 'activation-screen') el.style.display = 'none';
    });
    const activationBtn = document.getElementById('activation-activate-btn');
    const activationInput = document.getElementById('activation-key-input');
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

  // Silent background re-validation — fires after gate passes, does not block UI.
  (async function silentRevalidate() {
    try {
      const { licenseKey } = await chrome.storage.local.get(['licenseKey']);
      if (!licenseKey) return;
      const resp = await fetch(VALIDATION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: licenseKey }),
      });
      if (!resp.ok) return; // server/network error — fail open, don't punish user
      const data = await resp.json();
      if (!data.valid) {
        await chrome.storage.local.set({ licenseValid: false });
        window.location.reload();
        return;
      }
      // Key still valid — sync tier and useDB if backend says they changed
      const { licenseTier: storedTier, useDB: storedUseDB } =
        await chrome.storage.local.get(['licenseTier', 'useDB']);
      const backendTier = data.tier || 'solo';
      const updates = {};
      if (storedTier !== backendTier) updates.licenseTier = backendTier;
      if (backendTier !== 'pro' && storedUseDB) updates.useDB = false;
      if (Object.keys(updates).length) await chrome.storage.local.set(updates);
    } catch {
      // Network failure — fail open, never block a paying customer over connectivity
    }
  })();

  // Show loading state immediately while we wait for storage
  document.getElementById('statusBox').className = 'status-box loading';
  document.getElementById('statusVal').textContent = 'Loading…';
  document.getElementById('statusSub').textContent = 'Reading saved data';

  const stored = await chrome.storage.local.get(['laneCount','filesMeta','gmailEmail','gmailIndex','senderEmail','senderGmailIndex','emailTemplate','userName','userCompany','mapsApiKey','emailSubject','odIndex','indexVersion','licenseTier','useCSV','useDB']);

  // ── Version check — clear index if it was built with an older normKey ────────
  const SETTINGS_KEYS = ['gmailEmail','gmailIndex','senderEmail','senderGmailIndex','emailTemplate','userName','userCompany','mapsApiKey','emailSubject'];
  async function clearIndexKeepSettings(reason) {
    console.warn('[LaneIQ] ⚠ Clearing stale index:', reason);
    const keep = await chrome.storage.local.get(SETTINGS_KEYS);
    await chrome.storage.local.clear();
    if (Object.keys(keep).length) await chrome.storage.local.set(keep);
    document.getElementById('statusBox').className = 'status-box';
    document.getElementById('statusVal').textContent = '⚠ Index format changed — re-upload your CSV files';
    document.getElementById('statusSub').textContent = reason;
    document.getElementById('file-list').innerHTML = '';
  }

  if (stored.laneCount && stored.indexVersion !== INDEX_VERSION) {
    await clearIndexKeepSettings('Key format updated (city+state) — previous index used city-only keys');
  } else if (stored.odIndex) {
    // ── Detect stale index built from company names instead of city names ──────
    const sample = Object.keys(stored.odIndex).slice(0, 5);
    const badCount = sample.filter(k => k.split('|')[0].trim().split(/\s+/).length > 3).length;
    if (badCount >= 2) {
      await clearIndexKeepSettings('Previous index had company names instead of cities');
    } else {
      // Index format OK
      updateStatus(stored.laneCount, stored.filesMeta.length);
      renderFileList(stored.filesMeta);
    }
  } else if (stored.laneCount && stored.filesMeta) {
    updateStatus(stored.laneCount, stored.filesMeta.length);
    renderFileList(stored.filesMeta);
  } else {
    document.getElementById('statusBox').className = 'status-box';
    document.getElementById('statusVal').textContent = 'No data loaded';
    document.getElementById('statusSub').textContent = 'Add one or more CSV files below';
  }

  // ── Sender email setting ──────────────────────────────────────────────────
  const senderInput  = document.getElementById('senderInput');
  const senderStatus = document.getElementById('senderStatus');

  if (stored.senderEmail) {
    senderInput.value = stored.senderEmail;
    senderStatus.textContent = `✓ Sending from: ${stored.senderEmail}`;
    senderStatus.className = 'gmail-status set';
  }

    // ── Sender account buttons ──────────────────────────────────────────────────
  const senderAcctBtns = document.getElementById('senderAcctBtns');
  let senderIdx = stored.senderGmailIndex !== undefined ? stored.senderGmailIndex : 0;

  function setSenderBtn(idx) {
    if (!senderAcctBtns) return;
    senderAcctBtns.querySelectorAll('.acct-btn').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.idx) === idx);
    });
  }
  setSenderBtn(senderIdx);

  if (senderAcctBtns) {
    senderAcctBtns.addEventListener('click', async e => {
      if (!e.target.classList.contains('acct-btn')) return;
      senderIdx = parseInt(e.target.dataset.idx);
      setSenderBtn(senderIdx);
      await chrome.storage.local.set({ senderGmailIndex: senderIdx });
      const email = senderInput.value.trim();
      if (email) {
        senderStatus.textContent = `✓ Account #${senderIdx} · ${email}`;
        senderStatus.className = 'gmail-status set';
      }
    });
  }

  document.getElementById('senderSave').addEventListener('click', async () => {
    const raw = senderInput.value.trim();
    // Accept Gmail URL — auto extract account number
    const urlMatch = raw.match(/mail\.google\.com\/mail\/u\/(\d+)/);
    if (urlMatch) {
      senderIdx = parseInt(urlMatch[1]);
      setSenderBtn(senderIdx);
      await chrome.storage.local.set({ senderEmail: `Account #${senderIdx}`, senderGmailIndex: senderIdx });
      senderStatus.textContent = `✓ Outbound: Gmail Account #${senderIdx}`;
      senderStatus.className = 'gmail-status set';
      senderInput.value = '';
      senderInput.placeholder = `Account #${senderIdx} saved ✓`;
      return;
    }
    if (!raw || !raw.includes('@')) {
      senderStatus.textContent = 'Paste your Gmail URL or enter email.';
      senderStatus.className = 'gmail-status unset';
      return;
    }
    await chrome.storage.local.set({ senderEmail: raw, senderGmailIndex: senderIdx });
    senderStatus.textContent = `✓ Account #${senderIdx} · ${raw}`;
    senderStatus.className = 'gmail-status set';
  });

  // ── Your Info (name + company) ─────────────────────────────────────────────
  const userNameInput    = document.getElementById('userNameInput');
  const userCompanyInput = document.getElementById('userCompanyInput');
  const userInfoStatus   = document.getElementById('userInfoStatus');

  if (stored.userName)    userNameInput.value    = stored.userName;
  if (stored.userCompany) userCompanyInput.value = stored.userCompany;
  if (stored.userName || stored.userCompany) {
    userInfoStatus.textContent = `✓ ${stored.userName || ''} · ${stored.userCompany || ''}`.replace(/· $|^· /, '').trim();
    userInfoStatus.className = 'gmail-status set';
  }

  document.getElementById('userInfoSave').addEventListener('click', async () => {
    const name    = userNameInput.value.trim();
    const company = userCompanyInput.value.trim();
    await chrome.storage.local.set({ userName: name, userCompany: company });
    userInfoStatus.textContent = `✓ ${name}${name && company ? ' · ' : ''}${company}` || '✓ Saved';
    userInfoStatus.className = 'gmail-status set';
  });

  // ── Email template setting ─────────────────────────────────────────────────
  const DEFAULT_SUBJECT  = 'Load Inquiry – {origin} → {destination}';
  const DEFAULT_TEMPLATE = `Hi,

This is {name} with {company}. Please tell me more about your load from {origin}, pickup on {date}, going to {destination}, posted on DAT today.

Thanks,
{name}
{company}`;

  const subjectInput   = document.getElementById('subjectInput');
  const templateInput  = document.getElementById('templateInput');
  const templateStatus = document.getElementById('templateStatus');

  subjectInput.value  = stored.emailSubject  || DEFAULT_SUBJECT;
  templateInput.value = stored.emailTemplate || DEFAULT_TEMPLATE;
  if (stored.emailTemplate) {
    templateStatus.textContent = '✓ Custom template saved';
    templateStatus.className = 'gmail-status set';
  }

  if (stored.emailSubject && !stored.emailSubject.includes('{origin}')) {
    subjectInput.value  = DEFAULT_SUBJECT;
    templateInput.value = DEFAULT_TEMPLATE;
    await chrome.storage.local.set({ emailSubject: DEFAULT_SUBJECT, emailTemplate: DEFAULT_TEMPLATE });
    templateStatus.textContent = 'Template reset to default';
    templateStatus.className = 'gmail-status unset';
  }

  document.getElementById('templateSave').addEventListener('click', async () => {
    const subj = subjectInput.value.trim() || DEFAULT_SUBJECT;
    const tmpl = templateInput.value.trim();
    if (!tmpl) return;
    await chrome.storage.local.set({ emailSubject: subj, emailTemplate: tmpl });
    templateStatus.textContent = '✓ Template saved';
    templateStatus.className = 'gmail-status set';
  });

  // Gmail settings
  const savedEmail = stored.gmailEmail || '';
  const savedIdx   = stored.gmailIndex !== undefined ? stored.gmailIndex : null;
  if (savedEmail) document.getElementById('gmailInput').value = savedEmail;
  if (savedIdx !== null) setActiveBtn(savedIdx);
  updateGmailStatus(savedEmail, savedIdx);

  // Gmail save
  document.getElementById('gmailSave').addEventListener('click', async () => {
    const raw = document.getElementById('gmailInput').value.trim();
    document.getElementById('errorMsg').style.display = 'none';

    // Accept full Gmail URL — extract account number automatically
    const urlMatch = raw.match(/mail\.google\.com\/mail\/u\/(\d+)/);
    if (urlMatch) {
      const idx = parseInt(urlMatch[1]);
      setActiveBtn(idx);
      await chrome.storage.local.set({ gmailEmail: 'Account #' + idx, gmailIndex: idx });
      updateGmailStatus('Gmail Account #' + idx, idx);
      document.getElementById('gmailInput').value = '';
      document.getElementById('gmailInput').placeholder = 'Account #' + idx + ' saved ✓';
      return;
    }

    // Accept plain email address
    const activeBtn = document.querySelector('.acct-btn.active');
    const idx = activeBtn ? parseInt(activeBtn.dataset.idx) : null;
    if (!raw) { showError('Paste your Gmail URL or enter your email.'); return; }
    if (!raw.includes('@') && idx === null) { showError('Paste your Gmail URL (e.g. mail.google.com/mail/u/4/)'); return; }
    const finalIdx = idx !== null ? idx : 0;
    await chrome.storage.local.set({ gmailEmail: raw, gmailIndex: finalIdx });
    updateGmailStatus(raw, finalIdx);
  });

  // Account buttons — tap to switch account instantly
  document.getElementById('acctBtns').addEventListener('click', async e => {
    if (!e.target.classList.contains('acct-btn')) return;
    const idx = parseInt(e.target.dataset.idx);
    setActiveBtn(idx);
    const stored = await chrome.storage.local.get('gmailEmail');
    if (stored.gmailEmail) {
      await chrome.storage.local.set({ gmailIndex: idx });
      updateGmailStatus(stored.gmailEmail, idx);
    }
  });

  // File handling
  document.getElementById('csvHelpToggle').addEventListener('click', () => {
    const note = document.getElementById('csvHelpNote');
    note.style.display = note.style.display === 'none' ? 'block' : 'none';
    chrome.runtime.sendMessage({ type: 'openWithHash', baseUrl: 'https://laneiq.org', hash: '#prepare' });
  });

  document.getElementById('howItWorksLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.sendMessage({ type: 'openWithHash', baseUrl: 'https://laneiq.org', hash: '#how' });
  });

  const dropZone  = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const progress  = document.getElementById('progress');

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag');
    processFiles(Array.from(e.dataTransfer.files));
  });
  fileInput.addEventListener('change', e => processFiles(Array.from(e.target.files)));

  // ── Maps API Key ─────────────────────────────────────────────────────────
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

  document.getElementById('clearBtn').addEventListener('click', async () => {
    const keep = await chrome.storage.local.get(['gmailEmail','gmailIndex','senderEmail','senderGmailIndex','emailTemplate','userName','userCompany','mapsApiKey','emailSubject']);
    await chrome.storage.local.clear();
    const toRestore = Object.fromEntries(Object.entries(keep).filter(([,v]) => v !== undefined));
    if (Object.keys(toRestore).length) await chrome.storage.local.set(toRestore);
    document.getElementById('statusVal').textContent = 'No data loaded';
    document.getElementById('statusSub').textContent = 'Add one or more CSV files below';
    document.getElementById('statusBox').className = 'status-box';
    document.getElementById('file-list').innerHTML = '';
    document.getElementById('errorMsg').style.display = 'none';
  });

  document.getElementById('reloadBtn').addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ url: '*://*.dat.com/*' });
    tabs.forEach(t => chrome.tabs.reload(t.id));
    window.close();
  });

  document.getElementById('setupHelpLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html?screen=2') });
  });

  // ── Process CSV files ────────────────────────────────────────────────────────
  async function processFiles(newFiles) {
    if (!newFiles.length) return;
    const csvFiles = newFiles.filter(f => f.name.endsWith('.csv'));

    // Quota check — warn before writing, not after a partial write failure
    const quotaWarning = await getStorageQuotaWarning();
    if (quotaWarning) {
      showError(quotaWarning);
      return;
    }
    if (!csvFiles.length) { showError('Please upload CSV files only.'); return; }
    document.getElementById('errorMsg').style.display = 'none';
    const statusBox = document.getElementById('statusBox');
    statusBox.style.cssText = '';
    document.getElementById('statusVal').style.color = '';
    document.getElementById('statusSub').style.color = '';
    progress.style.display = 'block';
    setProgress(5, 'Loading existing indexes...');

    try {
      const stored = await chrome.storage.local.get(['filesMeta','odIndex','oIndex','brokerIndex','laneCount']);
      let existingMeta   = stored.filesMeta   || [];
      let existingOD     = stored.odIndex     || {};
      let existingO      = stored.oIndex      || {};
      let existingBroker = stored.brokerIndex || {};
      const startIdx    = existingMeta.length;

      const duplicate = csvFiles.find(f => existingMeta.some(m => m.name === f.name));
      if (duplicate) {
        progress.style.display = 'none';
        const box = document.getElementById('statusBox');
        const val = document.getElementById('statusVal');
        const sub = document.getElementById('statusSub');
        box.className = 'status-box';
        box.style.cssText = 'border-color:#dc2626;background:rgba(239,68,68,.07)';
        val.style.color = '#f87171';
        val.textContent = '⚠ Already uploaded';
        sub.style.color = '#f87171';
        sub.textContent = `"${duplicate.name}" is already loaded — remove it first to re-upload.`;
        return;
      }

      const newMeta = [];

      for (let i = 0; i < csvFiles.length; i++) {
        const file    = csvFiles[i];
        const fileIdx = startIdx + i;

        setProgress(15 + Math.round((i / csvFiles.length) * 50), `Parsing ${file.name}...`);

        const text = await file.text();
        const rows = parseCSV(text);

        setProgress(15 + Math.round(((i + 0.5) / csvFiles.length) * 50), `Indexing ${file.name}...`);

        const { odIndex: newOD, oIndex: newO, brokerIndex: newBroker, count } = buildIndexesFromRows(rows, fileIdx);

        if (count === 0) {
          progress.style.display = 'none';
          showError(`No lanes found in "${file.name}". Origin column not found — expected "Origin", "PickCity", "Pick City", "Origin City", "From City", or "Shipper City". Destination: "Destination", "DropCity", "Drop City", "Destination City", "To City", or "Consignee City".`);
          return;
        }

        // Merge into existing indexes
        existingOD     = mergeIndexes(existingOD,     newOD     || {});
        existingO      = mergeIndexes(existingO,      newO      || {});
        existingBroker = mergeIndexes(existingBroker, newBroker || {});

        newMeta.push({ name: file.name, count });
      }

      setProgress(75, 'Counting total lanes...');
      const combinedMeta = existingMeta.concat(newMeta);
      const totalCount   = combinedMeta.reduce((sum, f) => sum + f.count, 0);

      setProgress(88, 'Saving to storage...');
      try {
        await chrome.storage.local.set({
          filesMeta:    combinedMeta,
          odIndex:      existingOD,
          oIndex:       existingO,
          brokerIndex:  existingBroker,
          laneCount:    totalCount,
          indexVersion: INDEX_VERSION,
          loadedAt:     new Date().toISOString(),
        });
      } catch (storageErr) {
        progress.style.display = 'none';
        showError('Storage full — try removing an existing file first, then re-upload.');
        return;
      }

      setProgress(100, `Done! ${totalCount.toLocaleString()} lanes ready`);
      updateStatus(totalCount, combinedMeta.length);
      renderFileList(combinedMeta);
      setTimeout(() => { progress.style.display = 'none'; }, 1500);

    } catch(err) {
      console.error('[DATMatcher]', err);
      showError('Error: ' + err.message);
      progress.style.display = 'none';
    }
  }

  // ── Data source toggles (Pro only) ───────────────────────────────────────────
  const dataSourceSection = document.getElementById('dataSourceSection');
  const useCSVToggle = document.getElementById('useCSVToggle');
  const useDBToggle  = document.getElementById('useDBToggle');

  function applyDataSource(useCSV, useDB) {
    const status = document.getElementById('dataSourceStatus');
    if (useCSV && useDB)  status.textContent = 'Both sources active — CSV takes priority';
    else if (useCSV)      status.textContent = 'My CSV — your own freight history';
    else if (useDB)       status.textContent = 'LaneIQ Database — market-wide rate data';
    else                  status.textContent = 'No data source selected';
  }

  chrome.storage.local.get(['useCSV', 'useDB'], stored => {
    const useCSV = stored.useCSV !== false;
    const useDB  = stored.useDB  === true;
    useCSVToggle.checked = useCSV;
    useDBToggle.checked  = useDB;
    applyDataSource(useCSV, useDB);
  });

  useCSVToggle.addEventListener('change', async () => {
    await chrome.storage.local.set({ useCSV: useCSVToggle.checked });
    applyDataSource(useCSVToggle.checked, useDBToggle.checked);
  });

  useDBToggle.addEventListener('change', async () => {
    const { licenseTier: currentTier } = await chrome.storage.local.get('licenseTier');
    if (currentTier !== 'pro') {
      useDBToggle.checked = false;
      document.getElementById('dataSourceStatus').textContent = '🔒 Pro feature — enter your license key above to unlock';
      document.getElementById('dataSourceStatus').style.color = '#F59E0B';
      return;
    }
    await chrome.storage.local.set({ useDB: useDBToggle.checked });
    applyDataSource(useCSVToggle.checked, useDBToggle.checked);
  });

  if (dataSourceSection) {
    dataSourceSection.style.display = 'block';
  }

  // ── License key ──────────────────────────────────────────────────────────────
  const licenseInput  = document.getElementById('licenseInput');
  const licenseStatus = document.getElementById('licenseStatus');
  const licenseSave   = document.getElementById('licenseSave');

  if (licenseInput && licenseSave && licenseStatus) {
    // Show current saved key (masked) and status
    const saved = await chrome.storage.local.get(['licenseKey', 'licenseValid', 'licenseCheckedAt']);
    if (saved.licenseKey) {
      licenseInput.placeholder = saved.licenseKey.slice(0, 8) + '••••••••';
      const age = saved.licenseCheckedAt ? Date.now() - new Date(saved.licenseCheckedAt).getTime() : Infinity;
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
        // Show data source toggles for Pro; default to LaneIQ DB on first activation
        if (tier === 'pro' && dataSourceSection) {
          const { useCSV: existingCSV, useDB: existingDB } = await chrome.storage.local.get(['useCSV', 'useDB']);
          if (existingCSV === undefined && existingDB === undefined) {
            await chrome.storage.local.set({ useCSV: false, useDB: true });
          }
          const useCSV = existingCSV === undefined ? false : !!existingCSV;
          const useDB  = existingDB  === undefined ? true  : !!existingDB;
          useCSVToggle.checked = useCSV;
          useDBToggle.checked  = useDB;
          applyDataSource(useCSV, useDB);
          dataSourceSection.style.display = 'block';
        }
      } else {
        licenseStatus.textContent = '✗ Invalid key — check your email or contact support';
        licenseStatus.className = 'gmail-status unset';
      }
    });
  }
});

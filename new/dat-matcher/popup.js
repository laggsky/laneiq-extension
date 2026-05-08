// Bump this when normKey or index key format changes — forces a re-upload prompt
// on any stored index that was built with an older format.
const INDEX_VERSION = 2;

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
function getState(raw) {
  const m = String(raw).match(/([A-Z]{2})\s*$/);
  return m ? m[1].toLowerCase() : '';
}

// Build an index key that normalizes the city name but preserves the state so
// that "Columbia, MO" and "Columbia, PA" land in separate index buckets.
// e.g. "S San Frncsco, CA" → "san francisco, ca"
function normKey(raw) {
  // Extract state case-insensitively (CSV may emit "MO", "mo", or "Mo")
  const stMatch = String(raw).match(/([A-Za-z]{2})\s*$/);
  const st   = stMatch ? stMatch[1].toLowerCase() : '';
  const city = norm(raw);       // normalize city (abbreviations, punctuation, etc.)
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

  // ── Debug: show exact column names and first 5 raw rate values ──────────────
  if (rows.length > 0) {
    console.log('[LaneIQ] CSV columns detected:', Object.keys(rows[0]));
    console.log('[LaneIQ] First 5 raw rows (rate check):',
      rows.slice(0, 5).map(r => ({
        'Load #':      r['Load #'],
        Origin:        r['Origin'],
        Destination:   r['Destination'],
        'PU Date':     r['PU Date'],
        Rate:          r['Rate'],
      }))
    );
  }

  for (const row of rows) {
    const origin  = (row['Origin']      || '').trim();
    const dest    = (row['Destination'] || '').trim();
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
  // Log 5 sample records — confirm origin/dest are cities and rates are numbers
  const sampleRecs = Object.values(odIndex).flat().slice(0, 5);
  console.log('[LaneIQ] ✓ Indexed', count, 'records. Sample records:');
  sampleRecs.forEach((r, i) => {
    const rawRate = rows.find(row => (row['Load #']||'').trim() === r.loadNum)?.[
      'Rate'] ?? '(no match)';
    console.log(`  [${i+1}] origin="${r.origin}" dest="${r.destination}" rawRate="${rawRate}" parsedRate=${r.rate || 'N/A'} ok=${!isNaN(parseFloat(r.rate))}`);
  });
  console.log('[LaneIQ] Sample OD keys:', Object.keys(odIndex).slice(0, 5));

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

// ─── Main ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Show loading state immediately while we wait for storage
  document.getElementById('statusBox').className = 'status-box loading';
  document.getElementById('statusVal').textContent = 'Loading…';
  document.getElementById('statusSub').textContent = 'Reading saved data';

  const stored = await chrome.storage.local.get(['laneCount','filesMeta','gmailEmail','gmailIndex','senderEmail','senderGmailIndex','emailTemplate','userName','userCompany','mapsApiKey','emailSubject','odIndex','indexVersion']);

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
      console.log('[LaneIQ] ✓ Index format OK (v' + stored.indexVersion + '). Sample keys:', sample);
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

My name is {name} with {company}. I'm reaching out about your load from {origin} to {destination} posted on DAT today.

Can you share the rate, pickup window, and any special requirements?

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

  // ── Process CSV files ────────────────────────────────────────────────────────
  async function processFiles(newFiles) {
    if (!newFiles.length) return;
    const csvFiles = newFiles.filter(f => f.name.endsWith('.csv'));
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
          showError(`No lanes found in "${file.name}". Check that your CSV has columns named: Origin, Destination, Load #, PU Date, Rate.`);
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
});

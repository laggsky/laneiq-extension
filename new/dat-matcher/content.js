(function() {
  'use strict';
  console.log('[LaneIQ] content script loaded');

  // Must match INDEX_VERSION in popup.js — if the stored index was built with
  // an older version, content.js will refuse to load it (treats it as empty).
  const INDEX_VERSION = 2;

  // ── State ───────────────────────────────────────────────────────────────────
  let odIndex = null, oIndex = null, brokerIndex = null;
  let _cityCoords = null; // "city, st" -> [lat,lng]; loaded once from city_coords.json
  let emailSubject = '', emailTemplate = '', senderGmailIndex = 0;
  let gmailOAuthEmail = '';
  let outlookOAuthEmail = '';
  let signature = '';
  let gmailIndex = 0;
  let panel = null;
  let panelBodyHTML = '';
  let _clearPanelTimer;
  let isDragging = false, dragOffX = 0, dragOffY = 0;
  let isResizing = false, resizeRightEdge = 0, resizeCorner = false, _resizeBottomOnly = false;
  let _routeModalRect = null;      // {left,top,width,height,min} — restored across route-modal opens
  let _routeModalTeardown = null;  // tears down the previous modal's listeners/observer before reopen
  let _routeModal = null;          // live tabbed-modal controller { box, openTab, switchTab, closeTab, doClose }
  let _dlmT;
  let _radiusTimer = null;
  // Lane Lookup radius settings persist across load-row switches + panel rebuilds.
  let _radiusOriginMi = 50, _radiusDestMi = 50;
  let _batchTimer = null;
  let _zeroRowStreak = 0;
  let _cityFailCount  = 0;
  const _alertLastFired = {}; // alert type → timestamp ms; 60-min cooldown per type
  let _activeTab    = 'history';
  let lovedLoads    = {};   // loadKey → { record, savedAt }
  let _recPool      = {};   // loadKey → record, populated by renderRecs for heart click lookup
  let _regionsTimer = null;
  let emailTemplates      = [];
  let activeTemplateIndex = 0;
  let gmailEmail          = '';
  // Outlook deep-link (rate-confirmation lookup) — mirrors the Gmail box. NOT OAuth.
  // outlookConfigured: the user has saved an Outlook value at least once.
  // outlookHost: detected from what the user saves — 'office.com' (work/school) or
  // 'live.com' (personal). Opening the wrong one forces a re-login, so we match it.
  let outlookEmail        = '';
  let outlookConfigured   = false;
  let outlookHost         = 'office.com';
  // Exactly ONE active mail provider at a time. '' | 'gmail' | 'outlook'. Last save wins.
  let activeMailProvider  = '';
  let filesMeta           = [];

  // ── CSV utility functions (mirrored from popup.js for Setup tab) ─────────────
  function parseCSV(text) {
    const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const logicalLines = []; let cur = '', inQ = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '"') { inQ = !inQ; cur += ch; }
      else if (ch === '\n' && !inQ) { logicalLines.push(cur); cur = ''; }
      else { cur += ch; }
    }
    if (cur) logicalLines.push(cur);
    if (logicalLines.length < 2) return [];
    const headers = csvSplitLine(logicalLines[0]).map(h => h.replace(/"/g,'').trim());
    const rows = [];
    for (let i = 1; i < logicalLines.length; i++) {
      const line = logicalLines[i].trim(); if (!line) continue;
      const vals = csvSplitLine(line); const row = {};
      headers.forEach((h, j) => row[h] = (vals[j]||'').replace(/^"|"$/g,'').trim());
      rows.push(row);
    }
    return rows;
  }
  function csvSplitLine(line) {
    const vals = []; let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { vals.push(cur); cur = ''; }
      else cur += ch;
    }
    vals.push(cur); return vals;
  }
  function buildIndexesFromCSVRows(rows, fileIdx) {
    const odIdx = {}, oIdx = {}, brkIdx = {}; let count = 0;
    // Resolve the trailer/equipment column once per file (all rows share headers).
    // Case-insensitive + trimmed match against the recognized header variants.
    const TRAILER_HEADERS = ['trailer', 'trailer type', 'equipment', 'equip', 'eq'];
    let trailerCol = '';
    if (rows.length) for (const k of Object.keys(rows[0])) {
      if (TRAILER_HEADERS.includes(k.trim().toLowerCase())) { trailerCol = k; break; }
    }
    for (const row of rows) {
      const origin = (row['Origin']||row['PickCity']||row['Pick City']||row['Origin City']||row['From City']||row['Shipper City']||'').trim();
      const dest   = (row['Destination']||row['DropCity']||row['Drop City']||row['Destination City']||row['To City']||row['Consignee City']||'').trim();
      let rateClean = (row['Rate']||row['Total']||row['Gross']||row['Revenue']||row['Total Rate']||row['All In']||row['All-In']||row['Pay']||row['Line Haul']||row['Linehaul']||'').trim().replace(/[$\s]/g,'');
      if ((rateClean.match(/\./g)||[]).length > 1) rateClean = rateClean.replace(/\.(?=.*\.)/g,'');
      rateClean = rateClean.replace(/,/g,'');
      const rate = isNaN(parseFloat(rateClean)) ? '' : String(parseFloat(rateClean));
      const broker = (row['Broker']||row['Broker company name']||'').trim();
      const record = { origin, destination: dest, puDate: (row['PU Date']||'').trim(), rate, loadNum: (row['Load #']||'').trim(), weight: (row['Weight / Pallets / FT']||row['Weight']||row['Wt']||row['WT']||row['Weight (lbs)']||row['Gross Weight']||row['GrossWeight']||'').trim(), broker, pickupCompany: (row['Pickup Company + Full Address']||'').trim(), deliveryCompany: (row['Delivery Company + Full Address']||'').trim(), commodity: (row['Commodity']||'').trim(), trailer: trailerCol ? (row[trailerCol]||'').trim() : '', _f: fileIdx };
      if (!origin || origin.length < 2) continue; count++;
      const no = normKey(origin), nd = normKey(dest);
      if (no && nd) { const k = no+'|'+nd; if (!odIdx[k]) odIdx[k]=[]; odIdx[k].push(record); }
      if (no) { if (!oIdx[no]) oIdx[no]=[]; oIdx[no].push(record); }
      const nb = normBroker(broker);
      if (nb) { if (!brkIdx[nb]) brkIdx[nb]=[]; brkIdx[nb].push(record); }
    }
    return { odIndex: odIdx, oIndex: oIdx, brokerIndex: brkIdx, count };
  }
  function mergeCSVIndexes(base, incoming) {
    const out = {...base};
    for (const [k, recs] of Object.entries(incoming||{})) { if (!out[k]) out[k]=[]; out[k] = out[k].concat(recs); }
    return out;
  }
  function removeFromCSVIndex(index, fileIdx) {
    const out = {};
    for (const [k, recs] of Object.entries(index||{})) { if (!Array.isArray(recs)) continue; const f = recs.filter(r => r._f !== fileIdx); if (f.length) out[k] = f; }
    return out;
  }
  function reIndexCSVFiles(index, removedIdx) {
    const out = {};
    for (const [k, recs] of Object.entries(index)) out[k] = recs.map(r => ({...r, _f: r._f > removedIdx ? r._f-1 : r._f}));
    return out;
  }
  function countCSVIndex(odIdx) {
    let n = 0; const seen = new Set();
    for (const recs of Object.values(odIdx)) for (const r of recs) { const k = r.loadNum||(r.origin+'|'+(r.destination||'')+'|'+r.puDate); if (!seen.has(k)){seen.add(k);n++;} }
    return n;
  }

  const DEFAULT_TEMPLATES = [
    { name: 'Standard',
      subject: 'Available {origin} to {destination} loading on {date}',
      body: 'Hi, I have a truck available {miles} miles out from {origin} to {destination} on {date}. Please let me know if you have something.\n\n{signature}' },
    { name: 'Follow Up',
      subject: 'Following up - {origin} to {destination} loading on {date}',
      body: 'Hi, following up to see if you have any loads from {origin} to {destination}.\n\n{signature}' },
    { name: 'Custom',
      subject: '{origin} to {destination} loading on {date}',
      body: 'Available from {origin} to {destination} on {date}.\n\n{signature}' },
  ];
  let _dbMatchCache = {};
  let _lastClickedRow = null;
  let _lastExpandKey = '';
  let _lastExpandTime = 0;
  let _panelSeq = 0; // incremented on each panel-populating call; stale fetches self-cancel
  // Memoization caches — keyed by raw input string, populated on first call
  const _normCache = new Map();
  const _dtCache   = new Map();
  let _initialized = false; // guard: don't re-read storage on edge-case re-init
  let _initializing = false; // guard: prevent concurrent init() calls
  let _observersSetup = false; // guard: one-time observers/listeners
  let panelPopped  = false; // true while the floating pop-out window is open
  let mapsApiKey   = '';    // Google Maps Distance Matrix API key
  let licenseTier  = 'solo';
  let dataSource   = 'csv';
  let useCSV = true;
  let useDB  = false;
  let licenseKey   = '';
  let dlmMpg        = 6.5;  // saved MPG (persists across sessions)
  let dlmFuelPrice  = 3.89; // saved fuel price
  let dlmDriverRate = 0;    // saved driver pay $/mi

  // In-memory cache for Railway /validate — skips the fetch if a successful
  // validation happened within the last 60s in this page session. Resets
  // naturally on every page load. Does NOT persist across reloads.
  const LICENSE_CACHE_MS = 60 * 1000;
  let _licenseValidatedAt = 0;
  let _licenseCachedTier  = null;

  // ── City normalizer ─────────────────────────────────────────────────────────
  function norm(raw) {
    if (!raw) return '';
    const k = String(raw);
    let v = _normCache.get(k);
    if (v !== undefined) return v;
    v = k.toLowerCase()
      // Expand DAT abbreviations before state stripping (mt must come first —
      // it is also Montana's state code and would otherwise be stripped)
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
      .replace(/\bsprs\b/g, 'springs')
      .replace(/\bgrv\b/g,  'grove')
      .replace(/\brnch\b/g, 'ranch')
      .replace(/\bvlg\b/g,  'village')
      .replace(/\bjct\b/g,   'junction')
      .replace(/\bst\.?\b/g, 'saint')       // St. / St → Saint
      .replace(/\bfrncsco\b/g,'francisco')  // DAT shorthand: "S San Frncsco"
      .replace(/\b(ca|fl|tx|pa|nv|ga|nc|va|ct|mi|in|oh|mo|co|az|or|ut|wa|mn|ne|ks|sc|al|ms|la|ar|ky|tn|wv|md|nj|ny|ma|ri|nh|vt|me|de|nm|id|mt|wy|sd|nd|ok|ia|il|ak|hi|dc|wi)\b/g, '')
      .replace(/\d+/g, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/^[nsew] /, '');             // strip leading directional prefix (N/S/E/W)
    _normCache.set(k, v);
    return v;
  }

  // Extract state from city string e.g. "Charlotte, NC" -> "nc"
  function getState(raw) {
    const clean = String(raw).replace(/\b\d{5}(-\d{4})?\s*$/, '').trim();
    const m = clean.match(/([A-Z]{2})\s*$/);
    return m ? m[1].toLowerCase() : '';
  }

  // Build an index key that normalizes the city name but preserves the state so
  // that "Columbia, MO" and "Columbia, PA" land in separate index buckets.
  // e.g. "S San Frncsco, CA" → "san francisco, ca"
  // Strips any text after the state abbreviation (e.g. badge "✓ 1x" injected
  // by the extension) so lookup keys are never poisoned by UI text.
  function normKey(raw) {
    // Keep everything up to and including ", ST" — drop trailing badge/junk
    const clean = String(raw).replace(/(,\s*[A-Za-z]{2})\b.*$/, '$1').trim();
    // Extract state case-insensitively (CSV/DAT may emit "MO", "mo", or "Mo")
    const stMatch = clean.match(/([A-Za-z]{2})\s*$/);
    const st   = stMatch ? stMatch[1].toLowerCase() : '';
    const city = norm(clean);
    return st ? city + ', ' + st : city;
  }

  function citiesMatch(a, b) {
    const sa = getState(a), sb = getState(b);
    if (sa && sb && sa !== sb) return false;

    const na = norm(a), nb = norm(b);
    if (!na || !nb || na.length < 2 || nb.length < 2) return false;
    return na === nb;
  }

  function normBroker(raw) {
    if (!raw || raw === 'nan') return '';
    return String(raw).toLowerCase()
      .replace(/logistics|transport|brokerage|freight|group|inc|llc|corp|co/gi, '')
      .replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function normCity(str) {
    if (!str) return str;
    const abbr = {
      'Cyn': 'Canyon', 'Jct': 'Junction', 'Spgs': 'Springs',
      'Hts': 'Heights', 'Pk': 'Park', 'Ft': 'Fort',
      'Mt': 'Mount', 'Vly': 'Valley', 'Crk': 'Creek',
      'Lk': 'Lake', 'Rdg': 'Ridge', 'Grv': 'Grove',
      'Brch': 'Branch', 'Mdws': 'Meadows'
    };
    return str.replace(/\b([A-Z][a-z]+)\b/g, (match) => abbr[match] || match);
  }

  // ── Coordinate lookup (bundled city_coords.json, v1.32 radius matching) ──────
  async function loadCityCoords() {
    if (_cityCoords) return _cityCoords;
    try {
      const resp = await fetch(chrome.runtime.getURL('city_coords.json'));
      _cityCoords = await resp.json();
      console.log('[LaneIQ] city_coords loaded:', Object.keys(_cityCoords).length, 'cities');
    } catch (e) {
      console.error('[LaneIQ] city_coords load failed:', e.message);
      _cityCoords = {};
    }
    return _cityCoords;
  }

  // [lat,lng] or null. Uses the SAME normKey() the indexes use → direct hash hit.
  function getCoords(cityStateString) {
    if (!_cityCoords || !cityStateString) return null;
    const raw = String(cityStateString);
    // Prefer the expanded directional (e.g. "S Salt Lake" -> "South Salt Lake")
    // so we hit the precise city before falling back to the parent-city strip.
    const expanded = raw.replace(/^\s*([NSEW])\s+/i, (m, d) =>
      ({ n: 'North ', s: 'South ', e: 'East ', w: 'West ' }[d.toLowerCase()]));
    if (expanded !== raw) {
      const hit = _cityCoords[normKey(expanded)];
      if (hit) return hit;
    }
    // Fallback: existing behavior (norm() strips the leading directional -> parent city).
    return _cityCoords[normKey(raw)] || null;
  }

  // Great-circle distance in miles between two [lat,lng] pairs.
  function distanceMiles(a, b) {
    if (!a || !b) return null;
    const R = 3958.7613, toRad = d => d * Math.PI / 180;
    const dLat = toRad(b[0] - a[0]), dLng = toRad(b[1] - a[1]);
    const h = Math.sin(dLat/2)**2 +
              Math.cos(toRad(a[0]))*Math.cos(toRad(b[0]))*Math.sin(dLng/2)**2;
    return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
  }

  // ── Radius (Lane Lookup) matching ───────────────────────────────────────────
  // C1 coverage fallback: when a record's city field doesn't resolve, recover
  // "City, ST" from the tail of its full address ("…Street, CITY, ST ZIP") and
  // retry getCoords. Strictly additive — only invoked on a primary-lookup miss.
  function coordsFromAddressTail(raw) {
    if (!raw || raw === 'nan') return null;
    // Drop a trailing ZIP, then grab the final "City, ST" pair.
    const s = String(raw).replace(/\s+\d{5}(-\d{4})?\s*$/, '').trim();
    const m = s.match(/([A-Za-z][A-Za-z\s\.'\-]{1,30}),\s*([A-Za-z]{2})\s*$/);
    if (!m) return null;
    return getCoords(m[1].trim() + ', ' + m[2].trim());
  }

  // Walk the CSV history and return every load whose ORIGIN is within
  // originRadiusMi of the searched origin AND whose DEST is within destRadiusMi
  // of the searched dest. Loads where either city lacks coords (the ~13% misses)
  // are silently skipped — never error. Exact-lane records are INCLUDED (they
  // belong in the radius set; they also appear in the exact section above).
  //
  // Records come straight out of oIndex, which holds the SAME full record object
  // odIndex does (buildIndexesFromCSVRows) — so each carries destination, rate,
  // broker, puDate, loadNum, weight, pickupCompany/deliveryCompany, etc.
  function radiusMatch(origin, dest, originRadiusMi, destRadiusMi) {
    if (!oIndex || !_cityCoords) return [];
    const oCrd = getCoords(origin);
    const dCrd = getCoords(dest);
    if (!oCrd || !dCrd) return []; // can't anchor a radius without both coords

    const out = [];
    for (const [oKey, recs] of Object.entries(oIndex)) {
      // oIndex keys are already normKey()'d, so hit _cityCoords directly.
      // C1: on a miss, recover origin coords from a record's pickup address tail.
      let recOCrd = _cityCoords[oKey];
      if (!recOCrd) {
        for (const r of recs) {
          const c = coordsFromAddressTail(r.pickupCompany);
          if (c) { recOCrd = c; break; }
        }
      }
      if (!recOCrd) continue;
      const oGap = distanceMiles(oCrd, recOCrd);   // straight-line city-center miles
      if (oGap > originRadiusMi) continue;
      for (const r of recs) {
        // C1: on a dest miss, recover from the delivery address tail.
        let recDCrd = _cityCoords[normKey(r.destination || '')];
        if (!recDCrd) recDCrd = coordsFromAddressTail(r.deliveryCompany);
        if (!recDCrd) continue;
        const dGap = distanceMiles(dCrd, recDCrd);
        if (dGap > destRadiusMi) continue;
        // Shallow copy so the gap fields ride along WITHOUT mutating the shared
        // oIndex/odIndex/brokerIndex record (the blue same-origin fallback reuses
        // those, and must NOT inherit _oGap/_dGap → keeps distance labels yellow-only).
        out.push({ ...r, _oGap: oGap, _dGap: dGap });
      }
    }

    // dedup() removes duplicates then sorts by date; re-sort AFTER for the order
    // we want: exact lane first (both gaps ~0), then origin gap asc, dest gap asc.
    const deduped = dedup(out);
    const NEAR = 2; // miles; <2mi each rounds to ~0 → treated as an exact lane
    deduped.sort((a, b) => {
      const aExact = (a._oGap < NEAR && a._dGap < NEAR) ? 0 : 1;
      const bExact = (b._oGap < NEAR && b._dGap < NEAR) ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      if (a._oGap !== b._oGap) return a._oGap - b._oGap;
      return a._dGap - b._dGap;
    });
    return deduped;
  }

  // Build the entire Lane Lookup section HTML (controls + summary + cards).
  // Returns '' when there's no CSV index to search. The summary is scoped to
  // whatever is being shown: tight radius matches, or — on zero matches — the
  // broad same-origin fallback, LABELED so a dispatcher is never misled.
  function renderRadiusSection(origin, dest, originMi, destMi) {
    if (!oIndex || Object.keys(oIndex).length === 0) return '';

    const oCity = esc(origin || '');
    const dCity = esc(dest || '');
    const controls = `
      <div class="dlm-stitle" style="margin-top:16px">Lane Lookup</div>
      <div class="dlm-radius-controls">
        <div class="dlm-radius-row">
          <span class="dlm-r-tag">From</span>
          <input class="dlm-r-city" id="dlm-r-origin" type="text" value="${oCity}" placeholder="Origin city, ST" autocomplete="off" spellcheck="false">
        </div>
        <div class="dlm-radius-row dlm-radius-slider-row">
          <span class="dlm-r-tag">Origin radius</span>
          <input class="dlm-r-slider" id="dlm-r-origin-mi" type="range" min="0" max="300" step="25" value="${originMi}">
          <span class="dlm-r-mi" id="dlm-r-origin-mi-val">${originMi} mi</span>
        </div>
        <div class="dlm-radius-row">
          <span class="dlm-r-tag">To</span>
          <input class="dlm-r-city" id="dlm-r-dest" type="text" value="${dCity}" placeholder="Dest city, ST" autocomplete="off" spellcheck="false">
        </div>
        <div class="dlm-radius-row dlm-radius-slider-row">
          <span class="dlm-r-tag">Dest radius</span>
          <input class="dlm-r-slider" id="dlm-r-dest-mi" type="range" min="0" max="300" step="25" value="${destMi}">
          <span class="dlm-r-mi" id="dlm-r-dest-mi-val">${destMi} mi</span>
        </div>
      </div>
      <div id="dlm-radius-results">${renderRadiusResults(origin, dest, originMi, destMi)}</div>`;
    return `<div id="dlm-radius-section">${controls}</div>`;
  }

  // The summary + cards portion only — re-rendered live on slider/field change
  // without rebuilding the controls (so focus/drag state is preserved).
  function renderRadiusResults(origin, dest, originMi, destMi) {
    const lk = new Set(Object.keys(lovedLoads));
    const oCity = esc(origin || ''), dCity = esc(dest || '');

    if (!origin || !dest) {
      return `<div class="dlm-radius-note">Enter both an origin and a destination to search nearby lanes.</div>`;
    }

    // Same-origin floor — pure string match, needs NO coords. Computed once so it
    // can back both the missing-coords branch and the zero-radius-match branch.
    const originLoads = findO(origin);
    const broadCards = (label) => {
      const st = calcStats(originLoads);
      return `
        <div class="dlm-radius-sum dlm-radius-sum-broad">
          <div class="dlm-radius-sum-label">${label}: avg <b>${st.avg}</b>, best <b>${st.best}</b> (${originLoads.length} loads)</div>
        </div>
        ${renderRecs(originLoads, '#007aff', 50, true, true, lk)}`;
    };

    // U1 — missing anchor coords: radius can't run, but the same-origin floor
    // still can. Explain why + how to fix, and show the floor if it exists.
    if (!getCoords(origin) || !getCoords(dest)) {
      const missing = !getCoords(origin) ? oCity : dCity;
      const tail = originLoads.length ? ` Showing all loads from ${oCity} instead:` : '';
      let html = `<div class="dlm-radius-note dlm-radius-note-warn">Couldn't locate ${missing} on the map — can't run a radius search. Try a nearby larger city in the field above.${tail}</div>`;
      if (originLoads.length) html += broadCards(`All loads from ${oCity}`);
      return html;
    }

    const matches = radiusMatch(origin, dest, originMi, destMi);
    if (matches.length) {
      const st = calcStats(matches);
      return `
        <div class="dlm-rate-card">
          <div class="dlm-rate-card-lane">${oCity} <span class="dlm-rate-card-arrow">→</span> ${dCity}</div>
          <div class="dlm-rate-card-stats">
            <div class="dlm-rate-stat"><div class="dlm-rate-stat-k">Avg</div><div class="dlm-rate-stat-v">${st.avg}</div></div>
            <div class="dlm-rate-stat dlm-rate-stat-best"><div class="dlm-rate-stat-k">Best</div><div class="dlm-rate-stat-v">${st.best}</div></div>
          </div>
          <div class="dlm-rate-card-sub">${matches.length} loads in radius</div>
        </div>
        ${renderRecs(matches, '#f5a623', 50, true, true, lk)}`;
    }

    // U1 — coords OK but zero radius matches AND zero same-origin: actionable,
    // never a dead end.
    if (!originLoads.length) {
      return `<div class="dlm-radius-note">No loads near this lane in your history. Widen the radius, or try a nearby larger city.</div>`;
    }

    // U1 — coords OK, zero radius, but same-origin exists: broad blue fallback,
    // LABELED clearly so a dispatcher never mistakes it for a tight lane match.
    return broadCards(`No close lane matches. Broader — all loads from ${oCity}`);
  }

  // Dev aid — real-world coord hit rate vs the loaded CSV indexes.
  function logCoordCoverage() {
    if (!_cityCoords) return;
    const cities = new Set();
    if (oIndex)  for (const k of Object.keys(oIndex)) cities.add(k);
    if (odIndex) for (const k of Object.keys(odIndex)) {
      const [o, d] = k.split('|');
      if (o) cities.add(o); if (d) cities.add(d);
    }
    let matched = 0;
    for (const c of cities) if (_cityCoords[c]) matched++;
    console.log(`[LaneIQ] coord coverage: ${matched}/${cities.size} cities matched`);
  }

  // ── Lookup functions ────────────────────────────────────────────────────────
  // Index keys are built by popup.js as normKey(origin)+'|'+normKey(dest),
  // preserving the state so "Columbia, MO" and "Columbia, PA" are separate
  // buckets. The post-filter below is kept as a safety net for edge cases
  // where state data is missing from either DAT or the CSV.
  function findOD(origin, dest) {
    if (!odIndex) return [];
    const no = normKey(origin), nd = normKey(dest);
    const key = no + '|' + nd;
    if (!no || !nd) return [];
    const recs = odIndex[key] || [];
    if (!recs.length) return [];
    const so = getState(origin);
    const sd = getState(dest);
    const filtered = recs.filter(r => {
      const ro = getState(r.origin      || '');
      const rd = getState(r.destination || '');
if (so && ro && so !== ro) return false;
      if (sd && rd && sd !== rd) return false;
      return true;
    });
    return dedup(filtered);
  }

  function findO(origin) {
    if (!oIndex) return [];
    const no = normKey(origin);
    if (!no) return [];
    const recs = oIndex[no] || [];
    if (!recs.length) return [];
    const so = getState(origin);
    const filtered = so ? recs.filter(r => {
      const rs = getState(r.origin || '');
      return !rs || rs === so;
    }) : recs;
    return dedup(filtered);
  }

  function findBroker(brokerName, origin) {
    if (!brokerIndex || !brokerName) return [];
    const nb = normBroker(brokerName);
    if (!nb || nb.length < 2) return [];
    const out = [];
    // brokerIndex keys are already normalized by popup.js — skip redundant normBroker(key)
    for (const [key, recs] of Object.entries(brokerIndex)) {
      if (key && (key.includes(nb) || nb.includes(key))) {
        const sameRegion = recs.some(r => citiesMatch(r.origin || '', origin || ''));
        if (sameRegion) out.push(...recs);
      }
    }
    return dedup(out).slice(0, 10);
  }

  function dedup(recs) {
    const seen = new Set();
    return recs
      .filter(r => { const k = r.loadNum || (r.origin + '|' + (r.destination || '') + '|' + r.puDate); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => parseDate(b.puDate) - parseDate(a.puDate));
  }

  function parseDate(raw) {
    if (!raw) return 0;
    const s = String(raw).trim();
    let v = _dtCache.get(s);
    if (v !== undefined) return v;
    let m;
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) { v = new Date(+m[1],+m[2]-1,+m[3]).getTime(); _dtCache.set(s,v); return v; }
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) { v = new Date(+m[3],+m[1]-1,+m[2]).getTime(); _dtCache.set(s,v); return v; }
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\b/); if (m) { v = new Date(2000+(+m[3]),+m[1]-1,+m[2]).getTime(); _dtCache.set(s,v); return v; }
    m = s.match(/([A-Za-z]{3,9})\s+(\d{1,2})[,\s]+(\d{4})/); if (m) { const d = new Date(m[1]+' '+m[2]+' '+m[3]); v = isNaN(d) ? 0 : d.getTime(); _dtCache.set(s,v); return v; }
    m = s.match(/^(\d{1,2})\/(\d{1,2})\b/); if (m) { v = new Date(new Date().getFullYear(),+m[1]-1,+m[2]).getTime(); _dtCache.set(s,v); return v; }
    const d = new Date(s); v = isNaN(d) ? 0 : d.getTime(); _dtCache.set(s,v); return v;
  }

  function calcStats(recs) {
    const rates = recs.map(r => parseFloat(String(r.rate||''))).filter(r => r > 0 && r <= 25000);
    return {
      count: recs.length,
      avg:  rates.length ? '$' + Math.round(rates.reduce((a,b)=>a+b,0)/rates.length).toLocaleString() : 'N/A',
      best: rates.length ? '$' + Math.max(...rates).toLocaleString() : 'N/A',
    };
  }

  function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function loveKey(r) {
    return String(r.loadNum || '').trim() || [r.origin || '', r.destination || '', r.puDate || ''].join('|');
  }

  function cleanStreet(s) {
    if (!s) return '';
    // Strip everything from the last comma onward (removes suite/dock/city fragments)
    const ci = s.lastIndexOf(',');
    if (ci > 0) s = s.slice(0, ci).trim();
    // Strip trailing all-alpha word(s) that follow a period: "AVE. FIREBAUGH" → "AVE."
    s = s.replace(/\.\s+[A-Za-z][A-Za-z\s]*$/, '.').trim();
    return s;
  }

  function parseCompanyAddress(raw) {
    if (!raw || raw === 'nan') return null;
    let s = raw.trim();

    // 1. Strip trailing ZIP code
    s = s.replace(/\s+\d{5}(-\d{4})?\s*$/, '').trim();

    // 2. Strip trailing state abbreviation (, CA  or  CA)
    s = s.replace(/,?\s+[A-Z]{2}\s*$/, '').trim();

    // 3. Strip last comma-segment if it looks like a city (letters + spaces only)
    const lastComma = s.lastIndexOf(',');
    if (lastComma > 0) {
      const tail = s.slice(lastComma + 1).trim();
      if (/^[A-Za-z][A-Za-z\s]*$/.test(tail) && tail.length < 35)
        s = s.slice(0, lastComma).trim();
    }

    // 4. Split company name from street address
    // "Company, 123 Street …"
    let m = s.match(/^([^,]+),\s*(\d+.*)$/);
    if (m) return { company: m[1].trim(), street: cleanStreet(m[2]) };

    // "Company 123 Street …" (no comma separator)
    m = s.match(/^(.+?)\s+(\d+\s+\S.*)$/);
    if (m) return { company: m[1].replace(/,+$/, '').trim(), street: cleanStreet(m[2]) };

    return { company: s.replace(/,+$/, '').trim(), street: '' };
  }

  function gmailUrl(loadNum) {
    const q = String(loadNum||'').replace(/[^a-zA-Z0-9]/g, '').trim();
    if (!q) return null;
    return `https://mail.google.com/mail/u/${gmailIndex}/#search/${encodeURIComponent(q)}`;
  }

  // Detect the Outlook host from a pasted URL or email. live.com = personal
  // (Outlook.com/Hotmail/Live/MSN), office.com = work/school (default).
  function detectOutlookHost(raw) {
    const low = String(raw || '').toLowerCase().trim();
    if (low.includes('live.com'))   return 'live.com';
    if (low.includes('office.com')) return 'office.com';
    const m = low.match(/@([a-z0-9.-]+)/);
    if (m) return /^(outlook\.com|hotmail\.com|live\.com|msn\.com)$/.test(m[1]) ? 'live.com' : 'office.com';
    return 'office.com';
  }

  // Outlook can't reliably deep-link a search, so open the INBOX on the detected
  // host (matching the user's session avoids a forced re-login) — they search the
  // load # manually. loadNum is unused; kept for signature parity with gmailUrl.
  function outlookUrl(loadNum) {
    return `https://outlook.${outlookHost}/mail/`;
  }

  // ── Clean DAT's special characters from city text ────────────────────────
  function cleanCity(str) {
    let s = String(str || '')
      .replace(/[^\x00-\x7F]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    // Remove exact duplicate e.g. "Salinas, CA Salinas, CA"
    let m = s.match(/^(.+?,\s*[A-Z]{2})\s+\1/i);
    if (m) return m[1].trim();
    // Remove partial duplicate e.g. "Salinas, CA Salinas" — but not "Sacramento, CA Stockton, CA"
    m = s.match(/^([\w\s\.]+,\s*[A-Z]{2})\s+([\w\s]+)$/);
    if (m && !/,\s*[A-Z]{2}$/.test(m[2])) return m[1].trim();
    return s;
  }

  // DAT glues a column-header label ("Trip" — the trip/miles column) onto the city
  // text: "TripGonzales, CA" (glued) or "Trip Gonzales, CA" (spaced). Strip a known
  // label prefix, but ONLY when a capitalized city word follows, so real cities like
  // "Tripoli, IA" / "Milesburg, PA" (lowercase after the label) are never truncated.
  // Shared by getCities (both branches) and flushExpand (consumer-side hardening).
  const COL_LABEL = /^(?:Trip|Origin|Destination|Dest|Pickup|Delivery|Drop|Stop|Miles)(?=[A-Z]|\s+[A-Z])/;
  const COL_LABEL_WORDS = ['Trip','Origin','Destination','Dest','Pickup','Delivery','Drop','Stop','Miles'];
  function stripColLabel(s) { return String(s || '').replace(COL_LABEL, '').trim(); }

  // ── Send email via Gmail compose URL ──────────────────────────────────────
  async function sendEmail(brokerEmail, originRaw, destRaw, dateRaw = '', milesRaw = '') {
    // Belt-and-suspenders: refresh name/company from storage if in-memory is empty.
    // Handles the edge case where the popup saved them just before this click.
    if (!signature) {
      const stored = await chrome.storage.local.get(['signature']);
      if (stored.signature) signature = stored.signature;
    }
    const origin  = cleanCity(originRaw);
    const dest    = cleanCity(destRaw);
    const tpl     = emailTemplates[activeTemplateIndex];
    // {miles} = DH-O. When present, substitute the number. When empty, collapse
    // the "{miles} miles out from" fragment to just "from" so the sentence reads
    // cleanly (no double space, no dangling "miles out"); clear any stray tokens.
    const fillMiles = (s) => milesRaw
      ? s.replace(/\{miles\}/g, milesRaw)
      : s.replace(/\{miles\}\s*miles out from/gi, 'from').replace(/\{miles\}/g, '');
    // {signature}: substitute when set; when empty, drop the token AND its
    // leading blank line(s), then trim trailing whitespace so no blank line dangles.
    const fillSignature = (s) => signature
      ? s.replace(/\{signature\}/g, signature)
      : s.replace(/\s*\{signature\}/g, '').replace(/\s+$/, '');
    const subject = fillSignature(fillMiles(tpl?.subject || emailSubject)
      .replace(/\{origin\}/g, origin)
      .replace(/\{destination\}/g, dest)
      .replace(/\{date\}/g, dateRaw));
    const body    = fillSignature(fillMiles(tpl?.body || emailTemplate)
      .replace(/\{origin\}/g, origin)
      .replace(/\{destination\}/g, dest)
      .replace(/\{date\}/g, dateRaw));

    async function sendEmailViaGmail(to, subj, bdy) {
      try {
        const result = await chrome.runtime.sendMessage({
          type: 'sendGmail', to, subject: subj, body: bdy,
        });
        if (result?.ok) return true;
      } catch (e) {
        // runtime error (e.g. background not ready) — fall through
      }
      return false;
    }

    async function sendEmailViaOutlook(to, subj, bdy) {
      try {
        const result = await chrome.runtime.sendMessage({
          type: 'sendOutlook', to, subject: subj, body: bdy,
        });
        if (result?.ok) return true;
      } catch (e) {
        // runtime error (e.g. background not ready) — fall through
      }
      return false;
    }

    // Send priority: connected Gmail OAuth → connected Outlook OAuth.
    // Gated on which provider is connected so an Outlook-only user is never
    // prompted with a Google login popup (and vice-versa). Returns true if the
    // message was sent; false if no account is connected, so the caller can
    // prompt the user to connect Gmail or Outlook.
    let sent = false;
    if (gmailOAuthEmail) {
      sent = await sendEmailViaGmail(brokerEmail, subject, body);
    } else if (outlookOAuthEmail) {
      sent = await sendEmailViaOutlook(brokerEmail, subject, body);
    }
    return sent;
  }

  // ── Selector error reporting ────────────────────────────────────────────────
  async function reportSelectorError(type, detail) {
    const COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes per alert type
    const now = Date.now();
    if (_alertLastFired[type] && now - _alertLastFired[type] < COOLDOWN_MS) return;
    _alertLastFired[type] = now;
    try {
      await fetch('https://laneiq-backend-production.up.railway.app/selector-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, detail, timestamp: new Date().toISOString() })
      });
    } catch (e) {
      // silent — never break the extension trying to report
    }
  }

    // ── Extract broker email from DAT row ──────────────────────────────────────
  function getBrokerEmail(row) {
    // 1. Check mailto links first
    const mailtoEl = row.querySelector('a[href^="mailto:"]');
    if (mailtoEl) {
      const email = mailtoEl.href.replace('mailto:', '').split('?')[0].trim();
      if (email && email.includes('@')) return email;
    }
    // 2. Check contact column
    const contactEl = row.querySelector('[class*="contact"],[class*="Contact"],[class*="email"],[class*="Email"]');
    if (contactEl) {
      const m = contactEl.textContent.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
      if (m) return m[0];
    }
    // 3. Scan full row text
    const matches = row.textContent.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
    const filtered = matches.filter(e =>
      !e.includes('dat.com') && !e.includes('google.com') &&
      !e.includes('optimizely.com') && !e.includes('example.com')
    );
    return filtered[0] || '';
  }

  // ── Chip "Sent ✓" flash ───────────────────────────────────────────────────
  function flashChipSent(chip) {
    const origText = chip.textContent;
    const origBg   = chip.style.getPropertyValue('background');
    const origPrio = chip.style.getPropertyPriority('background');
    chip.textContent = 'Sent ✓';
    chip.style.setProperty('background', '#059669', 'important');
    setTimeout(() => {
      chip.textContent = origText;
      chip.style.setProperty('background', origBg || '', origPrio || '');
    }, 2000);
  }

  // Brief floating message anchored to a chip when no send method is configured.
  function showSetupMsg(anchorEl) {
    document.querySelector('.dlm-setup-msg')?.remove();
    const tip = document.createElement('div');
    tip.className = 'dlm-setup-msg';
    tip.textContent = 'Connect Gmail or Outlook first';
    tip.style.cssText = 'position:fixed;z-index:2147483647;background:#1d1d1f;color:#fff;' +
      'font:600 11px/1.35 -apple-system,sans-serif;padding:7px 10px;border-radius:8px;' +
      'max-width:230px;box-shadow:0 4px 14px rgba(0,0,0,.25)';
    const r = anchorEl.getBoundingClientRect();
    tip.style.top  = (r.bottom + 5) + 'px';
    tip.style.left = Math.max(8, r.left) + 'px';
    document.body.appendChild(tip);
    setTimeout(() => tip.remove(), 3500);
  }

  // ── RPM result tooltip ────────────────────────────────────────────────────
  function showRpmTip(anchorEl, { miles, rpm, dho }) {
    const old = document.querySelector('.dlm-rpm-tip');
    if (old) old.remove();
    const tip = document.createElement('div');
    tip.className = 'dlm-rpm-tip';
    const parts = [`${miles} mi`];
    if (rpm)        parts.push(`$${rpm.toFixed(2)}/mi`);
    if (dho != null) parts.push(`${dho} DH`);
    tip.textContent = parts.join('  ·  ');
    const r = anchorEl.getBoundingClientRect();
    tip.style.top  = (r.bottom + 5) + 'px';
    tip.style.left = r.left + 'px';
    document.body.appendChild(tip);
    const dismiss = () => { tip.remove(); document.removeEventListener('click', dismiss, true); };
    setTimeout(() => document.addEventListener('click', dismiss, true), 0);
  }

  function openNotePopover(badge) {
    document.querySelector('.dlm-note-popover')?.remove();
    const noteKey = badge.dataset.noteKey;
    const panel = document.getElementById('dlm-panel');
    if (!panel) return;
    const popover = document.createElement('div');
    popover.className = 'dlm-note-popover';
    popover.innerHTML =
      '<div class="dlm-note-hdr">' +
        '<span class="dlm-note-title">NOTE</span>' +
        '<button class="dlm-note-close">✕</button>' +
      '</div>' +
      '<textarea class="dlm-note-ta" placeholder="Add your note…"></textarea>' +
      '<div class="dlm-note-saved" style="display:none">Saved</div>';
    panel.appendChild(popover);
    const br = badge.getBoundingClientRect();
    const pr = panel.getBoundingClientRect();
    popover.style.top  = Math.max(0, br.top - pr.top - 8) + 'px';
    popover.style.left = Math.max(0, br.left - pr.left - 218) + 'px';
    let onOutsideClick;
    setTimeout(() => {
      onOutsideClick = e => {
        if (!popover.contains(e.target) && !badge.contains(e.target)) {
          popover.remove();
          document.removeEventListener('click', onOutsideClick, true);
        }
      };
      document.addEventListener('click', onOutsideClick, true);
    }, 0);
    chrome.storage.local.get([noteKey], res => {
      popover.querySelector('.dlm-note-ta').value = res[noteKey] || '';
    });
    popover.querySelector('.dlm-note-close').addEventListener('click', () => {
      popover.remove();
      document.removeEventListener('click', onOutsideClick, true);
    });
    let _saveTimer = null;
    const savedEl = popover.querySelector('.dlm-note-saved');
    popover.querySelector('.dlm-note-ta').addEventListener('input', e => {
      const text = e.target.value;
      badge.classList.toggle('dlm-note-has', !!text.trim());
      clearTimeout(_saveTimer);
      _saveTimer = setTimeout(() => {
        chrome.storage.local.set({ [noteKey]: text }, () => {
          savedEl.style.display = 'block';
          setTimeout(() => { savedEl.style.display = 'none'; }, 1500);
        });
      }, 300);
    });
  }

  function showUndoToast(key, savedEntry) {
    document.querySelector('.dlm-undo-toast')?.remove();
    const panel = document.getElementById('dlm-panel');
    if (!panel) return;
    const toast = document.createElement('div');
    toast.className = 'dlm-undo-toast';
    toast.innerHTML = 'Load removed — <button class="dlm-undo-btn">Undo</button>';
    panel.appendChild(toast);
    const timer = setTimeout(() => {
      toast.remove();
      chrome.storage.local.remove('note_' + key);
    }, 5000);
    toast.querySelector('.dlm-undo-btn').addEventListener('click', () => {
      clearTimeout(timer);
      toast.remove();
      lovedLoads[key] = savedEntry;
      chrome.storage.local.set({ lovedLoads });
      if (_activeTab === 'loved') switchTab('loved');
    });
  }

  // ── Extract rate number from DAT row ──────────────────────────────────────
  function getRate(row) {
    const el = row.querySelector('[class*="rate"],[class*="Rate"],[class*="price"],[class*="Price"]');
    if (el) {
      const m = el.textContent.match(/\$?\s*([\d,]+(?:\.\d{1,2})?)/);
      if (m) return parseFloat(m[1].replace(/,/g, ''));
    }
    const m = row.textContent.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
    return m ? parseFloat(m[1].replace(/,/g, '')) : 0;
  }

  // ── Extract DH-O (deadhead miles) from DAT row ────────────────────────────
  function getDHO(row) {
    const m = row.textContent.match(/\bDH[\s\-O]*:?\s*(\d+)\b/i);
    return m ? parseInt(m[1]) : null;
  }

  // ── Extract DH-O miles for the {miles} template variable ──────────────────
  // DH-O has its own cell, parenthesized like "(191)". A hidden duplicate
  // deadhead row can exist (display:none), so scan all matches and return the
  // first with actual digits. Returns just the number string, or '' if none.
  function getMiles(row) {
    const cells = row.querySelectorAll('[data-test="load-dho-cell"], .deadhead');
    for (const cell of cells) {
      const m = (cell.textContent || '').match(/\d+/);
      if (m) return m[0];
    }
    return '';
  }

  // Derive {miles} at SEND time from a clicked chip: walk up to the row
  // container that holds the DH-O cell and read it live. Works regardless of
  // which injection path created the chip, and survives DAT re-renders.
  function milesFromChip(el) {
    let node = el;
    while (node && node !== document.body) {
      if (node.querySelector && node.querySelector('[data-test="load-dho-cell"], .deadhead')) {
        return getMiles(node);
      }
      node = node.parentElement;
    }
    return '';
  }

  // ── Style the broker's email address as a tappable chip ───────────────────
  function injectEmailChip(row) {
    if (row.dataset.dlmChip) return;
    const email = getBrokerEmail(row);
    if (!email) return;
    const { origin, dest } = getCities(row);
    if (!origin || origin.length < 3) return;
    row.dataset.dlmChip = '1';

    // Resolve origin/dest once at injection time — dataset takes priority,
    // regex scan is the fallback, getCities result is last resort.
    const rowText = row.textContent || '';
    const cityMatches = [...rowText.matchAll(/([A-Z][a-zA-Z\s\.]+,\s*[A-Z]{2})/g)]
      .map(m => m[1].trim())
      .filter(c => c.length > 4 && !['Full', 'Partial', 'Reefer', 'Flat', 'Step'].some(w => c.startsWith(w)));
    const chipOrigin = row.dataset.dlmOrigin || cityMatches[0] || origin;
    const chipDest   = row.dataset.dlmDest   || cityMatches[1] || dest;
    const dateMatch  = rowText.match(/\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/);
    const chipDate   = dateMatch ? dateMatch[1] : '';
    const onClick = async e => {
      e.stopPropagation(); e.preventDefault();
      const chip = e.currentTarget;
      const ok = await sendEmail(email, chip.dataset.emailOrigin || '', chip.dataset.emailDest || '', chip.dataset.emailDate || '', milesFromChip(chip));
      if (ok) flashChipSent(chip); else showSetupMsg(chip);
    };

    // ── Case 1: email is already in a mailto anchor — style it directly ───────
    for (const a of row.querySelectorAll('a[href^="mailto:"]')) {
      if (a.dataset.dlmChip) return;            // element-level guard — prevents
      const href = a.href.replace(/^mailto:/i, '').split('?')[0].trim(); // duplicate
      if (href.toLowerCase() === email.toLowerCase()) { // listeners across scans
        a.dataset.dlmChip = '1';
        a.dataset.emailOrigin = chipOrigin;
        a.dataset.emailDest   = chipDest;
        a.dataset.emailDate   = chipDate;
        a.classList.add('dlm-email-chip');
        a.title = `Click to email ${email}`;
        a.addEventListener('click', onClick, true);
        return;
      }
    }

    // ── Case 2: find the text node containing the email address ───────────────
    // If the email is the entire content of a leaf element, style that element.
    // Otherwise splice a chip <span> into the text node.
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent.includes(email)) continue;
      const parent = node.parentNode;

      // Leaf element whose full text is just the email → style it in place
      if (!parent.children.length && node.textContent.trim() === email && parent !== row) {
        if (parent.dataset.dlmChip) return; // element-level guard
        parent.dataset.dlmChip = '1';
        parent.dataset.emailOrigin = chipOrigin;
        parent.dataset.emailDest   = chipDest;
        parent.dataset.emailDate   = chipDate;
        parent.classList.add('dlm-email-chip');
        parent.title = `Click to email ${email}`;
        parent.addEventListener('click', onClick, true);
        return;
      }

      // Email is embedded in a larger text block → wrap it in a chip <span>
      // The newly created <span> is always fresh, so no guard needed here.
      const idx  = node.textContent.indexOf(email);
      const chip = document.createElement('span');
      chip.className = 'dlm-email-chip';
      chip.dataset.dlmChip = '1';
      chip.dataset.emailOrigin = chipOrigin;
      chip.dataset.emailDest   = chipDest;
      chip.dataset.emailDate   = chipDate;
      chip.textContent = email;
      chip.title = `Click to email ${email}`;
      chip.addEventListener('click', onClick, true);
      parent.insertBefore(document.createTextNode(node.textContent.slice(0, idx)),             node);
      parent.insertBefore(chip,                                                                 node);
      parent.insertBefore(document.createTextNode(node.textContent.slice(idx + email.length)), node);
      parent.removeChild(node);
      return;
    }
    // If email is only in an attribute and not visible text, show nothing.
  }

    // ── Extract origin/destination from DAT row ─────────────────────────────────
  function getCities(row) {
    // Primary: confirmed selectors from HTML inspector
    const oEl = row.querySelector('[class*="origin"] .truncate, [class*="origin"]');
    const dEl = row.querySelector('[class*="destination"] .truncate, [class*="destination"]');

    let origin = oEl ? oEl.textContent.trim() : '';
    let dest   = dEl ? dEl.textContent.trim() : '';

    // Clean up — remove DH-O numbers that get mixed in
    origin = origin.replace(/^\d+\s*/, '').trim();
    dest   = dest.replace(/^\d+\s*/, '').trim();

    // Strip a glued/spaced DAT column-header label (see COL_LABEL definition).
    origin = stripColLabel(origin);
    dest   = stripColLabel(dest);

    const LABEL_SKIP = /^(my account|origin|destination|filter|search)/i;
    if (origin.length > 3 && dest.length > 3 && !LABEL_SKIP.test(dest) && !LABEL_SKIP.test(origin)) {
      return { origin, dest };
    }

    // Fallback: regex scan on row text. The greedy capture can swallow an adjacent
    // column label ("Trip Gonzales") and the primary-branch strip above never ran
    // on these tokens — so apply COL_LABEL here too, and exclude bare labels.
    const text = row.textContent;
    const CITY_RE = /\b([A-Za-z][A-Za-z\s\.]{1,22}),\s*([A-Z]{2})\b/g;
    const SKIP_WORDS = ['Van','Full','Partial','Reefer','Flat','Step', ...COL_LABEL_WORDS];
    const cities = [];
    let m;
    CITY_RE.lastIndex = 0;
    while ((m = CITY_RE.exec(text)) !== null && cities.length < 2) {
      const c = stripColLabel(m[1].trim());
      if (c.length >= 2 && !SKIP_WORDS.includes(c)) {
        cities.push(`${c}, ${m[2]}`);
      }
    }
    if (!cities[0] && !cities[1] && !origin && !dest) {
      _cityFailCount++;
    }
    return { origin: cities[0] || origin, dest: cities[1] || dest };
  }

  function getBroker(row) {
    const el = row.querySelector('[class*="company"], [class*="Company"], [class*="carrier"]');
    if (el) {
      const t = el.textContent.trim();
      if (t && t.length > 1 && t.length < 80 && !/^\d+$/.test(t)) return t;
    }
    return '';
  }

  // ── Process one row ─────────────────────────────────────────────────────────
  function processRow(row) {
    if (!row || row.offsetWidth < 100) return;

    let { origin, dest } = getCities(row);
    // Strip any text after the state code — the extension's own badge ("✓ 1x")
    // gets appended inside the origin element and would otherwise poison both
    // the skip-guard comparison and the normKey lookup.
    origin = origin.replace(/(,\s*[A-Z]{2})\b.*$/, '$1').trim();
    if (dest) dest = dest.replace(/(,\s*[A-Z]{2})\b.*$/, '$1').trim();
    if (!origin || origin.length < 3) return;

    // Skip rows whose city data hasn't changed since the last scan — this is
    // the main guard against redundant matching on unchanged visible rows.
    // NOTE: only stamped after a successful match, so unmatched rows never
    // trigger this guard and are retried on every scan until indexes are ready.
    if (row.dataset.dlmOrigin === origin && row.dataset.dlmDest === (dest || '')) return;

    // Row is new or DAT reused the element for different data — clear stale state.
    row.classList.remove('dlm-green', 'dlm-yellow', 'dlm-blue', 'dlm-purple');
    const oldBadge = row.querySelector('.dlm-badge');
    if (oldBadge) oldBadge.remove();
    row.querySelectorAll('.dlm-badge-host').forEach(el => el.classList.remove('dlm-badge-host'));
    delete row.dataset.dlmChip; // let injectEmailChip re-run for the new row content

    // In Pro+laneiq mode: stamp origin/dest so flushExpand can read them,
    // but skip all matching and highlighting — the API handles lane data.
    if (useDB) {
      row.dataset.dlmOrigin = origin;
      row.dataset.dlmDest   = dest || '';
      const cacheKey = `${origin}|${dest || ''}`;
      const cached = _dbMatchCache[cacheKey];
      if (cached && !useCSV) {
        row.classList.remove('dlm-green', 'dlm-yellow', 'dlm-blue', 'dlm-purple');
        if (cached.matchType === 'origin') {
          row.classList.add('dlm-blue');
        } else {
          row.classList.add(cached.loadCount >= 3 ? 'dlm-green' : 'dlm-yellow');
        }
      }
      if (!useCSV) return;
    }

    // If indexes aren't loaded yet, leave the row unstamped so the next scan
    // retries it. Stamping before indexes are ready would lock the row out
    // of the skip-guard above, making it permanently invisible to matching.
    if (!useCSV) return;
    if (!odIndex || Object.keys(odIndex).length === 0) return;

    const datBroker = getBroker(row);
    const odM = dest ? findOD(origin, dest) : [];
    const oM  = findO(origin);
    const bM  = datBroker ? findBroker(datBroker, origin) : [];

    if (!odM.length && !oM.length && !bM.length) return;

    // Only stamp origin/dest after a confirmed match — keeps the row eligible
    // for retry on future scans if this pass found nothing.
    row.dataset.dlmOrigin = origin;
    row.dataset.dlmDest   = dest || '';

    // Determine tier
    // 🟣 PURPLE = same origin + destination + same broker
    // 🟢 GREEN  = same origin + destination, 3+ times
    // 🟡 YELLOW = same origin + destination, 1-2 times
    // 🔵 BLUE   = same origin city + state only
    let cls, badgeCls, badgeTxt;

    const normDatBroker = datBroker ? normBroker(datBroker) : '';
    const normDatFirst = normDatBroker.split(' ')[0];
    const sameLineBroker = normDatFirst && odM.filter(r =>
      r.broker && normBroker(r.broker).includes(normDatFirst)
    );

    if (sameLineBroker && sameLineBroker.length > 0) {
      cls = 'dlm-purple'; badgeCls = 'dlm-b-purple';
      badgeTxt = `🔥 ${odM.length}x · ${datBroker.split(' ')[0]}`;
    } else if (odM.length >= 3) {
      cls = 'dlm-green';  badgeCls = 'dlm-b-green';  badgeTxt = `✓ ${odM.length}x`;
    } else if (odM.length >= 1) {
      cls = 'dlm-yellow'; badgeCls = 'dlm-b-yellow'; badgeTxt = `✓ ${odM.length}x`;
    } else if (oM.length >= 1) {
      cls = 'dlm-blue'; // no badge for blue tier
    } else {
      return;
    }

    row.classList.add(cls);

    // Add badge — append to origin container (never inside .truncate, which clips long city names)
    if (badgeTxt) {
      const oEl = row.querySelector('div[class="origin"], [class*="origin"]') || row;
      if (!oEl.querySelector('.dlm-badge')) {
        oEl.classList.add('dlm-badge-host');
        const badge = document.createElement('span');
        badge.className = `dlm-badge ${badgeCls}`;
        badge.textContent = badgeTxt;
        oEl.appendChild(badge);
      }
    }

    row.dataset.dlmBroker = datBroker || '';

    // Re-attach click listener every time this row element is processed.
    // DAT re-renders row elements on click (React reconciliation), so a fresh
    // DOM node loses any previously attached listener. dlmBound guards against
    // duplicate listeners on the same element instance.
    if (!row.dataset.dlmBound) {
      row.dataset.dlmBound = '1';
      row.addEventListener('click', () => {
        // Panel opening handled by flushExpand (addedNodes MutationObserver)
        // so it only fires on row-open, not row-close.
      });
    }
  }

  // ── Search ───────────────────────────────────────────────────────────────────
  // Returns true if query looks like a load number: all digits, 6 or more chars.
  function isLoadNumQuery(q) { return /^\d{6,}$/.test(q); }

  function searchHistory(query) {
    if (!oIndex) return [];
    const q = query.toLowerCase().trim();
    if (q.length < 2) return [];
    const seen = new Set();
    const results = [];
    for (const recs of Object.values(oIndex)) {
      for (const r of recs) {
        const key = r.loadNum || (r.origin + r.puDate);
        if (seen.has(key)) continue;
        if ((r.origin          || '').toLowerCase().includes(q) ||
            (r.destination     || '').toLowerCase().includes(q) ||
            (r.broker          || '').toLowerCase().includes(q) ||
            (r.loadNum         || '').toLowerCase().includes(q) ||
            (r.pickupCompany   || '').toLowerCase().includes(q) ||
            (r.deliveryCompany || '').toLowerCase().includes(q) ||
            (r.commodity       || '').toLowerCase().includes(q)) {
          seen.add(key);
          results.push(r);
        }
      }
    }
    return results.sort((a, b) => parseDate(b.puDate) - parseDate(a.puDate)).slice(0, 50);
  }

  // Full-index load number lookup — searches every record in oIndex regardless
  // of whether it appeared in the current panel match. Used when the query
  // looks like a load number (6+ digits) so dispatchers can pull up any
  // historical record by load # even when it isn't a lane match.
  function searchByLoadNum(loadNum) {
    if (!oIndex) return [];
    const seen = new Set();
    const results = [];
    for (const recs of Object.values(oIndex)) {
      for (const r of recs) {
        if ((r.loadNum || '') === loadNum) {
          const key = r.loadNum + '|' + r.origin + '|' + r.puDate;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push(r);
        }
      }
    }
    return results.sort((a, b) => parseDate(b.puDate) - parseDate(a.puDate));
  }

  function showSearchResults(query) {
    const q = query.trim();
    const body = document.getElementById('dlm-body');
    if (!body) return;

    // Load number mode: full-index lookup, distinct label
    if (isLoadNumQuery(q)) {
      const loadResults = searchByLoadNum(q);
      // Also include any text-search matches (e.g. broker named "1234567") but
      // avoid double-counting records already found by load number lookup.
      const textResults = searchHistory(q).filter(r => (r.loadNum || '') !== q);
      const combined = [...loadResults, ...textResults];

      if (!combined.length) {
        body.innerHTML = `<div style="text-align:center;padding:36px 20px;color:#aeaeb2;font-size:13px;line-height:1.6">No records found for load #<br><strong style="color:#6e6e73;font-weight:600">${esc(q)}</strong></div>`;
        return;
      }

      let html = '';
      if (loadResults.length) {
        const st = calcStats(loadResults);
        html += `
          <div class="dlm-sum">
            <div style="font-size:10px;color:#aeaeb2;letter-spacing:.05em;text-transform:uppercase;margin-bottom:8px;font-weight:600">CSV Lookup</div>
            <div class="dlm-lane" style="color:#6e6e73">Load # ${esc(q)}</div>
            <div class="dlm-stats">
              <div><div class="dlm-sv">${loadResults.length}</div><div class="dlm-sl">Records</div></div>
              <div><div class="dlm-sv">${st.avg}</div><div class="dlm-sl">Avg Rate</div></div>
              <div><div class="dlm-sv">${st.best}</div><div class="dlm-sl">Best Rate</div></div>
            </div>
          </div>
          <div class="dlm-stitle" style="color:#a78bfa">CSV Lookup · ${loadResults.length} record${loadResults.length !== 1 ? 's' : ''}</div>
          ${renderRecs(loadResults, '#a78bfa', 50, true, true)}`;
      }
      if (textResults.length) {
        html += `<div class="dlm-stitle">Other Matches · ${textResults.length}</div>${renderRecs(textResults, '#c7c7cc', 20)}`;
      }
      body.innerHTML = html;
      return;
    }

    // Normal text search mode
    const results = searchHistory(q);
    if (!results.length) {
      body.innerHTML = `<div style="text-align:center;padding:36px 20px;color:#aeaeb2;font-size:13px;line-height:1.6">No results for<br><strong style="color:#6e6e73;font-weight:600">${esc(q)}</strong></div>`;
      return;
    }
    const st = calcStats(results);
    const cap = results.length >= 50;
    body.innerHTML = `
      <div class="dlm-sum">
        <div style="font-size:10px;color:#aeaeb2;letter-spacing:.05em;text-transform:uppercase;margin-bottom:8px;font-weight:600">Search</div>
        <div class="dlm-lane" style="color:#6e6e73">${esc(q)}</div>
        <div class="dlm-stats">
          <div><div class="dlm-sv">${cap ? '50+' : results.length}</div><div class="dlm-sl">Results</div></div>
          <div><div class="dlm-sv">${st.avg}</div><div class="dlm-sl">Avg Rate</div></div>
          <div><div class="dlm-sv">${st.best}</div><div class="dlm-sl">Best Rate</div></div>
        </div>
      </div>
      <div class="dlm-stitle">Matching Loads${cap ? ' · Top 50' : ''}</div>
      ${renderRecs(results, '#c7c7cc', 50)}`;
  }

  // ── Panel ───────────────────────────────────────────────────────────────────
  function renderTemplatesBody(bodyEl) {
    if (!bodyEl) return;
    const infoCard = `
      <div style="background:#fff;border-radius:12px;padding:12px 14px;margin-bottom:10px;border:2px solid #e5e5ea;box-shadow:0 1px 4px rgba(0,0,0,.06)">
        <div style="font-size:11px;font-weight:700;color:#1d1d1f;letter-spacing:.01em;margin-bottom:10px">Signature</div>
        <textarea id="dlm-info-signature" rows="4" placeholder="Alex&#10;LaneIQ&#10;(555) 123-4567"
               style="width:100%;border:1px solid #e5e5ea;border-radius:8px;padding:7px 9px;font-size:12px;font-family:inherit;color:#1d1d1f;background:#f9f9fb;outline:none;box-sizing:border-box;margin-bottom:10px;resize:vertical">${esc(signature)}</textarea>
        <button class="dlm-info-save"
                style="width:100%;padding:8px;background:#0058e0;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:700;font-family:inherit;cursor:pointer;letter-spacing:.01em">
          Save
        </button>
      </div>`;
    const sendFromCard = `
      <div style="background:#fff;border-radius:12px;padding:12px 14px;margin-bottom:10px;border:2px solid #e5e5ea;box-shadow:0 1px 4px rgba(0,0,0,.06)">
        <div style="font-size:10px;font-weight:600;color:#aeaeb2;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Send From — Outbound Email</div>
        <div style="font-size:10px;color:#aeaeb2;margin-bottom:10px">Used for one-click email sending to brokers</div>
        ${gmailOAuthEmail
          ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
               <span style="font-size:12px;font-weight:600;color:#34c759">✅ ${esc(gmailOAuthEmail)}</span>
               <button class="dlm-gmail-disconnect" style="padding:6px 12px;background:#ff3b30;color:#fff;border:none;border-radius:8px;font-size:11px;font-weight:700;font-family:inherit;cursor:pointer;white-space:nowrap">Disconnect</button>
             </div>`
          : outlookOAuthEmail
          ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
               <span style="font-size:12px;font-weight:600;color:#34c759">✅ ${esc(outlookOAuthEmail)}</span>
               <button class="dlm-outlook-disconnect" style="padding:6px 12px;background:#ff3b30;color:#fff;border:none;border-radius:8px;font-size:11px;font-weight:700;font-family:inherit;cursor:pointer;white-space:nowrap">Disconnect</button>
             </div>`
          : `<div>
               <button class="dlm-gmail-connect" style="width:100%;padding:8px;background:#0058e0;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:700;font-family:inherit;cursor:pointer;margin-bottom:8px">Connect Gmail</button>
               <button class="dlm-outlook-connect" style="width:100%;padding:8px;background:#0f6cbd;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:700;font-family:inherit;cursor:pointer;margin-bottom:0">Connect Outlook</button>
             </div>`
        }
      </div>`;
    const tmpls = emailTemplates.length ? emailTemplates : DEFAULT_TEMPLATES;
    bodyEl.innerHTML = sendFromCard + infoCard + tmpls.map((t, i) => {
      const active = i === activeTemplateIndex;
      return `
        <div class="dlm-tpl-card${active ? ' dlm-tpl-active' : ''}" data-tpl-index="${i}"
             style="background:#fff;border-radius:12px;padding:12px 14px;margin-bottom:10px;
                    border:2px solid ${active ? '#34c759' : '#e5e5ea'};
                    box-shadow:0 1px 4px rgba(0,0,0,.06)">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <span style="font-size:11px;font-weight:700;color:#1d1d1f;letter-spacing:.01em">${esc(t.name)}</span>
            <button class="dlm-tpl-use" data-tpl-index="${i}"
                    style="font-size:10px;font-weight:700;padding:4px 10px;border-radius:7px;border:none;cursor:${active ? 'default' : 'pointer'};
                           background:${active ? '#34c759' : '#0058e0'};color:#fff;opacity:${active ? '.7' : '1'};
                           font-family:inherit;letter-spacing:.01em;transition:opacity .12s">
              ${active ? '✓ Active' : 'Use This'}
            </button>
          </div>
          <div style="font-size:10px;font-weight:600;color:#aeaeb2;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px">Subject</div>
          <textarea class="dlm-tpl-area dlm-tpl-subject" data-tpl-index="${i}" rows="2"
                    style="margin-bottom:8px">${esc(t.subject)}</textarea>
          <div style="font-size:10px;font-weight:600;color:#aeaeb2;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px">Body</div>
          <textarea class="dlm-tpl-area dlm-tpl-body" data-tpl-index="${i}" rows="6">${esc(t.body)}</textarea>
          <div style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end">
            <button class="dlm-tpl-reset" data-tpl-index="${i}"
              style="padding:6px 12px;background:rgba(0,0,0,.06);color:#6e6e73;border:none;border-radius:8px;font-size:11px;font-weight:600;font-family:inherit;cursor:pointer">
              Reset
            </button>
            <button class="dlm-tpl-save" data-tpl-index="${i}"
              style="padding:6px 14px;background:#0058e0;color:#fff;border:none;border-radius:8px;font-size:11px;font-weight:700;font-family:inherit;cursor:pointer">
              Save
            </button>
          </div>
        </div>`;
    }).join('') +
    `<div style="padding:4px 2px 8px;font-size:10px;color:#aeaeb2;line-height:1.5">
       Variables: {origin} · {destination} · {date} · {miles} · {signature}
     </div>`;
  }

  function renderSetupBody(bodyEl) {
    const tmpls = filesMeta || [];
    const LABEL = 'font-size:10px;font-weight:600;color:#aeaeb2;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px';
    const CARD  = 'background:#fff;border-radius:12px;padding:12px 14px;margin-bottom:10px;border:2px solid #e5e5ea;box-shadow:0 1px 4px rgba(0,0,0,.06)';
    const INPUT = 'width:100%;border:1px solid #e5e5ea;border-radius:8px;padding:7px 9px;font-size:12px;font-family:inherit;color:#1d1d1f;background:#f9f9fb;outline:none;box-sizing:border-box';
    const BTN   = 'padding:7px 12px;background:#0058e0;color:#fff;border:none;border-radius:8px;font-size:11px;font-weight:700;font-family:inherit;cursor:pointer;white-space:nowrap';

    const fileListHTML = tmpls.length
      ? tmpls.map((f, i) => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(0,0,0,.04)">
            <span style="font-size:12px;font-weight:600;color:#34c759;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">📄 ${esc(f.name)}</span>
            <span style="display:flex;align-items:center;gap:8px">
              <span style="font-size:10px;color:#aeaeb2">${f.count.toLocaleString()} lanes</span>
              <button class="dlm-setup-file-remove" data-file-idx="${i}"
                      style="background:none;border:none;color:#c7c7cc;cursor:pointer;font-size:13px;padding:0 2px;line-height:1;transition:color .15s">✕</button>
            </span>
          </div>`).join('')
      : '<div style="font-size:12px;color:#aeaeb2;padding:8px 0">No CSV files loaded yet</div>';

    bodyEl.innerHTML = `
      <div style="${CARD}">
        <div style="${LABEL}">Data Source</div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div>
            <div style="font-size:13px;font-weight:500;color:#1d1d1f">My CSV</div>
            <div style="font-size:11px;color:#aeaeb2">Your own freight history</div>
          </div>
          <label style="position:relative;width:44px;height:24px;cursor:pointer;flex-shrink:0">
            <input id="dlm-setup-csv-toggle" type="checkbox" ${useCSV ? 'checked' : ''} style="opacity:0;width:0;height:0;position:absolute">
            <span id="dlm-csv-slider" style="position:absolute;inset:0;background:${useCSV ? '#34c759' : '#c7c7cc'};border-radius:34px;transition:background .2s">
              <span style="position:absolute;width:18px;height:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:transform .2s;transform:${useCSV ? 'translateX(20px)' : 'none'};box-shadow:0 1px 3px rgba(0,0,0,.25)"></span>
            </span>
          </label>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-size:13px;font-weight:500;color:#1d1d1f">LaneIQ Database ${licenseTier !== 'pro' ? '<span style="font-size:10px;color:#ff9500">🔒 Pro</span>' : ''}</div>
            <div style="font-size:11px;color:#aeaeb2">Market-wide rate data</div>
          </div>
          <label style="position:relative;width:44px;height:24px;cursor:${licenseTier === 'pro' ? 'pointer' : 'default'};flex-shrink:0;opacity:${licenseTier === 'pro' ? '1' : '.5'}">
            <input id="dlm-setup-db-toggle" type="checkbox" ${useDB ? 'checked' : ''} ${licenseTier !== 'pro' ? 'disabled' : ''} style="opacity:0;width:0;height:0;position:absolute">
            <span id="dlm-db-slider" style="position:absolute;inset:0;background:${useDB ? '#34c759' : '#c7c7cc'};border-radius:34px;transition:background .2s">
              <span style="position:absolute;width:18px;height:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:transform .2s;transform:${useDB ? 'translateX(20px)' : 'none'};box-shadow:0 1px 3px rgba(0,0,0,.25)"></span>
            </span>
          </label>
        </div>
        <div id="dlm-setup-ds-status" style="font-size:11px;color:#aeaeb2;margin-top:8px">
          ${useCSV && useDB ? 'Both sources active' : useCSV ? 'My CSV active' : useDB ? 'LaneIQ Database active' : 'No data source selected'}
        </div>
      </div>

      <div style="display:flex;align-items:flex-start;gap:8px;background:#e8f4ff;border:1px solid #99caff;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:12px;color:#3a3a3a;line-height:1.45;">
        <span style="font-size:14px;margin-top:1px;">🔒</span>
        <span style="font-weight:500;">Your load data stays in your browser. Only <strong>YOU</strong> can see it or manage it.</span>
      </div>

      <div style="${CARD}">
        <div style="${LABEL}">Freight History CSV</div>
        <div id="dlm-setup-file-list">${fileListHTML}</div>
        <div id="dlm-setup-dropzone" style="border:2px dashed rgba(0,0,0,.12);border-radius:10px;padding:16px;text-align:center;cursor:pointer;margin-top:8px;background:#fafafa;transition:border-color .15s,background .15s">
          <div style="font-size:20px;color:#aeaeb2;margin-bottom:5px">📂</div>
          <div style="font-size:12px;font-weight:600;color:#6e6e73">Drop CSV files here</div>
          <div style="font-size:11px;color:#aeaeb2;margin-top:2px">or click to browse</div>
          <input id="dlm-setup-file-input" type="file" accept=".csv" multiple style="display:none">
        </div>
        <div id="dlm-setup-progress" style="display:none;margin-top:8px">
          <div style="height:3px;background:rgba(0,0,0,.08);border-radius:2px;overflow:hidden">
            <div id="dlm-setup-progress-fill" style="height:100%;background:#0058e0;width:0%;transition:width .3s"></div>
          </div>
          <div id="dlm-setup-progress-text" style="font-size:10px;color:#aeaeb2;margin-top:4px;text-align:center">Processing…</div>
        </div>
      </div>

      <div style="${CARD}">
        <div style="${LABEL}">Gmail — Rate Confirmations</div>
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <input id="dlm-setup-gmail-input" type="text" value="${esc(gmailEmail)}" placeholder="Paste Gmail URL or your email"
                 style="${INPUT};flex:1;min-width:0">
          <button class="dlm-setup-gmail-save" style="${BTN}">Save</button>
        </div>
        <div style="display:flex;gap:4px;margin-bottom:8px">
          ${[0,1,2,3,4].map(n => `<button class="dlm-setup-acct-btn" data-gmail-idx="${n}"
              style="flex:1;padding:5px 0;border:1px solid rgba(0,0,0,.1);border-radius:6px;font-size:11px;font-weight:600;font-family:inherit;cursor:pointer;
                     background:${n === gmailIndex ? '#0058e0' : 'rgba(0,0,0,.05)'};
                     color:${n === gmailIndex ? '#fff' : '#6e6e73'}">${n}</button>`).join('')}
        </div>
        <div style="font-size:10px;color:#aeaeb2;line-height:1.5;margin-bottom:6px">Open your freight Gmail → check URL: mail.google.com/mail/<strong>u/1</strong>/</div>
        <div id="dlm-setup-gmail-status" style="font-size:11px;font-weight:500;color:${activeMailProvider === 'gmail' ? '#34c759' : '#aeaeb2'}">
          ${activeMailProvider === 'gmail' ? `✓ Connected · ${esc(gmailEmail || 'Account #'+gmailIndex)}` : 'Not active'}
        </div>
      </div>

      <div style="${CARD}">
        <div style="${LABEL}">Outlook — Rate Confirmations</div>
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <input id="dlm-setup-outlook-input" type="text" value="${esc(outlookEmail)}" placeholder="Paste Outlook URL or your email"
                 style="${INPUT};flex:1;min-width:0">
          <button class="dlm-setup-outlook-save" style="${BTN}">Save</button>
        </div>
        <div style="font-size:10px;color:#aeaeb2;line-height:1.5;margin-bottom:6px">Opens your Outlook inbox — search the load # manually · using outlook.${outlookHost}</div>
        <div id="dlm-setup-outlook-status" style="font-size:11px;font-weight:500;color:${activeMailProvider === 'outlook' ? '#34c759' : '#aeaeb2'}">
          ${activeMailProvider === 'outlook' ? `✓ Connected${outlookEmail ? ' · '+esc(outlookEmail) : ''}` : 'Not active'}
        </div>
      </div>

      <div style="${CARD}">
        <div style="${LABEL}">Highlight Guide</div>
        ${[['rgba(167,139,250,.3)','#a78bfa','Same lane + same broker — call immediately'],
           ['rgba(52,199,89,.25)','#34c759','Same lane — ran 3+ times'],
           ['rgba(251,191,36,.3)','#fbbf24','Same lane — ran 1–2 times'],
           ['rgba(96,165,250,.3)','#60a5fa','Same pickup city + state']].map(([bg,border,label]) =>
          `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:11px;color:#6e6e73">
             <div style="width:12px;height:12px;border-radius:3px;flex-shrink:0;background:${bg};border:1px solid ${border}"></div>${label}
           </div>`).join('')}
      </div>`;

    // Wire drop zone after innerHTML is set
    const dz  = bodyEl.querySelector('#dlm-setup-dropzone');
    const fi  = bodyEl.querySelector('#dlm-setup-file-input');
    if (dz && fi) {
      dz.addEventListener('click',     () => fi.click());
      dz.addEventListener('dragover',  e => { e.preventDefault(); dz.style.borderColor='#0058e0'; dz.style.background='rgba(0,88,224,.04)'; });
      dz.addEventListener('dragleave', () => { dz.style.borderColor=''; dz.style.background='#fafafa'; });
      dz.addEventListener('drop',      e => { e.preventDefault(); dz.style.borderColor=''; dz.style.background='#fafafa'; processSetupCSV(Array.from(e.dataTransfer.files), bodyEl); });
      fi.addEventListener('change',    e => processSetupCSV(Array.from(e.target.files), bodyEl));
    }
    // Wire data source toggles after innerHTML
    const csvToggle = bodyEl.querySelector('#dlm-setup-csv-toggle');
    const dbToggle  = bodyEl.querySelector('#dlm-setup-db-toggle');
    if (csvToggle) csvToggle.addEventListener('change', async () => {
      useCSV = csvToggle.checked;
      await chrome.storage.local.set({ useCSV });
      renderSetupBody(bodyEl);
    });
    if (dbToggle) dbToggle.addEventListener('change', async () => {
      if (licenseTier !== 'pro') {
        dbToggle.checked = false;
        const st = bodyEl.querySelector('#dlm-setup-ds-status');
        if (st) { st.textContent = '🔒 Pro feature — upgrade to unlock LaneIQ Database'; st.style.color = '#ff9500'; }
        return;
      }
      useDB = dbToggle.checked;
      await chrome.storage.local.set({ useDB });
      renderSetupBody(bodyEl);
    });
  }

  async function processSetupCSV(files, bodyEl) {
    const csvFiles = files.filter(f => f.name.endsWith('.csv'));
    if (!csvFiles.length) return;
    const progress     = bodyEl.querySelector('#dlm-setup-progress');
    const progressFill = bodyEl.querySelector('#dlm-setup-progress-fill');
    const progressText = bodyEl.querySelector('#dlm-setup-progress-text');
    if (progress) progress.style.display = 'block';
    const stored = await chrome.storage.local.get(['filesMeta','odIndex','oIndex','brokerIndex']);
    let existingMeta = stored.filesMeta || [];
    let existingOD   = stored.odIndex   || {};
    let existingO    = stored.oIndex    || {};
    let existingBrk  = stored.brokerIndex || {};
    const startIdx = existingMeta.length;
    const newMeta  = [];
    for (let i = 0; i < csvFiles.length; i++) {
      const file = csvFiles[i];
      if (progressText) progressText.textContent = `Parsing ${file.name}…`;
      if (progressFill) progressFill.style.width  = Math.round(20 + (i / csvFiles.length) * 60) + '%';
      const text = await file.text();
      const rows = parseCSV(text);
      const { odIndex: nOD, oIndex: nO, brokerIndex: nB, count } = buildIndexesFromCSVRows(rows, startIdx + i);
      if (count === 0) { if (progress) progress.style.display = 'none'; return; }
      existingOD  = mergeCSVIndexes(existingOD, nOD);
      existingO   = mergeCSVIndexes(existingO,  nO);
      existingBrk = mergeCSVIndexes(existingBrk, nB);
      newMeta.push({ name: file.name, count });
    }
    if (progressFill) progressFill.style.width = '90%';
    if (progressText) progressText.textContent = 'Saving…';
    const combinedMeta = existingMeta.concat(newMeta);
    const totalCount   = combinedMeta.reduce((s, f) => s + f.count, 0);
    await chrome.storage.local.set({ filesMeta: combinedMeta, odIndex: existingOD, oIndex: existingO, brokerIndex: existingBrk, laneCount: totalCount, indexVersion: INDEX_VERSION, loadedAt: new Date().toISOString() });
    filesMeta = combinedMeta;
    if (progress) { progressFill.style.width = '100%'; progressText.textContent = `Done — ${totalCount.toLocaleString()} lanes`; setTimeout(() => { progress.style.display = 'none'; renderSetupBody(bodyEl); }, 1200); }
  }

  function showLovedSearchResults(q) {
    const bodyEl = document.getElementById('dlm-body');
    if (!bodyEl) return;
    const lq = q.toLowerCase();
    const filtered = Object.values(lovedLoads)
      .map(e => e.record)
      .filter(r =>
        (r.origin          || '').toLowerCase().includes(lq) ||
        (r.destination     || '').toLowerCase().includes(lq) ||
        (r.broker          || '').toLowerCase().includes(lq) ||
        String(r.loadNum   || '').toLowerCase().includes(lq) ||
        (r.pickupCompany   || '').toLowerCase().includes(lq) ||
        (r.deliveryCompany || '').toLowerCase().includes(lq) ||
        (r.commodity       || '').toLowerCase().includes(lq)
      );
    if (!filtered.length) {
      bodyEl.innerHTML = `<div style="text-align:center;padding:36px 20px;color:#aeaeb2;font-size:13px;line-height:1.6">No preferred loads match<br><strong style="color:#6e6e73;font-weight:600">${esc(q)}</strong></div>`;
      return;
    }
    bodyEl.innerHTML =
      '<div class="dlm-stitle">Matching Preferred · ' + filtered.length + '</div>' +
      renderRecs(filtered, '#e05c5c', 999, true, true, new Set(Object.keys(lovedLoads)));
    refreshNoteBadges(bodyEl);
  }

  async function refreshNoteBadges(container) {
    const badges = Array.from((container || document).querySelectorAll('.dlm-note-badge'));
    if (!badges.length) return;
    const keys = badges.map(b => b.dataset.noteKey);
    const stored = await chrome.storage.local.get(keys);
    badges.forEach(b => {
      b.classList.toggle('dlm-note-has', !!(stored[b.dataset.noteKey] || '').trim());
    });
  }

  function countOrigins() {
    const counts = {};
    document.querySelectorAll('[data-dlm-origin]').forEach(el => {
      const city = el.dataset.dlmOrigin;
      if (city) counts[city] = (counts[city] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  }

  function renderRegionsBody(bodyEl) {
    const top = countOrigins();
    const maxCount = top.length ? top[0][1] : 1;
    const rows = top.length
      ? top.map(([city, count]) => {
          const pct = Math.round((count / maxCount) * 100);
          return `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(0,0,0,.04)">
              <div style="flex:1;min-width:0">
                <div style="font-size:12px;font-weight:600;color:#1d1d1f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(city)}</div>
                <div style="margin-top:3px;height:3px;border-radius:2px;background:#e5e5ea;overflow:hidden">
                  <div style="height:100%;width:${pct}%;background:#0058e0;border-radius:2px;transition:width .3s"></div>
                </div>
              </div>
              <div style="font-size:12px;font-weight:700;color:#0058e0;flex-shrink:0;min-width:20px;text-align:right">${count}</div>
            </div>`;
        }).join('')
      : '<div style="text-align:center;padding:20px 0;color:#aeaeb2;font-size:12px">No highlighted loads on screen yet</div>';

    bodyEl.innerHTML = `
      <a href="https://iq.dat.com/market-conditions/conditions/REEFER~KMA~PREV_BUSINESS_DAY~OUT~~~0"
         target="_blank"
         style="display:flex;align-items:center;justify-content:center;gap:6px;margin:12px;padding:10px 14px;background:#0058e0;color:#fff;border-radius:10px;font-size:12px;font-weight:700;text-decoration:none;letter-spacing:.01em;box-shadow:0 2px 8px rgba(0,88,224,.28);transition:background .15s"
         onmouseover="this.style.background='#004ccc'"
         onmouseout="this.style.background='#0058e0'">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="flex-shrink:0">
          <path d="M2 12L6 8l3 3 5-6" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        View DAT Market Conditions
      </a>
      <div style="padding:0 12px">
        <div class="dlm-stitle" style="margin-bottom:6px">Top Origins on Screen${top.length ? ' · ' + top.length : ''}</div>
        ${rows}
      </div>`;
  }

  function switchTab(name) {
    _activeTab = name;
    clearInterval(_regionsTimer); _regionsTimer = null;
    document.querySelectorAll('#dlm-panel .dlm-tab').forEach(t =>
      t.classList.toggle('dlm-tab-active', t.dataset.tab === name)
    );
    const _tabLabels = { history: 'Load History', loved: 'Preferred', regions: 'Hot Regions', templates: 'Templates', setup: 'Setup', notes: 'Notes' };
    const titleEl = document.getElementById('dlm-title');
    if (titleEl && name !== 'history') titleEl.innerHTML = '◈ ' + (_tabLabels[name] || name) + '<small> · drag to move</small>';
    if (titleEl && name === 'history') titleEl.innerHTML = '◈ Load History<small> · drag to move</small>';
    const searchWrap = document.getElementById('dlm-search-wrap');
    const bodyEl     = document.getElementById('dlm-body');
    if (!bodyEl) return;
    bodyEl.style.padding = '';
    bodyEl.style.background = '';
    bodyEl.style.overflow = '';
    bodyEl.style.display = '';
    bodyEl.style.flexDirection = '';

    if (name === 'history') {
      if (searchWrap) searchWrap.style.display = '';
      const searchEl = document.getElementById('dlm-search');
      if (searchEl) searchEl.placeholder = 'Search origin, destination, broker, shipper, receiver, commodity, load #…';
      bodyEl.innerHTML = panelBodyHTML ||
        '<div style="text-align:center;padding:36px 20px;color:#aeaeb2;font-size:13px;line-height:1.6">Click a highlighted row<br>to see booking history</div>';
      bodyEl.scrollTop = 0;
    } else if (name === 'loved') {
      if (searchWrap) searchWrap.style.display = '';
      const searchEl = document.getElementById('dlm-search');
      const clearEl  = document.getElementById('dlm-search-clear');
      if (searchEl) { searchEl.value = ''; searchEl.placeholder = 'Search preferred loads…'; }
      if (clearEl)  clearEl.style.display = 'none';
      const recs = Object.values(lovedLoads)
        .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
        .map(e => e.record);
      bodyEl.innerHTML = recs.length
        ? '<div style="padding:10px 14px 6px;font-size:12px;font-weight:600;color:#3a3a3c;line-height:1.5">Follow up with your brokers — let them know you\'re available for these lanes again.</div>' +
          '<div class="dlm-stitle">Preferred Loads · ' + recs.length + '</div>' +
          renderRecs(recs, '#e05c5c', 999, true, true, new Set(Object.keys(lovedLoads)))
        : '<div style="text-align:center;padding:36px 20px;color:#aeaeb2;font-size:13px;line-height:1.6">Tap ♡ on any load<br>to mark it as preferred</div>';
      bodyEl.scrollTop = 0;
      if (recs.length) refreshNoteBadges(bodyEl);
    } else if (name === 'templates') {
      if (searchWrap) searchWrap.style.display = 'none';
      renderTemplatesBody(bodyEl);
      bodyEl.scrollTop = 0;
    } else if (name === 'setup') {
      if (searchWrap) searchWrap.style.display = 'none';
      renderSetupBody(bodyEl);
      bodyEl.scrollTop = 0;
    } else if (name === 'regions') {
      if (searchWrap) searchWrap.style.display = 'none';
      renderRegionsBody(bodyEl);
      _regionsTimer = setInterval(() => {
        const el = document.getElementById('dlm-body');
        if (el && _activeTab === 'regions') renderRegionsBody(el);
      }, 1000);
    } else if (name === 'notes') {
      if (searchWrap) searchWrap.style.display = 'none';
      bodyEl.style.padding = '0';
      bodyEl.style.background = '#fef3c7';
      bodyEl.style.overflow = 'hidden';
      bodyEl.style.display = 'flex';
      bodyEl.style.flexDirection = 'column';
      const panelEl = document.getElementById('dlm-panel');
      const panelHeight = panelEl ? panelEl.offsetHeight : 500;
      chrome.storage.local.get(['dlm-global-notes'], res => {
        const saved = res['dlm-global-notes'] || '';
        bodyEl.innerHTML =
          '<textarea id="dlm-notes-ta" placeholder="Write anything — follow-ups, reminders, to-dos..." ' +
            'style="height:' + (panelHeight - 80) + 'px;min-height:' + (panelHeight - 80) + 'px;width:100%;border:none;background:#fef3c7;padding:14px 16px;font-size:13px;' +
            'font-family:-apple-system,BlinkMacSystemFont,\'SF Pro Text\',system-ui,sans-serif;' +
            'color:#1d1d1f;resize:none;outline:none;box-sizing:border-box;line-height:1.6">' +
          esc(saved) +
          '</textarea>' +
          '<div id="dlm-notes-saved" style="display:none;position:absolute;bottom:10px;right:14px;' +
            'font-size:10px;font-weight:600;color:#92400e;letter-spacing:.02em">Saved</div>';
        const ta = bodyEl.querySelector('#dlm-notes-ta');
        let _notesTimer = null;
        const savedEl = bodyEl.querySelector('#dlm-notes-saved');
        if (!ta) return;
        ta.addEventListener('input', () => {
          clearTimeout(_notesTimer);
          _notesTimer = setTimeout(() => {
            chrome.storage.local.set({ 'dlm-global-notes': ta.value }, () => {
              if (savedEl) { savedEl.style.display = 'block'; setTimeout(() => { savedEl.style.display = 'none'; }, 1500); }
            });
          }, 300);
        });
      });
    }
  }

  function buildPanel() {
    const d = document.createElement('div');
    d.id = 'dlm-panel';
    d.innerHTML = `
      <div id="dlm-resize"></div>
      <div id="dlm-panel-hdr">
        <span id="dlm-title">◈ LANE HISTORY<small> · drag to move</small></span>
        <div style="display:flex;align-items:center;gap:1px">
          <button id="dlm-popout" title="Pop out to floating window">⤢</button>
          <button id="dlm-minimize" title="Minimize">─</button>
          <button id="dlm-close" title="Close">✕</button>
        </div>
      </div>
      <div id="dlm-panel-main">
        <div id="dlm-sidebar">
          <button class="dlm-tab dlm-tab-active" data-tab="history">Load History</button>
          <button class="dlm-tab" data-tab="loved">Preferred</button>
          <button class="dlm-tab" data-tab="regions">Hot Regions</button>
          <button class="dlm-tab" data-tab="templates">Templates</button>
          <button class="dlm-tab" data-tab="setup">Setup</button>
          <button class="dlm-tab" data-tab="notes">Notes</button>
        </div>
        <div id="dlm-content">
          <div id="dlm-search-wrap">
            <span style="color:#4b5563;font-size:13px;flex-shrink:0;line-height:1">⌕</span>
            <input id="dlm-search" type="text" placeholder="Search origin, destination, broker, shipper, receiver, commodity, load #…" autocomplete="off" spellcheck="false">
            <button id="dlm-search-clear" title="Clear search">✕</button>
          </div>
          <div id="dlm-body">
            <div style="text-align:center;padding:36px 20px;color:#aeaeb2;font-size:13px;line-height:1.6;letter-spacing:-.01em">
              Click a highlighted row<br>to see booking history
            </div>
          </div>
        </div>
      </div>
      <div id="dlm-bottom"></div>
      <div id="dlm-corner"></div>`;
    document.body.appendChild(d);

    d.querySelector('#dlm-close').addEventListener('click', () => {
      d.style.display = 'none';
      // Reset collapsed state so the next row-click opens the panel fully expanded
      d.classList.remove('dlm-minimized');
      const minBtn = d.querySelector('#dlm-minimize');
      if (minBtn) { minBtn.textContent = '─'; minBtn.title = 'Minimize'; }
    });
    d.querySelector('#dlm-popout').addEventListener('click', () => {
      // Measure before hiding so coordinates are accurate
      const rect    = d.getBoundingClientRect();
      const chromeH = window.outerHeight - window.innerHeight; // browser toolbar height

      panelPopped = true;
      chrome.storage.local.set({ panelPopped: true });
      d.style.display = 'none';

      chrome.runtime.sendMessage({
        type:   'openPanel',
        left:   Math.round(window.screenX + rect.left),
        top:    Math.round(window.screenY + chromeH + rect.top),
        width:  Math.round(rect.width),
      });
    });

    const minBtn = d.querySelector('#dlm-minimize');
    minBtn.addEventListener('click', () => {
      const minimized = d.classList.toggle('dlm-minimized');
      minBtn.textContent = minimized ? '▢' : '─';
      minBtn.title = minimized ? 'Restore' : 'Minimize';
    });

    const searchInput = d.querySelector('#dlm-search');
    const searchClear = d.querySelector('#dlm-search-clear');
    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = searchInput.value.trim();
      searchClear.style.display = q ? 'block' : 'none';
      if (!q) {
        if (_activeTab === 'loved') switchTab('loved');
        else document.getElementById('dlm-body').innerHTML = panelBodyHTML;
        return;
      }
      searchTimer = setTimeout(() => {
        if (_activeTab === 'loved') showLovedSearchResults(q);
        else showSearchResults(q);
      }, 150);
    });
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchClear.style.display = 'none';
      if (_activeTab === 'loved') switchTab('loved');
      else document.getElementById('dlm-body').innerHTML = panelBodyHTML;
      searchInput.focus();
    });

    const hdr = d.querySelector('#dlm-panel-hdr');
    hdr.addEventListener('mousedown', e => {
      if (e.target.id === 'dlm-close' || e.target.id === 'dlm-minimize') return;
      isDragging = true;
      const r = d.getBoundingClientRect();
      dragOffX = e.clientX - r.left; dragOffY = e.clientY - r.top;
      d.style.transition = 'none'; e.preventDefault();
    });

    function startResize(e, corner) {
      isResizing = true;
      resizeCorner = corner;
      // Capture right edge once — used as fixed anchor throughout the drag
      const rect = d.getBoundingClientRect();
      resizeRightEdge = rect.right;
      // Switch from right-anchored to left-anchored positioning immediately
      d.style.left  = rect.left + 'px';
      d.style.right = 'auto';
      d.classList.add('dlm-resizing');
      e.preventDefault();
      e.stopPropagation();
    }

    d.querySelector('#dlm-resize').addEventListener('mousedown',  e => startResize(e, false));
    d.querySelector('#dlm-corner').addEventListener('mousedown',  e => startResize(e, true));
    d.querySelector('#dlm-bottom').addEventListener('mousedown',  e => {
      isResizing = true;
      resizeCorner = false;
      _resizeBottomOnly = true;
      d.classList.add('dlm-resizing');
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener('mousemove', e => {
      if (isDragging) {
        d.style.left  = Math.max(0, Math.min(window.innerWidth  - d.offsetWidth,  e.clientX - dragOffX)) + 'px';
        d.style.top   = Math.max(0, Math.min(window.innerHeight - d.offsetHeight, e.clientY - dragOffY)) + 'px';
        d.style.right = 'auto';
      }
      if (isResizing) {
        if (!_resizeBottomOnly) {
          const newWidth = Math.max(450, Math.min(650, resizeRightEdge - e.clientX));
          d.style.width = newWidth + 'px';
          d.style.left  = (resizeRightEdge - newWidth) + 'px';
        }
        if (resizeCorner || _resizeBottomOnly) {
          const top = d.getBoundingClientRect().top;
          d.style.height = Math.max(150, Math.min(window.innerHeight - top - 10, e.clientY - top)) + 'px';
        }
      }
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      if (isResizing) {
        if ((resizeCorner || _resizeBottomOnly) && d.style.height) {
          chrome.storage.local.set({ 'dlm-panel-height': d.style.height });
        }
        isResizing = false;
        resizeCorner = false;
        _resizeBottomOnly = false;
        d.classList.remove('dlm-resizing');
      }
    });

    // Tab clicks
    d.querySelectorAll('.dlm-tab').forEach(btn =>
      btn.addEventListener('click', () => switchTab(btn.dataset.tab))
    );

    // Heart (Loved) delegation — survives innerHTML replacements on #dlm-body
    d.querySelector('#dlm-body').addEventListener('click', e => {
      const btn = e.target.closest('.dlm-heart-btn');
      if (!btn) return;
      e.stopPropagation();
      const key = btn.dataset.loadKey;
      if (!key) return;
      if (lovedLoads[key]) {
        const savedEntry = lovedLoads[key];
        delete lovedLoads[key];
        btn.classList.remove('dlm-loved');
        btn.title = 'Save to Preferred';
        chrome.storage.local.set({ lovedLoads });
        if (_activeTab === 'loved') switchTab('loved');
        showUndoToast(key, savedEntry);
      } else {
        const rec = _recPool[key];
        // Strip transient radius-search fields so the "~X mi off" distance tag
        // doesn't leak into the Preferred tab, where it's out of context.
        if (rec) {
          const { _oGap, _dGap, ...cleanRec } = rec;
          lovedLoads[key] = { record: cleanRec, savedAt: Date.now() };
        }
        btn.classList.add('dlm-loved');
        btn.title = 'Remove from Preferred';
        chrome.storage.local.set({ lovedLoads });
        if (_activeTab === 'loved') switchTab('loved');
      }
    });

    // Note badge delegation — opens sticky note popover
    d.querySelector('#dlm-body').addEventListener('click', e => {
      const badge = e.target.closest('.dlm-note-badge');
      if (!badge) return;
      e.stopPropagation();
      openNotePopover(badge);
    });

    // Templates delegation — Your Info save + Send From + Use This button + textarea auto-save
    d.querySelector('#dlm-body').addEventListener('click', async e => {
      if (e.target.closest('.dlm-info-save')) {
        const sigVal = (document.getElementById('dlm-info-signature')?.value || '').replace(/\s+$/, '');
        signature = sigVal;
        chrome.storage.local.set({ signature: sigVal });
        const btn = e.target.closest('.dlm-info-save');
        const orig = btn.textContent;
        btn.textContent = 'Saved ✓';
        btn.style.background = '#34c759';
        setTimeout(() => { btn.textContent = orig; btn.style.background = '#0058e0'; }, 1500);
        return;
      }
      if (e.target.classList.contains('dlm-gmail-connect')) {
        const connectBodyEl = document.getElementById('dlm-body');
        chrome.runtime.sendMessage({ type: 'gmailConnect' }, (res) => {
          if (res?.ok && res.email) {
            gmailOAuthEmail = res.email;
            chrome.storage.local.set({ gmailOAuthEmail: res.email });
            renderTemplatesBody(connectBodyEl);
          } else {
            console.warn('[LaneIQ] Gmail connect failed:', res?.error);
          }
        });
        return;
      }
      if (e.target.classList.contains('dlm-gmail-disconnect')) {
        const disconnectBodyEl = document.getElementById('dlm-body');
        chrome.runtime.sendMessage({ type: 'gmailDisconnect' }, (res) => {
          if (res?.ok) {
            gmailOAuthEmail = '';
            chrome.storage.local.remove(['gmailOAuthEmail']);
            renderTemplatesBody(disconnectBodyEl);
          }
        });
        return;
      }
      if (e.target.classList.contains('dlm-outlook-connect')) {
        const connectBodyEl = document.getElementById('dlm-body');
        chrome.runtime.sendMessage({ type: 'outlookConnect' }, (res) => {
          if (res?.ok && res.email) {
            outlookOAuthEmail = res.email;
            chrome.storage.local.set({ outlookOAuthEmail: res.email });
            renderTemplatesBody(connectBodyEl);
          } else {
            console.warn('[LaneIQ] Outlook connect failed:', res?.error);
          }
        });
        return;
      }
      if (e.target.classList.contains('dlm-outlook-disconnect')) {
        const disconnectBodyEl = document.getElementById('dlm-body');
        chrome.runtime.sendMessage({ type: 'outlookDisconnect' }, (res) => {
          if (res?.ok) {
            outlookOAuthEmail = '';
            chrome.storage.local.remove(['outlookOAuthEmail']);
            renderTemplatesBody(disconnectBodyEl);
          }
        });
        return;
      }
      if (e.target.closest('.dlm-setup-file-remove')) {
        const removeBtn = e.target.closest('.dlm-setup-file-remove');
        const idx = parseInt(removeBtn.dataset.fileIdx, 10);
        if (isNaN(idx)) return;
        const stored = await chrome.storage.local.get(['filesMeta','odIndex','oIndex','brokerIndex']);
        let meta = stored.filesMeta || [];
        let odI  = removeFromCSVIndex(stored.odIndex     || {}, idx);
        let oI   = removeFromCSVIndex(stored.oIndex      || {}, idx);
        let bI   = removeFromCSVIndex(stored.brokerIndex || {}, idx);
        odI = reIndexCSVFiles(odI, idx); oI = reIndexCSVFiles(oI, idx); bI = reIndexCSVFiles(bI, idx);
        const newMeta = meta.filter((_, i) => i !== idx);
        const count   = countCSVIndex(odI);
        await chrome.storage.local.set({ filesMeta: newMeta, odIndex: odI, oIndex: oI, brokerIndex: bI, laneCount: count, indexVersion: INDEX_VERSION });
        filesMeta = newMeta;
        const el = document.getElementById('dlm-body');
        if (el && _activeTab === 'setup') renderSetupBody(el);
        return;
      }
      if (e.target.closest('.dlm-setup-gmail-save')) {
        const raw = document.getElementById('dlm-setup-gmail-input')?.value.trim() || '';
        const urlMatch = raw.match(/mail\.google\.com\/mail\/u\/(\d+)/);
        if (urlMatch) {
          gmailIndex  = parseInt(urlMatch[1]);
          gmailEmail  = `Account #${gmailIndex}`;
        } else if (raw && raw.includes('@')) {
          gmailEmail  = raw;
        }
        activeMailProvider = 'gmail';   // saving Gmail makes it active, deactivates Outlook
        await chrome.storage.local.set({ gmailEmail, gmailIndex, activeMailProvider });
        const el = document.getElementById('dlm-body');
        if (el && _activeTab === 'setup') renderSetupBody(el);
        return;
      }
      if (e.target.closest('.dlm-setup-acct-btn')) {
        const acctBtn = e.target.closest('.dlm-setup-acct-btn');
        gmailIndex = parseInt(acctBtn.dataset.gmailIdx, 10);
        activeMailProvider = 'gmail';   // selecting an account makes Gmail active
        await chrome.storage.local.set({ gmailIndex, activeMailProvider });
        // Full re-render so the Outlook box also drops its green "active" state.
        const el = document.getElementById('dlm-body');
        if (el && _activeTab === 'setup') renderSetupBody(el);
        return;
      }
      if (e.target.closest('.dlm-setup-outlook-save')) {
        const raw = document.getElementById('dlm-setup-outlook-input')?.value.trim() || '';
        outlookHost = detectOutlookHost(raw);   // match the user's account → no re-login
        if (raw && raw.includes('@')) outlookEmail = raw;
        outlookConfigured = true;
        activeMailProvider = 'outlook';  // saving Outlook makes it active, deactivates Gmail
        await chrome.storage.local.set({ outlookEmail, outlookConfigured, outlookHost, activeMailProvider });
        const el = document.getElementById('dlm-body');
        if (el && _activeTab === 'setup') renderSetupBody(el);
        return;
      }
      const saveBtn = e.target.closest('.dlm-tpl-save');
      if (saveBtn) {
        const idx = parseInt(saveBtn.dataset.tplIndex, 10);
        const card = saveBtn.closest('.dlm-tpl-card');
        const subjectArea = card?.querySelector('.dlm-tpl-subject');
        const bodyArea = card?.querySelector('.dlm-tpl-body');
        const tmpls = emailTemplates.length ? emailTemplates : DEFAULT_TEMPLATES.map(t => ({...t}));
        if (!tmpls[idx]) return;
        if (subjectArea) tmpls[idx].subject = subjectArea.value;
        if (bodyArea) tmpls[idx].body = bodyArea.value;
        emailTemplates = tmpls;
        chrome.storage.local.set({ emailTemplates: tmpls });
        saveBtn.textContent = 'Saved ✓';
        saveBtn.style.background = '#34c759';
        setTimeout(() => { saveBtn.textContent = 'Save'; saveBtn.style.background = '#0058e0'; }, 1500);
        return;
      }
      const resetBtn = e.target.closest('.dlm-tpl-reset');
      if (resetBtn) {
        const idx = parseInt(resetBtn.dataset.tplIndex, 10);
        const card = resetBtn.closest('.dlm-tpl-card');
        const def = DEFAULT_TEMPLATES[idx];
        if (!def) return;
        const subjectArea = card?.querySelector('.dlm-tpl-subject');
        const bodyArea = card?.querySelector('.dlm-tpl-body');
        if (subjectArea) subjectArea.value = def.subject;
        if (bodyArea) bodyArea.value = def.body;
        const tmpls = emailTemplates.length ? emailTemplates : DEFAULT_TEMPLATES.map(t => ({...t}));
        if (!tmpls[idx]) return;
        tmpls[idx].subject = def.subject;
        tmpls[idx].body = def.body;
        emailTemplates = tmpls;
        chrome.storage.local.set({ emailTemplates: tmpls });
        return;
      }
      const useBtn = e.target.closest('.dlm-tpl-use');
      if (!useBtn) return;
      const idx = parseInt(useBtn.dataset.tplIndex, 10);
      if (isNaN(idx) || idx === activeTemplateIndex) return;
      const activeBody = document.getElementById('dlm-body');
      if (activeBody) {
        activeBody.querySelectorAll('.dlm-tpl-area').forEach(area => {
          const aIdx = parseInt(area.dataset.tplIndex, 10);
          if (isNaN(aIdx)) return;
          const tmpls = emailTemplates.length ? emailTemplates : DEFAULT_TEMPLATES.map(t => ({...t}));
          if (!tmpls[aIdx]) return;
          if (area.classList.contains('dlm-tpl-subject')) tmpls[aIdx].subject = area.value;
          if (area.classList.contains('dlm-tpl-body'))    tmpls[aIdx].body    = area.value;
          emailTemplates = tmpls;
          chrome.storage.local.set({ emailTemplates: tmpls });
        });
      }
      activeTemplateIndex = idx;
      chrome.storage.local.set({ activeTemplate: idx });
      renderTemplatesBody(e.currentTarget);
    });

    d.querySelector('#dlm-body').addEventListener('blur', e => {
      const area = e.target.closest('.dlm-tpl-area');
      if (!area) return;
      const idx = parseInt(area.dataset.tplIndex, 10);
      if (isNaN(idx)) return;
      const tmpls = emailTemplates.length ? emailTemplates : DEFAULT_TEMPLATES.map(t => ({...t}));
      if (area.classList.contains('dlm-tpl-subject')) tmpls[idx].subject = area.value;
      if (area.classList.contains('dlm-tpl-body'))    tmpls[idx].body    = area.value;
      emailTemplates = tmpls;
      chrome.storage.local.set({ emailTemplates: tmpls });
    }, true);

    // Lane Lookup (radius) live update — delegated on #dlm-body so it survives
    // every innerHTML replacement. Sliders debounce ~100ms (drag fires many
    // events; re-running radiusMatch on a large CSV each tick would lag); text
    // fields debounce 300ms. Only the results sub-div is re-rendered, so the
    // controls keep focus and slider-drag state.
    d.querySelector('#dlm-body').addEventListener('input', e => {
      const isSlider = e.target.classList.contains('dlm-r-slider');
      const isCity   = e.target.classList.contains('dlm-r-city');
      if (!isSlider && !isCity) return;

      // Live-update the mile labels immediately (cheap, no match work).
      if (isSlider) {
        const valEl = document.getElementById(e.target.id + '-val');
        if (valEl) valEl.textContent = e.target.value + ' mi';
      }

      clearTimeout(_radiusTimer);
      _radiusTimer = setTimeout(runRadiusUpdate, isSlider ? 100 : 300);
    });

    return d;
  }

  // Re-run the radius search from the current control values and patch only the
  // results sub-div. Keeps panelBodyHTML's cached radius section in sync so the
  // floating window / tab re-renders show the latest results.
  function runRadiusUpdate() {
    const oEl  = document.getElementById('dlm-r-origin');
    const dEl  = document.getElementById('dlm-r-dest');
    const omEl = document.getElementById('dlm-r-origin-mi');
    const dmEl = document.getElementById('dlm-r-dest-mi');
    const resEl = document.getElementById('dlm-radius-results');
    if (!resEl) return;

    const origin = oEl ? oEl.value.trim() : '';
    const dest   = dEl ? dEl.value.trim() : '';
    const originMi = omEl ? parseInt(omEl.value, 10) : _radiusOriginMi;
    const destMi   = dmEl ? parseInt(dmEl.value, 10) : _radiusDestMi;

    // Persist so the chosen radii stick across load-row switches + panel rebuilds
    // (module-scope = live default; storage = survives page reload).
    _radiusOriginMi = originMi;
    _radiusDestMi   = destMi;
    chrome.storage.local.set({ dlmRadiusOriginMi: originMi, dlmRadiusDestMi: destMi });

    const html = renderRadiusResults(origin, dest, originMi, destMi);
    resEl.innerHTML = html;

    // Keep the cached body HTML's results in sync (used by tab/window re-renders).
    const secEl = document.getElementById('dlm-radius-section');
    if (secEl) {
      const bodyEl = document.getElementById('dlm-body');
      if (bodyEl) panelBodyHTML = bodyEl.innerHTML;
    }
  }

  function clearPanel() {
    panelBodyHTML = '';
    clearTimeout(_clearPanelTimer);
    if (!panel) return;
    const bodyEl = document.getElementById('dlm-body');
    if (bodyEl) bodyEl.innerHTML = '';
    if (!panelPopped) panel.style.display = 'none';
  }

  function showPanel(origin, dest, odM, oM, bM, datBroker) {
    if (!panel) panel = buildPanel();
    if (!panelPopped) panel.style.display = 'flex';
    switchTab('history');

    const lk = new Set(Object.keys(lovedLoads));

    // Order: Exact Lane Matches → Same Broker → Lane Lookup (radius). The exact
    // same-lane box and same-broker box now render ABOVE the radius section so the
    // dispatcher sees the precise hit first. The old "Current Load" box was removed
    // — it showed the broad same-origin average (noise) the Lane Lookup replaces.
    let html = '';

    if (odM.length) {
      // skipAnim=true: all records use animation-delay:0 so none are hidden during a
      // stagger delay. The .dlm-rec CSS animation still runs (opacity 0→1) but fires
      // immediately for every record, so the panel is never empty on first open.
      html += `<div class="dlm-stitle">Exact Lane Matches · ${odM.length}</div>` +
              renderRecs(odM, odM.length >= 3 ? '#34c759' : '#f5a623', 20, true, true, lk, datBroker);
    }

    // Purple: same lane + same broker
    if (odM.length && bM.length && datBroker) {
      const brokerLane = bM.filter(r => odM.find(o => o.loadNum === r.loadNum));
      if (brokerLane.length) html += `<div class="dlm-stitle" style="color:#af52de">Same Broker — ${esc(datBroker)}</div>`;
    }

    // Lane Lookup (radius) renders LAST — below the exact + same-broker boxes.
    html += renderRadiusSection(origin, dest, _radiusOriginMi, _radiusDestMi);

    panelBodyHTML = html;

    // Unified render: ship the SAME html content.js built to the popped-out
    // window so panel.js just displays it (never re-renders cities itself).
    // mode:'html' → panel.js takes the inject branch; odM/oM/bM let panel.js
    // rebuild its _recPool so heart/save-to-Preferred works on injected cards.
    // Only write when popped — avoids a storage write on every docked row click.
    if (panelPopped) chrome.storage.local.set({
      panelState: { origin, dest, mode: 'html', renderedHTML: html, odM, oM, bM, datBroker }
    });

    const searchEl = panel.querySelector('#dlm-search');
    if (searchEl && searchEl.value) {
      searchEl.value = '';
      const clearEl = panel.querySelector('#dlm-search-clear');
      if (clearEl) clearEl.style.display = 'none';
    }

    // Always replace content immediately — no conditional branching that could
    // leave the panel empty, and no setTimeout delay before content is visible.
    const bodyEl = document.getElementById('dlm-body');
    if (!bodyEl) return;
    bodyEl.innerHTML = html;
    bodyEl.scrollTop = 0;
  }

  const MATCH_URL = 'https://laneiq-backend-production.up.railway.app/match';

  // Regex to extract "City, ST → City, ST" from DAT's detail panel header.
  // The unicode → arrow is unique to route headers so false-positives are rare.
  const ROUTE_RE = /([A-Z][A-Za-z\s\.]{1,20},\s*[A-Z]{2})\s*→\s*([A-Z][A-Za-z\s\.]{1,20},\s*[A-Z]{2})/;

  // Stricter route regex for reading the detail node's full innerText: the city
  // char class is [A-Za-z .] (NO \s), so the origin capture cannot cross a
  // newline into a preceding badge element (DAT renders "Tracking Required",
  // "CARB", etc. as separate elements → newline-separated in innerText). Spaces
  // are still allowed, so multi-word cities (Moss Landing, W Springfield) survive.
  const DETAIL_ROUTE_RE = /([A-Z][A-Za-z .]{1,28},\s*[A-Z]{2})\s*→\s*([A-Z][A-Za-z .]{1,28},\s*[A-Z]{2})/;

  // ── Allowlist validator: a candidate must parse to "City, ST" with a REAL
  // state code. Anchors on the comma + a valid 2-letter state and captures the
  // FULL city token sequence before the comma, so multi-word cities (Moss
  // Landing, W Springfield, Colorado Spgs, Miles City) survive intact. Returns
  // the normalized "City, ST" or null. Used to vet the clean detail-panel
  // sources in flushExpand before trusting them.
  const US_STATES = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']);
  function validCityST(raw) {
    const s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    const re = /([A-Za-z][A-Za-z .'\-]{0,40}?),\s*([A-Za-z]{2})\b/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      const st = m[2].toUpperCase();
      if (US_STATES.has(st)) {
        const city = m[1].trim();
        if (city.length >= 2) return `${city}, ${st}`;
      }
    }
    return null;
  }

  async function showPanelDual(origin, dest, odM, oM, bM, datBroker, detailNode) {
    const mySeq = ++_panelSeq;
    if (!panel) panel = buildPanel();
    if (!panelPopped) panel.style.display = 'flex';
    switchTab('history');

    const bodyEl = document.getElementById('dlm-body');


    // --- CSV section ---
    const lkd = new Set(Object.keys(lovedLoads));

    // Lane Lookup (radius) is the top/primary section. The old "Current Load"
    // stats box was removed (broad same-origin average = noise the scoped Lane
    // Lookup summary already replaces). The "📁 From Your CSV" label is kept to
    // delineate the CSV section from the "🗄️ LaneIQ Database" section below.
    let csvHTML = renderRadiusSection(origin, dest, _radiusOriginMi, _radiusDestMi);
    csvHTML += `<div style="font-size:10px;color:#aeaeb2;letter-spacing:.05em;text-transform:uppercase;margin:10px 14px 6px;font-weight:600">📁 From Your CSV</div>`;

    if (odM.length) {
      csvHTML += `<div class="dlm-stitle">Exact Lane Matches · ${odM.length}</div>` +
                 renderRecs(odM, odM.length >= 3 ? '#34c759' : '#f5a623', 20, true, true, lkd, datBroker);
    }

    const dbLoadingHTML = `
      <div id="dlm-db-section">
        <div style="font-size:10px;color:#aeaeb2;letter-spacing:.05em;text-transform:uppercase;margin:16px 14px 6px;font-weight:600">🗄️ LaneIQ Database</div>
        <div style="text-align:center;padding:20px;color:#aeaeb2;font-size:13px">Loading…</div>
      </div>`;

    if (!bodyEl) return;
    bodyEl.innerHTML = csvHTML + dbLoadingHTML;
    bodyEl.scrollTop = 0;

    // --- DB fetch ---
    const payload = { origin: normCity(origin), destination: normCity(dest), licenseKey };
    let result;
    try {
      const resp = await fetch(MATCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        if (_panelSeq !== mySeq) return;
        const dbErrHTML = `
          <div style="font-size:10px;color:#aeaeb2;letter-spacing:.05em;text-transform:uppercase;margin:16px 14px 6px;font-weight:600">🗄️ LaneIQ Database</div>
          <div style="text-align:center;padding:20px;color:#ff3b30;font-size:13px">Server error ${resp.status}</div>`;
        const dbErrSection = document.getElementById('dlm-db-section');
        if (dbErrSection) {
          dbErrSection.outerHTML = dbErrHTML;
        } else {
          bodyEl.innerHTML = csvHTML + dbErrHTML;
        }
        panelBodyHTML = csvHTML + dbErrHTML;
        return;
      }
      result = await resp.json();
    } catch (err) {
      if (_panelSeq !== mySeq) return;
      const dbErrHTML = `
        <div style="font-size:10px;color:#aeaeb2;letter-spacing:.05em;text-transform:uppercase;margin:16px 14px 6px;font-weight:600">🗄️ LaneIQ Database</div>
        <div style="text-align:center;padding:20px;color:#ff3b30;font-size:13px">Connection error</div>`;
      const dbErrSection = document.getElementById('dlm-db-section');
      if (dbErrSection) {
        dbErrSection.outerHTML = dbErrHTML;
      } else {
        bodyEl.innerHTML = csvHTML + dbErrHTML;
      }
      panelBodyHTML = csvHTML + dbErrHTML;
      return;
    }

    if (result && result.loadCount != null) {
      result = { exact: result.loadCount > 0 ? { count: result.loadCount, avgRate: result.avgRate, minRate: result.minRate, maxRate: result.maxRate, loads: [] } : null, origin: null };
    }

    // DB rate stats (Loads/Avg/Best/Min) removed — the database aggregates are
    // inaccurate. Section headers + cards stay; only the stats row is gone.
    const mapLoads = loads => (loads || []).map(l => ({
      loadNum: '', puDate: l.pu_date ? l.pu_date.toString().slice(0, 10) : '',
      broker: '', rate: l.rate != null ? String(l.rate) : '',
      origin: l.origin || '', destination: l.destination || '',
      pickupCompany: l.pickup_address || '', deliveryCompany: l.delivery_address || '',
      commodity: l.commodity || '', weight: l.weight_info || ''
    }));

    let dbHTML = `<div style="font-size:10px;color:#aeaeb2;letter-spacing:.05em;text-transform:uppercase;margin:16px 14px 6px;font-weight:600">🗄️ LaneIQ Database</div>`;

    if (!result || (!result.exact && !result.origin)) {
      dbHTML += `<div style="text-align:center;padding:20px;color:#aeaeb2;font-size:13px">No database data found for this lane</div>`;
    } else {
      if (result.exact) {
        dbHTML += `<div class="dlm-sum"><div style="font-size:10px;color:#34c759;letter-spacing:.05em;text-transform:uppercase;margin-bottom:8px;font-weight:600">Exact Lane Matches</div>${renderRecs(mapLoads(result.exact.loads), '#34c759', 999, true, true, new Set(), datBroker)}</div>`;
      }
      if (result.origin) {
        dbHTML += `<div class="dlm-sum" style="margin-top:8px"><div style="font-size:10px;color:#007aff;letter-spacing:.05em;text-transform:uppercase;margin-bottom:8px;font-weight:600">Same Origin Loads</div>${renderRecs(mapLoads(result.origin.loads), '#007aff', 999, true, true, new Set(), datBroker)}</div>`;
      }
    }

    if (_panelSeq !== mySeq) return;
    // Lane Lookup already lives in csvHTML (under Current Load); the DB section
    // replaces only its own loading placeholder below it.
    const dbSection = document.getElementById('dlm-db-section');
    if (dbSection) {
      dbSection.outerHTML = dbHTML;
    } else {
      bodyEl.innerHTML = csvHTML + dbHTML;
    }
    panelBodyHTML = csvHTML + dbHTML;

    if (panelPopped) {
      chrome.storage.local.set({
        panelState: { origin, dest, mode: 'api', renderedHTML: csvHTML + dbHTML }
      });
    }
    bodyEl.scrollTop = 0;
  }

  async function showPanelFromAPI(origin, dest, detailNode) {
    const mySeq = ++_panelSeq;
    if (!panel) panel = buildPanel();
    if (!panelPopped) panel.style.display = 'flex';
    switchTab('history');

    const bodyEl = document.getElementById('dlm-body');
    if (!bodyEl) return;
    bodyEl.innerHTML = `<div style="text-align:center;padding:36px 20px;color:#aeaeb2;font-size:13px">Loading LaneIQ data…</div>`;
    bodyEl.scrollTop = 0;

    // If origin wasn't extracted by flushExpand (no CSV highlighting), read it
    // directly from DAT's "City, ST → City, ST" header inside the detail panel.
    // DAT renders panel content async so retry up to 3× with 250ms gaps.
    if (!origin && detailNode) {
      for (let i = 0; i < 3 && !origin; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 250));
        const text = detailNode.innerText || detailNode.textContent || '';
        const m = ROUTE_RE.exec(text);
        if (m) { origin = m[1].trim(); dest = m[2].trim(); }
        console.log(`[LaneIQ] header read attempt ${i + 1}:`, origin || '(empty)');
      }
    }

    if (_panelSeq !== mySeq) return;
    if (!origin) {
      bodyEl.innerHTML = `<div style="text-align:center;padding:36px 20px;color:#aeaeb2;font-size:13px">Could not read lane — try clicking the row again</div>`;
      return;
    }

    const payload = { origin: normCity(origin), destination: normCity(dest), licenseKey };
    console.log('[LaneIQ] /match request:', payload);

    let result;
    try {
      const resp = await fetch(MATCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      console.log('[LaneIQ] /match status:', resp.status);
      if (!resp.ok) {
        const errText = await resp.text();
        if (_panelSeq !== mySeq) return;
        console.error('[LaneIQ] /match error response:', errText);
        bodyEl.innerHTML = `<div style="text-align:center;padding:36px 20px;color:#ff3b30;font-size:13px">Server error ${resp.status}<br><span style="font-size:11px;color:#aeaeb2">${esc(errText.slice(0, 120))}</span></div>`;
        return;
      }
      result = await resp.json();
      console.log('[LaneIQ] /match result:', result);
    } catch (err) {
      if (_panelSeq !== mySeq) return;
      console.error('[LaneIQ] /match fetch failed:', err);
      bodyEl.innerHTML = `<div style="text-align:center;padding:36px 20px;color:#ff3b30;font-size:13px">Connection error<br><span style="font-size:11px;color:#aeaeb2">${esc(String(err))}</span></div>`;
      return;
    }

    // Normalise both response shapes:
    // Old backend: { loadCount, avgRate, minRate, maxRate }
    // New backend: { exact: {...}, origin: {...} }
    if (result && result.loadCount != null) {
      result = { exact: result.loadCount > 0 ? { count: result.loadCount, avgRate: result.avgRate, minRate: result.minRate, maxRate: result.maxRate } : null, origin: null };
    }

    // Safety net: if /match still returns no exact hit but batch-highlight
    // already confirmed one (different normalization path), trust the cache
    // for aggregate stats. loads[] will be empty — stats-only display.
    const _cachedHit = _dbMatchCache[`${origin}|${dest}`];
    if (!result.exact && _cachedHit && _cachedHit.matchType === 'exact') {
      result.exact = {
        count:   _cachedHit.loadCount,
        avgRate: _cachedHit.avgRate,
        minRate: _cachedHit.minRate,
        maxRate: _cachedHit.maxRate,
        loads:   []
      };
    }

    if (!result || (!result.exact && !result.origin)) {
      const arrow = dest ? `${esc(origin)} → ${esc(dest)}` : esc(origin);
      bodyEl.innerHTML = `<div style="text-align:center;padding:36px 20px;color:#aeaeb2;font-size:13px;line-height:1.6">No data found<br><span style="font-size:11px">${arrow}</span></div>`;
      panelBodyHTML = bodyEl.innerHTML;
      return;
    }

    // DB rate stats (Loads/Avg/Best/Min) removed — the database aggregates are
    // inaccurate. Section headers + cards stay; only the stats row is gone.

    // Lane Lookup (radius) is a CSV feature — intentionally NOT rendered in
    // DB-only mode. (Previously appended renderRadiusSection here, which only
    // half-disappeared by relying on an empty oIndex returning ''. Removed so
    // DB-only never shows Lane Lookup even if a stale oIndex is present.)
    let html = '';

    if (result.exact) {
      const mappedLoads = (result.exact.loads || []).map(l => ({
        loadNum:         '',
        puDate:          l.pu_date ? l.pu_date.toString().slice(0, 10) : '',
        broker:          '',
        rate:            l.rate != null ? String(l.rate) : '',
        origin:          l.origin || '',
        destination:     l.destination || '',
        pickupCompany:   l.pickup_address || '',
        deliveryCompany: l.delivery_address || '',
        commodity:       l.commodity || '',
        weight:          l.weight_info || ''
      }));

      html += `
        <div class="dlm-sum">
          <div style="font-size:10px;color:#34c759;letter-spacing:.05em;text-transform:uppercase;margin-bottom:8px;font-weight:600">Exact Lane Matches</div>
          ${renderRecs(mappedLoads, mappedLoads.length >= 3 ? '#34c759' : '#f5a623', 999, true, true)}
        </div>`;
    }

    if (result.origin) {
      const mappedOriginLoads = (result.origin.loads || []).map(l => ({
        loadNum:         '',
        puDate:          l.pu_date ? l.pu_date.toString().slice(0, 10) : '',
        broker:          '',
        rate:            l.rate != null ? String(l.rate) : '',
        origin:          l.origin || '',
        destination:     l.destination || '',
        pickupCompany:   l.pickup_address || '',
        deliveryCompany: l.delivery_address || '',
        commodity:       l.commodity || '',
        weight:          l.weight_info || ''
      }));

      html += `
        <div class="dlm-sum" style="margin-top:8px">
          <div style="font-size:10px;color:#007aff;letter-spacing:.05em;text-transform:uppercase;margin-bottom:8px;font-weight:600">Same Origin Loads</div>
          ${renderRecs(mappedOriginLoads, '#007aff', 999, true, true)}
        </div>`;
    }

    if (_panelSeq !== mySeq) return;
    panelBodyHTML = html;
    bodyEl.innerHTML = html;
    if (panelPopped) {
      chrome.storage.local.set({
        panelState: {
          origin,
          dest,
          mode: 'api',
          renderedHTML: html
        }
      });
    }
    bodyEl.scrollTop = 0;
  }

  function renderRecs(list, color, limit = 20, skipAnim = false, skipFilter = false, lovedKeys = new Set(), datBroker = '') {
    // skipFilter = true for exact lane matches — never hide a confirmed match
    // regardless of whether it has a rate/pickup/commodity filled in.
    const filtered = skipFilter ? list : list.filter(r => {
      const rate = String(r.rate||'').trim();
      return (rate && rate !== 'nan') ||
             (r.pickupCompany   && r.pickupCompany   !== 'nan' && r.pickupCompany.trim())   ||
             (r.deliveryCompany && r.deliveryCompany !== 'nan' && r.deliveryCompany.trim()) ||
             (r.commodity       && r.commodity       !== 'nan' && r.commodity.trim());
    });
    const normDatB = datBroker ? normBroker(datBroker).split(' ')[0] : '';
    const sorted = normDatB
      ? [...filtered].sort((a, b) => {
          const aMatch = a.broker && normBroker(a.broker).includes(normDatB);
          const bMatch = b.broker && normBroker(b.broker).includes(normDatB);
          return (bMatch ? 1 : 0) - (aMatch ? 1 : 0);
        })
      : filtered;
    return sorted.slice(0, limit).map((r, i) => {
      const key  = loveKey(r);
      _recPool[key] = r;
      const loved = lovedKeys.has(key);

      const rate = String(r.rate||'').trim();
      const rateNum = parseFloat(rate);
      const rd   = rate && rate !== 'nan' && !isNaN(rateNum)
                     ? '$' + rateNum.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
                     : (rate && rate !== 'nan' ? rate : 'N/A');
      const ln   = String(r.loadNum||'').replace(/\n.*/,'').trim() || '—';
      const dt   = String(r.puDate||'').split('T')[0].substring(0, 10);
      const broker = String(r.broker||'').trim();
      // Exactly ONE mail button — the ACTIVE provider, when configured. Mutually
      // exclusive (never both). Same DB-only guard + load# check.
      const _canMail   = ln !== '—' && !(useDB && !useCSV);
      const gmailCfg   = gmailIndex > 0 || !!gmailEmail;
      const showGmail   = _canMail && activeMailProvider === 'gmail'   && gmailCfg;
      const showOutlook = _canMail && activeMailProvider === 'outlook' && outlookConfigured;
      const gmailBtn   = showGmail   ? `<a href="${gmailUrl(ln)}" target="_blank" rel="noopener" class="dlm-gmail-btn">📧 Gmail</a>` : '';
      const outlookBtn = showOutlook ? `<a href="${outlookUrl(ln)}" target="_blank" rel="noopener" class="dlm-outlook-btn">📧 Outlook</a>` : '';
      const heartBtn = `<button class="dlm-heart-btn${loved ? ' dlm-loved' : ''}" data-load-key="${esc(key)}" title="${loved ? 'Remove from Preferred' : 'Save to Preferred'}">♥</button>`;
      const noteBadgeBtn = loved ? `<button class="dlm-note-badge" data-note-key="note_${esc(key)}" data-load-key="${esc(key)}" title="Add note"><svg width="9" height="9" viewBox="0 0 14 14" fill="none" style="flex-shrink:0;margin-bottom:1px"><path d="M9.5 2L12 4.5L4.5 12H2V9.5L9.5 2Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Note</button>` : '';

      const pickupAddr   = parseCompanyAddress(r.pickupCompany   || '');
      const deliveryAddr = parseCompanyAddress(r.deliveryCompany || '');
      const commodity = String(r.commodity || '').trim();

      // Trailer/equipment tag (CSV only; DB records have no trailer field).
      // Hidden entirely when blank/"nan"/missing — never shows N/A.
      const trailer = String(r.trailer || '').trim();
      const trailerTag = (trailer && trailer.toLowerCase() !== 'nan')
        ? `<span class="dlm-eq">${esc(trailer)}</span>` : '';

      const addrHtml = (addr) =>
        addr ? `${esc(addr.company)}${addr.street ? `<br><span style="font-size:10px;color:#8e8e93;font-weight:400">${esc(addr.street)}</span>` : ''}` : '';

      const isBrokerMatch = normDatB && r.broker && normBroker(r.broker).includes(normDatB);
      const cardColor = isBrokerMatch ? '#9b59b6' : color;

      return `
        <div class="dlm-rec" style="border-left-color:${cardColor};animation-delay:${skipAnim ? 0 : i*.04}s">
          <div class="dlm-rh">
            <div style="display:flex;flex-direction:column;gap:2px;max-width:165px">
              <span class="dlm-ln">#${esc(ln)}</span>
              ${broker && broker !== 'nan' ? `<span style="font-size:11px;color:#6e6e73;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(broker)}</span>` : ''}
              ${trailerTag}
            </div>
            <div style="display:flex;align-items:center;gap:5px">${gmailBtn}${outlookBtn}${noteBadgeBtn}${heartBtn}<span class="dlm-dt">${esc(dt)}</span></div>
          </div>
          <div class="dlm-grid">
            <div class="dlm-k">Rate</div><div class="dlm-v dlm-rate">${esc(rd)}</div>
            <div class="dlm-k">From</div><div class="dlm-v">${esc(r.origin)}</div>
            ${r.destination ? `<div class="dlm-k">To</div><div class="dlm-v">${esc(r.destination)}</div>` : ''}
            ${pickupAddr   ? `<div class="dlm-k">Pickup</div><div class="dlm-v dlm-v-addr">${addrHtml(pickupAddr)}</div>`   : ''}
            ${deliveryAddr ? `<div class="dlm-k">Delivery</div><div class="dlm-v dlm-v-addr">${addrHtml(deliveryAddr)}</div>` : ''}
            ${commodity && commodity !== 'nan' ? `<div class="dlm-k">Commodity</div><div class="dlm-v">${esc(commodity)}</div>` : ''}
            ${r.weight && r.weight !== 'nan' ? `<div class="dlm-k">Wt</div><div class="dlm-v">${esc(r.weight)}</div>` : ''}
          </div>
        </div>`;
    }).join('');
  }

  function scheduleBatchHighlight() {
    if (_batchTimer) clearTimeout(_batchTimer);
    _batchTimer = setTimeout(runBatchHighlight, 500);
  }

  async function runBatchHighlight() {
    const rows = Array.from(document.querySelectorAll('[data-dlm-origin][data-dlm-dest]'));
    if (!rows.length) return;

    const seen = new Set();
    const lanes = [];
    // rawKey ("rawOrigin|rawDest") → { rows: [], normKey }.
    // _dbMatchCache stays keyed by the RAW dataset values (what processRow and
    // the side-panel safety-net read), while the backend payload + result
    // lookup use the DAT-abbreviation-expanded cities (same as /match), so the
    // backend ILIKE prefix match can hit the DB row.
    const rowMap = {};

    rows.forEach(row => {
      const rawOrigin = row.dataset.dlmOrigin || '';
      const rawDest   = row.dataset.dlmDest   || '';
      if (!rawOrigin || !rawDest) return;
      const rawKey = `${rawOrigin}|${rawDest}`;
      // Expand DAT abbreviations the same way the side-panel /match lookup does
      // (normCity: "American Cyn" → "American Canyon"). The backend echoes the
      // result key back as the cities it received, so this is the lookup key.
      const normOrigin = normCity(rawOrigin);
      const normDest   = normCity(rawDest);
      const normKey    = `${normOrigin}|${normDest}`;
      if (!rowMap[rawKey]) rowMap[rawKey] = { rows: [], normKey };
      rowMap[rawKey].rows.push(row);
      if (!seen.has(normKey)) {
        seen.add(normKey);
        lanes.push({ origin: normOrigin, destination: normDest });
      }
    });

    if (!lanes.length) return;

    const doFetch = () => fetch('https://laneiq-backend-production.up.railway.app/batch-match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lanes })
    });

    try {
      let resp;
      try {
        resp = await doFetch();
      } catch (coldErr) {
        // Railway cold-start can drop the first request ("Failed to fetch").
        // Wait ~2s and try once more before giving up.
        await new Promise(r => setTimeout(r, 2000));
        resp = await doFetch();   // if this throws too, falls into the outer catch
      }
      if (!resp.ok) return;
      const data = await resp.json();
      const results = data.results || {};

      let matched = 0;
      Object.keys(rowMap).forEach(rawKey => {
        const { rows: theseRows, normKey } = rowMap[rawKey];
        const match = results[normKey];
        if (!match) return;
        matched++;
        _dbMatchCache[rawKey] = match;   // raw key — processRow & safety-net read this
        theseRows.forEach(row => {
          const alreadyColored = ['dlm-green','dlm-yellow','dlm-blue','dlm-purple'].some(c => row.classList.contains(c));
          if (alreadyColored && useCSV) return;
          row.style.backgroundColor = '';
          row.classList.remove('dlm-green', 'dlm-yellow', 'dlm-blue', 'dlm-purple');
          if (match.matchType === 'origin') {
            row.classList.add('dlm-blue');
          } else {
            row.classList.add(match.loadCount >= 3 ? 'dlm-green' : 'dlm-yellow');
          }
          row.dataset.dlmDbMatch = JSON.stringify(match);
        });
      });

      console.log(`[LaneIQ] Batch highlight done — ${matched}/${lanes.length} lanes matched`);
    } catch (err) {
      console.error('[LaneIQ] runBatchHighlight error:', err);
    }
  }

  // ── Scan ────────────────────────────────────────────────────────────────────
  function scan() {
    _cityFailCount = 0;
    const usingAPI = licenseTier === 'pro' && useDB;
    if (!odIndex && !oIndex && !usingAPI) return;
    // processRow skips rows whose origin/dest hasn't changed, so no bulk
    // class-removal pass is needed — stale state is cleared per-row on demand.
    const rows = document.querySelectorAll('[class*="row-container"], [class*="row-cells"]');
    if (rows.length === 0 && location.href.includes('dat.com')) {
      _zeroRowStreak++;
      if (_zeroRowStreak >= 3) {
        reportSelectorError('zero-rows', 'row-container and row-cells both returned 0 matches');
        _zeroRowStreak = 0;
      }
    } else {
      _zeroRowStreak = 0;
    }
    rows.forEach(r => {
      processRow(r);
      injectEmailChip(r);
    });
    if (_cityFailCount > 50) {
      reportSelectorError('city-extraction-failed', `${_cityFailCount} rows failed city extraction in one scan`);
    }
    if (usingAPI) scheduleBatchHighlight();
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  function clearAllHighlights() {
    document.querySelectorAll('.dlm-green, .dlm-yellow, .dlm-blue, .dlm-purple').forEach(el => {
      el.classList.remove('dlm-green', 'dlm-yellow', 'dlm-blue', 'dlm-purple');
    });
    document.querySelectorAll('.dlm-badge').forEach(el => el.remove());
    document.querySelectorAll('[data-dlm-origin]').forEach(el => {
      delete el.dataset.dlmOrigin;
      delete el.dataset.dlmDest;
      delete el.dataset.dlmMatch;
    });
    _dbMatchCache = {};
  }

  async function init() {
    if (_initializing) return;
    _initializing = true;
    try { await _doInit(); } finally { _initializing = false; }
  }

  async function _doInit() {
    if (!window.location.href.includes('one.dat.com')) return;
    if (_initialized) return; // indexes already in memory — nothing to do

    // License gate — Railway /validate is the authoritative check.
    // Falls back to stored licenseValid only on network error.
    const lic = await chrome.storage.local.get(['licenseKey', 'licenseValid']);

    if (!lic.licenseKey) return;

    const VALIDATION_URL = 'https://laneiq-backend-production.up.railway.app/validate';
    let licenseOK = false;
    let backendTier = null;

    // Check 60-second in-memory cache first to avoid hammering Railway when
    // the user has multiple DAT tabs or refreshes frequently.
    const cacheAge = Date.now() - _licenseValidatedAt;
    if (_licenseValidatedAt > 0 && cacheAge < LICENSE_CACHE_MS) {
      console.log('[LaneIQ] license cache hit |', Math.round(cacheAge / 1000) + 's old | tier:', _licenseCachedTier);
      licenseOK = true;
      backendTier = _licenseCachedTier;
    } else try {
      const resp = await fetch(VALIDATION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: lic.licenseKey }),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.valid) {
          licenseOK = true;
          backendTier = data.tier || null;
          _licenseValidatedAt = Date.now();
          _licenseCachedTier  = backendTier;
          await chrome.storage.local.set({
            licenseValid: true,
            licenseCheckedAt: new Date().toISOString(),
          });
          console.log('[LaneIQ] license validated by Railway | tier:', backendTier);
        } else {
          _licenseValidatedAt = 0;
          _licenseCachedTier  = null;
          await chrome.storage.local.set({ licenseValid: false });
          return;
        }
      } else {
        // Non-2xx response — treat as network error, fall back to stored state
        if (!lic.licenseValid) return;
        licenseOK = true;
      }
    } catch (err) {
      // Network unreachable — fail open if we have a previously-stored valid flag
      console.error('[LaneIQ] Railway /validate network error:', err.message);
      if (!lic.licenseValid) return;
      licenseOK = true;
    }

    if (!licenseOK) return;

    const s = await chrome.storage.local.get(['odIndex','oIndex','brokerIndex','laneCount','indexVersion','gmailIndex','gmailEmail','gmailOAuthEmail','outlookOAuthEmail','senderGmailIndex','emailSubject','emailTemplate','signature','panelPopped','mapsApiKey','dlmMpg','dlmFuelPrice','dlmDriverRate','licenseTier','dataSource','useCSV','useDB','lovedLoads','emailTemplates','activeTemplate','filesMeta','dlm-panel-height','dlm-route-modal-rect','dlmRadiusOriginMi','dlmRadiusDestMi','outlookEmail','outlookConfigured','outlookHost','activeMailProvider']);

    if (Number.isFinite(s.dlmRadiusOriginMi)) _radiusOriginMi = s.dlmRadiusOriginMi;
    if (Number.isFinite(s.dlmRadiusDestMi))   _radiusDestMi   = s.dlmRadiusDestMi;

    if (s['dlm-route-modal-rect']) _routeModalRect = s['dlm-route-modal-rect'];

    // Resolve tier/dataSource early so we can use them in the guards below
    licenseTier = s.licenseTier || 'solo';
    useCSV = s.useCSV !== false;
    useDB  = s.useDB  ?? true;
    licenseKey  = lic.licenseKey || '';
    const usingAPI = licenseTier === 'pro' && useDB;

    // CSV gate — skip index loading if no active data source, but always build and
    // show the panel so the user can reach the Setup tab to re-enable a source.
    // Corrupted or missing storage values are treated the same as "both off".
    if (!s.laneCount && !usingAPI) {
      const _disabledMsg = '<div style="text-align:center;padding:36px 20px;color:#aeaeb2;font-size:13px;line-height:1.6">Enable a data source in settings to see rates</div>';
      panelPopped = s.panelPopped || false;
      if (!panelPopped) {
        if (!panel) { panel = buildPanel(); if (s['dlm-panel-height']) panel.style.height = s['dlm-panel-height']; }
        panel.style.display = 'flex';
        if (_activeTab === 'history') switchTab('history');
        const _disabledBody = document.getElementById('dlm-body');
        if (_disabledBody) _disabledBody.innerHTML = _disabledMsg;
      }
      _initialized = true;
      return;
    }

    // Only validate/load CSV indexes when CSV data is present
    if (s.laneCount) {
      if (s.indexVersion !== INDEX_VERSION) {
        console.warn('[LaneIQ] Stored index version', s.indexVersion, '!== current', INDEX_VERSION, '— skipping stale index. Re-upload CSV in the extension popup.');
        return;
      }
      odIndex     = s.odIndex     || {};
      oIndex      = s.oIndex      || {};
      brokerIndex = s.brokerIndex || {};
    }

    // v1.32 radius matching — load bundled coords + log real-world coverage (dev aid)
    await loadCityCoords();
    logCoordCoverage();

    gmailIndex       = s.gmailIndex      || 0;
    gmailOAuthEmail  = s.gmailOAuthEmail || '';
    outlookOAuthEmail = s.outlookOAuthEmail || '';
    senderGmailIndex = typeof s.senderGmailIndex !== 'undefined' ? s.senderGmailIndex : 0;
    signature        = s.signature    || '';
    emailSubject     = s.emailSubject  || 'Load Inquiry – {origin} → {destination}';
    emailTemplate    = s.emailTemplate || `Hi,

Please tell me more about your load from {origin}, pickup on {date}, going to {destination}, posted on DAT today.

{signature}`;

    if (s.panelPopped) {
      chrome.runtime.sendMessage({ type: 'checkPanelWindow' }, (res) => {
        if (res?.exists) {
          panelPopped = true;
          // detached panel is still open — don't show inline panel
        } else {
          panelPopped = false;
          chrome.storage.local.set({ panelPopped: false });
          if (!panel) { panel = buildPanel(); if (s['dlm-panel-height']) panel.style.height = s['dlm-panel-height']; }
          panel.style.display = 'flex';
          if (_activeTab === 'history') switchTab('history');
        }
      });
    } else {
      panelPopped = false;
      if (!panel) { panel = buildPanel(); if (s['dlm-panel-height']) panel.style.height = s['dlm-panel-height']; }
      panel.style.display = 'flex';
      if (_activeTab === 'history') switchTab('history');
    }
    mapsApiKey     = s.mapsApiKey     || '';
    dlmMpg         = +s.dlmMpg         || 6.5;
    dlmFuelPrice   = +s.dlmFuelPrice   || 3.89;
    dlmDriverRate  = +s.dlmDriverRate  || 0;
    lovedLoads          = s.lovedLoads      || {};
    gmailEmail          = s.gmailEmail      || '';
    outlookEmail        = s.outlookEmail    || '';
    outlookConfigured   = !!s.outlookConfigured;
    outlookHost         = s.outlookHost     || 'office.com';
    activeMailProvider  = s.activeMailProvider || '';
    filesMeta           = s.filesMeta       || [];
    emailTemplates      = s.emailTemplates  || DEFAULT_TEMPLATES.map(t => ({...t}));
    activeTemplateIndex = s.activeTemplate  ?? 0;
    // Migrate old template names if user has the previous defaults saved
    const nameMap = { 'Template 1': 'Standard', 'Template 2': 'Follow Up', 'Template 3': 'Custom' };
    let migrated = false;
    emailTemplates.forEach(t => { if (nameMap[t.name]) { t.name = nameMap[t.name]; migrated = true; } });
    if (migrated) chrome.storage.local.set({ emailTemplates });
    _initialized = true;

    if (!_observersSetup) {
      _observersSetup = true;

      // Re-show the side panel when the pop-out window is closed.
      // Also reinitialize when the user switches data source or uploads a new CSV
      // so changes take effect without a full page reload.
      chrome.storage.onChanged.addListener((changes) => {
        if ('panelPopped' in changes) {
          panelPopped = changes.panelPopped.newValue || false;
          if (!panelPopped && panel && panelBodyHTML) panel.style.display = 'flex';
        }
        // Live-sync Maps key, calculator defaults, and email signature fields
        // so popup edits take effect immediately in already-open DAT tabs.
        if ('mapsApiKey' in changes) {
          mapsApiKey = changes.mapsApiKey.newValue || '';
        }
        if ('dlmMpg' in changes)        dlmMpg        = +changes.dlmMpg.newValue        || 6.5;
        if ('dlmFuelPrice' in changes)  dlmFuelPrice  = +changes.dlmFuelPrice.newValue  || 3.89;
        if ('dlmDriverRate' in changes) dlmDriverRate = +changes.dlmDriverRate.newValue || 0;
        if ('signature' in changes)   signature   = changes.signature.newValue   || '';
        if ('emailSubject' in changes)     emailSubject     = changes.emailSubject.newValue     || 'Load Inquiry – {origin} → {destination}';
        if ('emailTemplate' in changes)    emailTemplate    = changes.emailTemplate.newValue    || emailTemplate;
        if ('senderGmailIndex' in changes) senderGmailIndex = typeof changes.senderGmailIndex.newValue !== 'undefined' ? changes.senderGmailIndex.newValue : 0;
        if ('gmailOAuthEmail' in changes)  gmailOAuthEmail  = changes.gmailOAuthEmail.newValue  || '';
        if ('outlookOAuthEmail' in changes) outlookOAuthEmail = changes.outlookOAuthEmail.newValue || '';
        if ('lovedLoads' in changes)      lovedLoads  = changes.lovedLoads.newValue  || {};
        if ('gmailEmail' in changes)      gmailEmail  = changes.gmailEmail.newValue  || '';
        if ('gmailIndex' in changes)      gmailIndex  = changes.gmailIndex.newValue  ?? 0;
        if ('filesMeta'  in changes)      filesMeta   = changes.filesMeta.newValue   || [];
        if ('emailTemplates' in changes)  emailTemplates      = changes.emailTemplates.newValue  || DEFAULT_TEMPLATES.map(t => ({...t}));
        if ('activeTemplate' in changes)  activeTemplateIndex = changes.activeTemplate.newValue  ?? 0;
        if ('useCSV' in changes || 'useDB' in changes || 'laneCount' in changes) {
          clearAllHighlights();
          _initialized = false;
          odIndex = oIndex = brokerIndex = null;
          init();
        }
      });

      // Scan immediately — catches rows already in the DOM.
      // The 500ms fallback handles DAT pages that finish rendering after the storage read.
      scan();
      setTimeout(scan, 500);

      // Debounced observer: wait 300ms for the DOM to settle before re-scanning.
      const obs = new MutationObserver(() => {
        clearTimeout(_dlmT);
        _dlmT = setTimeout(scan, 300);
      });
      obs.observe(document.body, { childList: true, subtree: true });

      let lastUrl = location.href;
      setInterval(() => {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          setTimeout(scan, 500);
        }
      }, 700);

      setupRouteInterceptor();

      document.addEventListener('click', e => {
        if (e.target.closest('[id^="dlm-"]')) return;
        const row = e.target.closest('[data-dlm-origin]') ||
                    e.target.closest('[class*="row-container"],[class*="row-cells"]');
        if (row) _lastClickedRow = row;
      }, true);
    }

  }

  // ── Read current Origin + Destination from DAT's search bar ────────────────────
  // These inputs are always populated when load results are visible, making them
  // the most reliable source of lane data for the API panel in DB mode.
  function getDATSearchCities() {
    function isOwn(el) {
      return !!(el.closest('#dlm-sidebar') || el.closest('[id^="dlm-"]') || el.closest('[class^="dlm-"]'));
    }

    function findInputByLabel(labelText) {
      // Strategy 1: label/div/span whose exact text matches, then nearby input
      for (const el of document.querySelectorAll('label, div, span')) {
        if (isOwn(el)) continue;
        if (el.textContent.trim() !== labelText) continue;
        const parent = el.parentElement;
        if (!parent) continue;
        const input = parent.querySelector('input') ||
                      el.nextElementSibling?.querySelector?.('input') ||
                      (el.nextElementSibling?.tagName === 'INPUT' ? el.nextElementSibling : null);
        if (input && !isOwn(input) && input.value.trim()) return input.value.trim();
      }
      // Strategy 2: input attributes
      for (const attr of ['placeholder', 'aria-label', 'id', 'name']) {
        for (const input of document.querySelectorAll('input')) {
          if (isOwn(input)) continue;
          const val = (input.getAttribute(attr) || '').toLowerCase();
          if (val.includes(labelText.toLowerCase()) && input.value.trim())
            return input.value.trim();
        }
      }
      return '';
    }

    const origin = findInputByLabel('Origin');
    const dest   = findInputByLabel('Destination');
    console.log('[LaneIQ] DAT search bar:', { origin, dest });
    return { origin, dest };
  }

  // ── Extract DAT search origin (where the user is searching from) ─────────────
  // ── Watch DAT's Origin search box and mirror it live into the modal's DH From field ──
  // Called when the RPM modal opens.  Returns a cleanup fn — call it on modal close.
  // ── getDATOriginValue ──────────────────────────────────────────────────────────
  // Called once every time the RPM modal opens. Finds DAT's Origin search input,
  // mirrors its current value into the modal's DH From field, and keeps them in
  // sync for as long as the modal is open.
  //
  // Returns a cleanup fn — call it in doClose to disconnect the observer.
  // Rate-field logic is completely separate and does not share state with this fn.
  function getDATOriginValue(dhFromEl, onValueChange) {
    const SELECTORS = [
      'input[placeholder*="Origin"]',
      'input[aria-label*="origin" i]',
      '[data-testid*="origin"] input',
    ];

    function isOwn(el) {
      return !!(el.closest('#dlm-sidebar') || el.closest('[id^="dlm-"]') || el.closest('[class^="dlm-"]'));
    }

    function findDATInput() {
      // ── Strategy 1: find a <label> or <div> whose text is "Origin", then ──────
      // grab the nearest input that's a sibling or descendant of its container.
      for (const labelEl of document.querySelectorAll('label, div, span')) {
        if (isOwn(labelEl)) continue;
        if (labelEl.textContent.trim() !== 'Origin') continue;

        // Check siblings and the parent's children for an input
        const parent = labelEl.parentElement;
        if (parent) {
          const input = parent.querySelector('input') ||
                        labelEl.nextElementSibling?.querySelector?.('input') ||
                        (labelEl.nextElementSibling?.tagName === 'INPUT' ? labelEl.nextElementSibling : null);
          if (input && !isOwn(input)) {
            return input;
          }
        }
      }

      // ── Strategy 2: attribute selectors on the input itself ──────────────────
      for (const sel of [
        'input[id*="origin" i]',
        'input[name*="origin" i]',
        'input[class*="origin" i]',
      ]) {
        for (const el of document.querySelectorAll(sel)) {
          if (isOwn(el)) continue;
          return el;
        }
      }

      return null;
    }

    function attach(datInput) {
      // DAT's SPA (React/Angular) adds the <input> to the DOM before setting its
      // .value — so the value can be '' at the instant we find the element.
      // Try immediately, then poll every 200 ms for up to 2 s until a value lands.
      let pollTimer = null;
      let pollCount = 0;

      function tryPopulate() {
        const v = datInput.value?.trim();
        // Override whatever is in dhFromEl — the DAT search box is authoritative
        // over the load-origin pre-fill because it reflects the truck's real location.
        if (v && v.length > 2) {
          dhFromEl.value = v;
          onValueChange();
          return true;
        }
        return false;
      }

      if (!tryPopulate()) {
        pollTimer = setInterval(() => {
          if (tryPopulate() || ++pollCount >= 10) clearInterval(pollTimer);
        }, 200);
      }

      // Keep DH From in sync when the dispatcher changes the origin after the modal opens.
      // Autocomplete selections fire "change" (sync immediately);
      // keystrokes fire "input" (debounced 500 ms to avoid hammering the route API).
      let syncDebounce = null;

      const syncImmediate = () => {
        clearTimeout(syncDebounce);
        clearInterval(pollTimer);          // stop any pending poll
        dhFromEl.value = datInput.value?.trim() || '';
        onValueChange();
      };

      const syncDebounced = () => {
        clearTimeout(syncDebounce);
        syncDebounce = setTimeout(() => {
          dhFromEl.value = datInput.value?.trim() || '';
          onValueChange();
        }, 500);
      };

      datInput.addEventListener('change', syncImmediate);
      datInput.addEventListener('input',  syncDebounced);

    }

    // Try immediately — the origin input is usually in the DOM when the modal opens
    const immediate = findDATInput();
    if (immediate) { attach(immediate); return () => {}; }

    // Not found yet — watch for it to appear (SPA lazy render / navigation)
    let obs = new MutationObserver(() => {
      const found = findDATInput();
      if (found) { obs.disconnect(); obs = null; attach(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // Return cleanup so the caller can stop the observer when the modal closes
    return () => { if (obs) { obs.disconnect(); obs = null; } };
  }

  // ── VIEW ROUTE interceptor ───────────────────────────────────────────────────
  function setupRouteInterceptor() {
    function tryIntercept(el) {
      if (el.dataset.dlmRouteOk) return;
      if (!/view\s*route/i.test(el.textContent.replace(/\s+/g,' ').trim())) return;
      el.dataset.dlmRouteOk = '1';

      if (!el.parentNode) return;

      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;gap:13px;';

      el.parentNode.insertBefore(wrapper, el);
      wrapper.appendChild(el);
      const BTN_BASE = 'width:176px;min-width:176px;max-width:176px;height:40px;padding:0 14px;font-size:12px;font-weight:700;letter-spacing:.01em;font-family:-apple-system,"SF Pro Text",BlinkMacSystemFont,system-ui,sans-serif;border-radius:10px;border:none;border-left:5px solid #0058e0;cursor:pointer;color:#0f1923;background:#eef2ff;box-sizing:border-box;display:inline-flex;align-items:center;gap:7px;box-shadow:0 10px 28px rgba(0,60,200,.32),0 4px 10px rgba(0,0,0,.18);transition:box-shadow .15s,background .15s;';

      // Replace DAT's internal markup so their child styles can't fight ours
      el.textContent = 'View Route';
      el.style.cssText = BTN_BASE;
      el.style.setProperty('background', '#eef2ff', 'important');
      el.style.setProperty('border-left', '5px solid #0058e0', 'important');
      el.style.setProperty('color', '#0f1923', 'important');
      el.style.setProperty('box-shadow', '0 10px 28px rgba(0,60,200,.32),0 4px 10px rgba(0,0,0,.18)', 'important');

      // RPM / Maps button
      const rpmBtn = document.createElement('button');
      rpmBtn.innerHTML =
        `<svg viewBox="0 0 16 16" width="13" height="13" fill="#0058e0" aria-hidden="true" style="flex-shrink:0">
           <path d="M8 1C5.24 1 3 3.24 3 6c0 3.9 5 9 5 9s5-5.1 5-9c0-2.76-2.24-5-5-5z
                    m0 7c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/>
         </svg>RPM / Maps`;
      rpmBtn.style.cssText = BTN_BASE;
      rpmBtn.addEventListener('click', async e => {
        e.stopPropagation();
        e.preventDefault();
        // Belt-and-suspenders: refresh key from storage if in-memory is empty.
        // Handles the edge case where the popup saved a key just before this click.
        if (!mapsApiKey) {
          const stored = await chrome.storage.local.get(['mapsApiKey']);
          if (stored.mapsApiKey) mapsApiKey = stored.mapsApiKey;
        }
        const { origin, dest } = getDetailCities(el);
        const rate = getDetailRate(el);
        showRouteModal(origin, dest, rate, () => {});
      }, true);

      // Google Maps directions button
      const mapsBtn = document.createElement('button');
      mapsBtn.innerHTML = `<span style="font-size:14px;line-height:1;flex-shrink:0">🗺</span>Google Maps`;
      mapsBtn.style.cssText = BTN_BASE;
      mapsBtn.addEventListener('click', e => {
        e.stopPropagation();
        e.preventDefault();
        const { origin, dest } = getDetailCities(el);

        const truckCity = (() => {
          const cityRe = /^[A-Za-z][A-Za-z\s\.]{1,20},\s*[A-Z]{2}$/;
          for (const input of document.querySelectorAll('input')) {
            const val = (input.value || '').trim();
            if (cityRe.test(val) && !input.closest('#dlm-panel, #dlm-popup')) {
              return val;
            }
          }
          return '';
        })();

        const waypoints = truckCity ? [truckCity, origin, dest] : [origin, dest];
        const url = `https://www.google.com/maps/dir/${waypoints.map(encodeURIComponent).join('/')}`;
        window.open(url, '_blank');
      }, true);

      wrapper.appendChild(rpmBtn);
      wrapper.appendChild(mapsBtn);
    }

    document.querySelectorAll('button,a,[role="button"]').forEach(tryIntercept);

    // Collect newly added nodes that contain email addresses across debounce ticks
    const _pendingEmail = new Set();
    const EMAIL_SNIFF = /[\w.\-]+@[\w.\-]+\.\w{2,}/;

    // ── Detect DAT row expansion (detail panel appearing) ───────────────────────
    // When the user clicks a load row DAT inserts a detail element adjacent to
    // the row. Detecting that insertion lets us open our panel without attaching
    // a click listener to the row — which breaks when DAT re-renders the row
    // element on first click, silently removing any listener we added.
    const _pendingExpand = new Set();
    let _expandTimer;

    function flushExpand() {
      if (!_initialized) return;
      console.log('[LaneIQ] flushExpand fired, pending nodes:', _pendingExpand.size);
      for (const node of _pendingExpand) {
        if (!node.isConnected || node.closest('[id^="dlm-"]')) continue;
        if (node.dataset.dlmExpandSeen) continue;

        const cls = (node.className || '').toLowerCase();
        const isDatDetail = cls.includes('details-container');
        console.log('[LaneIQ] expansion node class:', cls, '| isDatDetail:', isDatDetail);

        const row = _lastClickedRow || null;
        console.log('[LaneIQ] using row:', row?.dataset?.dlmOrigin);

        node.dataset.dlmExpandSeen = '1';

        const b = row?.dataset.dlmBroker || '';

        // ── STEP 1: prefer the CLEAN detail-panel source. The detail `node` is
        // guaranteed present here (it triggered this handler), so we read the
        // city from a dedicated ELEMENT rather than scraping raw text — unlike
        // dlmOrigin / the row-cell scrape, which the no-match path otherwise falls
        // through to (badge-laden text, e.g. "Required Pueblo, CO"). Each clean
        // candidate must validate to a real "City, ST"; clean-source values are
        // trusted as-is (NOT run through stripColLabel — that's also what keeps
        // "Miles City, MT" from being truncated).
        let o = '', d = '', oClean = false, dClean = false;

        // 1a. city-state-container elements — PRIMARY. Verified DOM: each holds
        // ONLY the city/comma/state spans (div.city-state-container, siblings
        // inside div.orig-dest-container); badges render as SIBLINGS at the
        // orig-dest level, never as children. So the element's innerText is
        // always a clean "City, ST" — badge-proof, same-line or not.
        // cityEls[0]=origin, cityEls[1]=dest (document order).
        {
          let cityEls = node ? node.querySelectorAll('[class*="city-state-container"]') : [];
          if (cityEls.length < 2 && node) {
            let ancestor = node.parentElement;
            for (let i = 0; i < 5 && ancestor && ancestor !== document.body; i++) {
              const found = ancestor.querySelectorAll('[class*="city-state-container"]');
              if (found.length >= 2) { cityEls = found; break; }
              ancestor = ancestor.parentElement;
            }
          }
          if (cityEls.length >= 2) {
            const co = validCityST(cityEls[0].innerText), cd = validCityST(cityEls[1].innerText);
            if (co) { o = co; oClean = true; }
            if (cd) { d = cd; dClean = true; }
          }
        }
        // 1b. DETAIL_ROUTE_RE on the detail node — SECONDARY, for when the
        // container is absent. Arrow-ordered "City, ST → City, ST" with a
        // no-newline city class so a badge element on a prior line can't bleed in.
        if ((!o || !d) && node) {
          const m = DETAIL_ROUTE_RE.exec(node.innerText || '');
          if (m) {
            const co = validCityST(m[1]), cd = validCityST(m[2]);
            if (!o && co) { o = co; oClean = true; }
            if (!d && cd) { d = cd; dClean = true; }
          }
        }

        // ── RETRY GUARD: if both clean detail-panel sources failed, the detail
        // node hasn't finished rendering yet (DAT populates city-state-container
        // async). Schedule one self-retry after 250ms rather than falling through
        // to the dirty row.dataset.dlmOrigin, which can carry badge text like
        // "Required Ft Lupton, CO". On the retry pass oClean/dClean will succeed
        // once DAT has rendered; if they still fail, Step 3 below runs as a
        // genuine last resort (rare). dlmExpandRetry prevents infinite loops;
        // isConnected guards against acting on a node DAT has since removed.
        if (!oClean && !dClean && !node.dataset.dlmExpandRetry) {
          node.dataset.dlmExpandRetry = '1';
          delete node.dataset.dlmExpandSeen; // was stamped above; clear so retry can re-enter
          setTimeout(() => { if (node.isConnected) { _pendingExpand.add(node); flushExpand(); } }, 250);
          continue;
        }

        // ── STEP 3 fallback: only when a clean source didn't yield a valid
        // City,ST. Use the stamped dataset (clean when the load matched) / the
        // row-cell scrape, then stripColLabel as the thin safety net (kept here
        // ONLY — do not expand it).
        if (!o) o = row?.dataset.dlmOrigin || '';
        if (!d) d = row?.dataset.dlmDest   || '';
        if (!o || !d) {
          // Legacy greedy cityPattern on an ancestor's innerText.
          if (node) {
            let candidate = node.parentElement;
            for (let i = 0; i < 8 && candidate; i++) {
              if ((!o || !d) && i >= 4) {
                const text = candidate.innerText || '';
                const cityPattern = /[A-Z][A-Za-z .]{1,20},\s*[A-Z]{2}/g;
                const hits = [...text.matchAll(cityPattern)];
                if (hits.length >= 2) {
                  if (!o) o = hits[0][0].trim();
                  if (!d) d = hits[1][0].trim();
                  break;
                }
              }
              candidate = candidate.parentElement;
            }
          }
          // Legacy ROUTE_RE on the clicked row element (node already tried above).
          if ((!o || !d) && row) {
            const m = ROUTE_RE.exec(row.innerText || row.textContent || '');
            if (m) {
              if (!o) o = m[1].trim();
              if (!d) d = m[2].trim();
            }
          }
        }
        // stripColLabel + cleanCity ONLY on fallback-sourced values — clean
        // detail-source values are already validated and must not be re-stripped.
        if (o && !oClean) o = cleanCity(stripColLabel(o));
        if (d && !dClean) d = cleanCity(stripColLabel(d));

        const expandKey = `${o}|${d}`;
        const now = Date.now();
        if (expandKey === _lastExpandKey && now - _lastExpandTime < 400) continue;
        _lastExpandKey = expandKey;
        _lastExpandTime = now;
        if (!useCSV && !useDB) {
          // Both sources off — show panel with disabled state so toggles remain accessible
          if (!panel) panel = buildPanel();
          if (!panelPopped) panel.style.display = 'flex';
          switchTab('history');
          const _noSrcMsg = '<div style="text-align:center;padding:36px 20px;color:#aeaeb2;font-size:13px;line-height:1.6">Enable a data source in settings to see rates</div>';
          panelBodyHTML = _noSrcMsg;
          const _noSrcBody = document.getElementById('dlm-body');
          if (_noSrcBody) { _noSrcBody.innerHTML = _noSrcMsg; _noSrcBody.scrollTop = 0; }
        } else if (licenseTier === 'pro' && useDB && useCSV && o) {
          showPanelDual(o, d, d ? findOD(o, d) : [], findO(o), b ? findBroker(b, o) : [], b, node);
        } else if (licenseTier === 'pro' && useDB && !useCSV) {
          showPanelFromAPI(o, d, node);
        } else if (o) {
          const odM = d ? findOD(o, d) : [];
          const oM  = findO(o);
          const bM  = b ? findBroker(b, o) : [];
          // Always render the full panel (Current Load + Lane Lookup), even with
          // zero direct history — radiusMatch can still surface nearby-origin
          // lanes that exact/same-origin lookups miss. (Previously zero-match
          // rows hit showEmptyPanel, which skipped Lane Lookup entirely.)
          showPanel(o, d, odM, oM, bM, b);
        } else {
          clearPanel();
        }
      }
      _pendingExpand.clear();
    }

    let _rt;
    // A+B: inject the route buttons into a freshly-inserted detail panel
    // immediately, retrying briefly until DAT renders the "View Route" control.
    // tryIntercept is idempotent (dataset.dlmRouteOk guard), so re-running on
    // each retry tick is safe. ~50ms × 10 ≈ 500ms cap.
    function interceptInNode(root, attempt = 0) {
      if (!root || !root.isConnected) return;
      let found = false;
      root.querySelectorAll('button,a,[role="button"]').forEach(b => {
        if (/view\s*route/i.test((b.textContent || '').replace(/\s+/g, ' ').trim())) found = true;
        tryIntercept(b);
      });
      if (!found && attempt < 10) {
        setTimeout(() => interceptInNode(root, attempt + 1), 50);
      }
    }

    new MutationObserver(mutations => {
      for (const { addedNodes, removedNodes } of mutations) {
        for (const node of addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.closest?.('[id^="dlm-"]')) continue; // skip our own injected elements

          // Email detection (existing)
          if (EMAIL_SNIFF.test(node.textContent || '')) _pendingEmail.add(node);

          // Queue for expansion detection only when the node has class names that
          // suggest it is a DAT detail/drawer panel. The previous-sibling check
          // was removed — it matched re-rendered row elements and caused flushExpand
          // to open the panel for the wrong row on every React reconciliation.
          const cls = (typeof node.className === 'string'
            ? node.className
            : node.className?.baseVal || '').toLowerCase();
          if (cls.includes('details-container') || cls.includes('dat-load-details')) {
            _pendingExpand.add(node);
            // A+B: inject route buttons into this detail panel now (with a short
            // bounded retry) rather than waiting on the global 250ms rescan below.
            interceptInNode(node);
          }
        }

        // removedNodes — no action. The panel stays open until the user
        // explicitly closes it with the X button.
      }
      // Only schedule flushExpand when detail-panel nodes were actually queued —
      // do not fire on removal-only batches or unrelated DOM updates.
      if (_pendingExpand.size > 0) {
        clearTimeout(_expandTimer);
        _expandTimer = setTimeout(flushExpand, 80);
      }
      clearTimeout(_rt);
      _rt = setTimeout(() => {
        document.querySelectorAll('button,a,[role="button"]').forEach(tryIntercept);

        // Process each newly added subtree that contained an email address.
        // We scan both the root node and direct element children so we catch
        // DAT's deeply nested contact sections regardless of class name.
        for (const node of _pendingEmail) {
          if (!node.isConnected) continue;
          injectDetailPanelChips(node);
          node.querySelectorAll('*').forEach(child => {
            if (!child.dataset.dlmDetailChips && child.offsetWidth > 120)
              injectDetailPanelChips(child);
          });
        }
        _pendingEmail.clear();

        // Fallback: also query known panel class patterns for elements that were
        // modified in-place (textContent swapped) rather than freshly inserted.
        document.querySelectorAll(
          '[class*="loadDetail"],[class*="LoadDetail"],[class*="load-detail"],' +
          '[class*="detailPanel"],[class*="detail-panel"],[class*="DetailPanel"],' +
          '[class*="contactInfo"],[class*="ContactInfo"],[class*="contact-info"],' +
          '[class*="drawer"],[class*="Drawer"],[class*="contact"],[class*="Contact"]'
        ).forEach(injectDetailPanelChips);
      }, 250);
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ── Email chips in load detail / contact panels ──────────────────────────────
  // Scans a detail panel container for bare email addresses and styles each
  // as a tappable chip — same pill style as the load board rows.
  function injectDetailPanelChips(container) {
    if (container.dataset.dlmDetailChips) return;
    if (container.offsetWidth < 120) return; // skip tiny/hidden elements
    container.dataset.dlmDetailChips = '1';

    const EMAIL_RE  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
    const SKIP_ADDR = /dat\.com|google\.com|example\.com|optimizely\.com|sentry\.io/i;

    // Collect text nodes containing email addresses
    const hits = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const m = node.textContent.match(EMAIL_RE);
      if (m && !SKIP_ADDR.test(m[0])) hits.push({ node, email: m[0] });
    }

    for (const { node, email } of hits) {
      const parent = node.parentNode;
      if (!parent || parent.dataset.dlmChip) continue;

      // Reuse getDetailCities — it walks up from the email element, finding the
      // load's origin/dest from nearby data attributes or class-named elements.
      const onClick = async e => {
        e.stopPropagation(); e.preventDefault();
        const chip = e.currentTarget;
        const { origin: freshOrigin, dest: freshDest } = getDetailCities(chip);
        const freshDate = getDetailDate(chip);
        const ok = await sendEmail(email, freshOrigin, freshDest || '', freshDate, milesFromChip(chip));
        if (ok) flashChipSent(chip); else showSetupMsg(chip);
      };

      // Leaf element whose entire text is the email — style it in place
      if (!parent.children.length && node.textContent.trim() === email && parent !== container) {
        parent.dataset.dlmChip = '1';
        parent.classList.add('dlm-email-chip');
        parent.title = `Click to email ${email}`;
        parent.addEventListener('click', onClick, true);
        continue;
      }

      // Email embedded in a larger text block — splice a chip span in
      const idx = node.textContent.indexOf(email);
      if (idx === -1) continue;
      const chip = document.createElement('span');
      chip.className      = 'dlm-email-chip';
      chip.dataset.dlmChip = '1';
      chip.textContent    = email;
      chip.title          = `Click to email ${email}`;
      chip.addEventListener('click', onClick, true);
      parent.insertBefore(document.createTextNode(node.textContent.slice(0, idx)),             node);
      parent.insertBefore(chip,                                                                 node);
      parent.insertBefore(document.createTextNode(node.textContent.slice(idx + email.length)), node);
      parent.removeChild(node);
    }
  }

  function getDetailCities(fromEl) {
    // ── Strategy 1: walk up from the clicked button ───────────────────────────
    // processRow() stores origin/dest as data attributes on the row element.
    // The VIEW ROUTE button is inside or very near that same row.
    let node = fromEl;
    while (node && node !== document.body) {
      if (node.dataset.dlmOrigin) {
        return {
          origin: cleanCity(node.dataset.dlmOrigin),
          dest:   cleanCity(node.dataset.dlmDest || ''),
        };
      }
      node = node.parentElement;
    }

    // ── Strategy 2: search within the closest 6 ancestor containers ───────────
    // Handles cases where the button is in a detail drawer next to the row.
    node = fromEl;
    for (let i = 0; i < 6; i++) {
      node = node?.parentElement;
      if (!node || node === document.body) break;
      const row = node.querySelector('[data-dlm-origin]');
      if (row) {
        return {
          origin: cleanCity(row.dataset.dlmOrigin),
          dest:   cleanCity(row.dataset.dlmDest || ''),
        };
      }
    }

    // ── Strategy 3: text-pattern scan scoped to the button's nearest panel ────
    // Never use document.querySelector with broad class selectors — those hit
    // the search-filter bar and navigation elements before the load data.
    let scope = fromEl;
    for (let i = 0; i < 12; i++) {
      scope = scope?.parentElement;
      if (!scope || scope === document.body) break;
      const cls = (scope.className || '').toLowerCase();
      if (cls.includes('load') || cls.includes('detail') ||
          cls.includes('panel') || cls.includes('drawer') || cls.includes('card')) {
        const SKIP = /^(my account|origin|destination|filter|search|view|route|dat|login|dh|dh-d|dh-o|van|reefer|flat|step|dry)/i;
        // Single-word DAT UI labels that appear immediately before a city name
        const LABEL_PREFIX = /^\s*(?:Trip|Origin|Dest(?:ination)?|Pick(?:up)?|Del(?:ivery)?|From|To|Load|Drop|Stop)\s+/i;
        const re = /\b([A-Za-z][A-Za-z\s\.]{1,22}),\s*([A-Z]{2})\b/g;
        const cities = [];
        let m;
        while ((m = re.exec(scope.innerText)) !== null && cities.length < 3) {
          const c = m[1].trim().replace(LABEL_PREFIX, '').trim();
          if (c.length >= 2 && !SKIP.test(c)) cities.push(`${c}, ${m[2]}`);
        }
        if (cities.length >= 2)
          return { origin: cleanCity(cities[0]), dest: cleanCity(cities[1]) };
      }
    }

    return { origin: '', dest: '' };
  }

  function getDetailRate(fromEl) {
    // Pull the broker's POSTED rate for this load — match or NOT. We must not
    // depend on the row being "stamped" (dataset.dlmOrigin): no-match loads are
    // never stamped, yet they still have a posted rate. So we scope extraction
    // to the stamped row when available, else to the nearest row/detail
    // container.
    //
    // Skip DAT iQ / market-rate / estimate containers — those show projected
    // prices (Spot, Contract, Avg), not the broker's posted rate.
    const SKIP_CONTAINER =
      '[class*="iq"],[class*="Iq"],[class*="IQ"],' +
      '[class*="market"],[class*="Market"],' +
      '[class*="estimate"],[class*="Estimate"],' +
      '[class*="spot"],[class*="Spot"],' +
      '[class*="contract"],[class*="Contract"],' +
      '[class*="suggest"],[class*="Suggest"],' +
      '[class*="average"],[class*="Average"]';

    // Extract the first "$…" posted rate within a scope, skipping projections.
    const extractFrom = (scope) => {
      const candidates = Array.from(
        scope.querySelectorAll(
          '[class*="rate"],[class*="Rate"],[class*="price"],[class*="Price"],' +
          '[class*="total"],[class*="Total"]'
        )
      ).filter(el => {
        if (/\bdlm-/.test(el.className) || el.closest('[id^="dlm-"]')) return false;
        if (el.closest(SKIP_CONTAINER)) return false;
        return true;
      });
      for (const el of candidates) {
        const text = el.textContent.trim();
        // "–" / "—" means the broker has not posted a rate — leave field empty.
        if (!text || /^[–—\-\s]+$/.test(text)) continue;
        // Must START with "$" — rejects DAT iQ labels like "Spot $2,150".
        if (!text.startsWith('$')) continue;
        // Capture ONLY the primary grouped dollar amount. \d{1,3}(?:,\d{3})*
        // stops at a thousands boundary, so a rate cell whose text runs straight
        // into the trip-miles column ("$1,400" + "763" → "$1,400763") yields
        // "1,400" (= 1400), never "1400763". A plain run like "850763" likewise
        // caps at the first 1–3 digits ("850").
        const m = text.match(/^\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/);
        if (!m) continue;
        // Skip the "$X.XX/mi" per-mile subtext (a '/' immediately follows it).
        if (text.slice(m[0].length).trimStart().startsWith('/')) continue;
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (v > 0) return v;
      }
      return null;
    };

    // Strategy 1: the stamped row (matched / DB loads).
    let node = fromEl;
    while (node && node !== document.body) {
      if (node.dataset.dlmOrigin) {
        const v = extractFrom(node);
        if (v != null) return v;
        break;  // stop — fall through to the container fallback below
      }
      node = node.parentElement;
    }

    // Strategy 2: nearest row/detail container (no-match loads — never stamped).
    node = fromEl;
    for (let i = 0; i < 8; i++) {
      node = node?.parentElement;
      if (!node || node === document.body) break;
      const cls = (node.className || '').toString().toLowerCase();
      const isRow = node.matches && node.matches('[class*="row-container"],[class*="row-cells"],[data-test*="row"]');
      if (isRow || cls.includes('load') || cls.includes('detail') ||
          cls.includes('panel') || cls.includes('drawer') || cls.includes('card')) {
        const v = extractFrom(node);
        if (v != null) return v;
      }
    }
    return 0; // genuinely no posted rate → leave the Rate field blank
  }

  function getDetailDate(fromEl) {
    // Walk up to the stamped row and extract the first pickup date from its text.
    // DAT renders dates inline (e.g. "01/15" or "01/15-01/17").
    let node = fromEl;
    while (node && node !== document.body) {
      if (node.dataset.dlmOrigin) {
        const m = (node.textContent || '').match(/\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/);
        return m ? m[1] : '';
      }
      node = node.parentElement;
    }
    return '';
  }

  // ── Route modal ──────────────────────────────────────────────────────────────
  // ── Route modal (tabbed: multiple routes, switchable) ───────────────────────
  function showRouteModal(origin, dest, rate, onClose = null) {
    // Already open → add a tab instead of rebuilding the shell.
    if (_routeModal && document.body.contains(_routeModal.box)) {
      _routeModal.openTab(origin, dest, rate);
      return;
    }
    // Tear down any stale prior modal cleanly before building a fresh shell.
    if (_routeModalTeardown) { _routeModalTeardown(); _routeModalTeardown = null; }
    document.getElementById('dlm-route-modal')?.remove();

    // ===== SHELL (built once per modal) =====
    const wrap = document.createElement('div');
    wrap.id = 'dlm-route-modal';

    const box = document.createElement('div');
    box.className = 'dlm-modal';
    box.setAttribute('role', 'dialog');

    const mhdr = document.createElement('div');
    mhdr.className = 'dlm-modal-hdr';
    const titleEl = document.createElement('div');
    titleEl.className = 'dlm-modal-hdr-title';   // mirrors the active tab's lane
    mhdr.appendChild(titleEl);
    const minBtn = document.createElement('button');
    minBtn.className = 'dlm-modal-min';
    minBtn.title = 'Minimize';
    minBtn.textContent = '—';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'dlm-modal-close';
    closeBtn.title = 'Close (Esc)';
    closeBtn.textContent = '✕';
    const hdrActions = document.createElement('div');
    hdrActions.style.cssText = 'display:flex;align-items:center;gap:6px;flex-shrink:0;';
    hdrActions.append(minBtn, closeBtn);
    mhdr.appendChild(hdrActions);

    const tabStrip = document.createElement('div');
    tabStrip.className = 'dlm-modal-tabs';
    const bodyHost = document.createElement('div');
    bodyHost.className = 'dlm-modal-panes';
    box.append(mhdr, tabStrip, bodyHost);
    wrap.append(box);

    // ===== Per-route pane factory =====
    // q() is scoped to mbody (this pane), NOT box, so multiple panes never
    // cross-read each other's [data-dlm] inputs. The DH origin watcher is
    // started only in activate() and stopped in deactivate()/destroy().
    function buildPane(origin, dest, rate) {
      // ── Body ────────────────────────────────────────────────────────────────
      const mbody = document.createElement('div');
      mbody.className = 'dlm-modal-body';
      mbody.style.display = 'none';

    // Left: map
    const left = document.createElement('div');
    left.className = 'dlm-modal-left';

    const mapContainer = document.createElement('div');
    mapContainer.className = 'dlm-map-frame';
    mapContainer.style.cssText = 'background:#f5f5f7;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;';

    // Stored main polyline — set once on load, reused when DH From changes
    let mainPolyline = null;

    // Redraws the Static Maps image. Call with a DH polyline + city to show
    // the deadhead leg in gray; omit both to show only the loaded route.
    function renderMap(dhPolyline, dhCity) {
      mapContainer.innerHTML = '';
      if (!mainPolyline) return;

      let url = 'https://maps.googleapis.com/maps/api/staticmap' +
        '?size=800x480&scale=2' +
        `&path=color:0x007affff|weight:5|enc:${encodeURIComponent(mainPolyline)}`;

      if (dhPolyline && dhCity) {
        url += `&path=color:0x8e8e93cc|weight:3|enc:${encodeURIComponent(dhPolyline)}`;
        url += `&markers=color:gray|label:T|${encodeURIComponent(dhCity)}`;
        url += `&markers=color:blue|label:A|${encodeURIComponent(origin)}`;
        url += `&markers=color:green|label:B|${encodeURIComponent(dest)}`;
      } else {
        url += `&markers=color:blue|label:A|${encodeURIComponent(origin)}`;
        url += `&markers=color:green|label:B|${encodeURIComponent(dest)}`;
      }
      url += `&key=${encodeURIComponent(mapsApiKey)}`;

      const img = document.createElement('img');
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
      img.alt = 'Route map';
      img.src = url;
      mapContainer.appendChild(img);
    }

    if (mapsApiKey && origin && dest) {
      mapContainer.innerHTML = '<span style="font-size:13px;color:#8e8e93">Loading map…</span>';

      // Fetch the loaded route first; once mainPolyline is ready, trigger the DH
      // leg via fetchDHRoute so both renders happen in the correct order and
      // there is no duplicate DH request when dhOrigin was auto-filled.
      chrome.runtime.sendMessage(
        { type: 'getRoute', origin, dest, apiKey: mapsApiKey }
      ).catch(() => null).then(mainResp => {
        if (!mainResp || mainResp.error) {
          mapContainer.innerHTML = `<span style="font-size:13px;color:#ff453a">Maps key error — check your API key in LaneIQ settings</span>`;
          const distEl = q('stat-dist');
          if (distEl) distEl.textContent = 'key error';
          return;
        }

        mainPolyline = mainResp.polyline;

        // Populate loaded-route stats and miles field
        const milesEl = q('miles');
        if (milesEl && !milesEl.value && mainResp.miles) { milesEl.value = mainResp.miles; calc(); }
        const distEl = q('stat-dist'), durEl = q('stat-dur');
        if (distEl && mainResp.miles)    distEl.textContent = `${mainResp.miles} mi`;
        if (durEl  && mainResp.duration) durEl.textContent  = mainResp.duration;

        // Render main route immediately, then add DH leg if a city is set
        renderMap(null, null);
        if (q('dh-from')?.value?.trim()) fetchDHRoute();
      });
    } else {
      mapContainer.innerHTML = `<div class="dlm-map-nokey">
        <span>Add a Google Maps API key in LaneIQ settings</span>
        <small>Enable Directions API + Distance Matrix API on the same key</small>
      </div>`;
    }
    left.appendChild(mapContainer);

    // Stats bar — DH section always present so it can populate after DH From is typed
    const stats = document.createElement('div');
    stats.className = 'dlm-map-stats';
    stats.innerHTML = `
      <span style="font-size:11px;color:#aeaeb2;font-weight:500">Loaded</span>
      <span class="dlm-map-stat" data-dlm="stat-dist">${mapsApiKey ? 'Loading…' : '—'}</span>
      <span class="dlm-map-stat-sep">·</span>
      <span class="dlm-map-stat" data-dlm="stat-dur"></span>
      <span class="dlm-map-stat-sep" style="margin-left:8px">|</span>
      <span style="font-size:11px;color:#aeaeb2;font-weight:500;margin-left:8px">DH</span>
      <span class="dlm-map-stat" data-dlm="stat-dh-dist">—</span>
      <span class="dlm-map-stat-sep">·</span>
      <span class="dlm-map-stat" data-dlm="stat-dh-dur"></span>`;
    left.appendChild(stats);

    // Right: calculator
    const right = document.createElement('div');
    right.className = 'dlm-modal-right';
    right.innerHTML = `
      <div class="dlm-calc-hdr">RPM Calculator</div>
      <div class="dlm-calc-body">
        <div class="dlm-cf">
          <span class="dlm-cf-label">Rate</span>
          <div class="dlm-cf-row">
            <span class="dlm-cf-pre">$</span>
            <input class="dlm-cf-input" data-dlm="rate" type="number" min="0"
                   value="${rate || ''}" placeholder="0">
          </div>
        </div>
        <div class="dlm-cf">
          <span class="dlm-cf-label">Miles</span>
          <div class="dlm-cf-row">
            <input class="dlm-cf-input" data-dlm="miles" type="number" min="0"
                   placeholder="loading…">
          </div>
        </div>
        <div class="dlm-cf dlm-cf-computed">
          <span class="dlm-cf-label">RPM</span>
          <span class="dlm-cf-val" data-dlm="rpm">—</span>
        </div>
        <div class="dlm-cf-sep"></div>
        <div class="dlm-cf">
          <span class="dlm-cf-label">DH From</span>
          <div class="dlm-cf-row">
            <input class="dlm-cf-input" data-dlm="dh-from" type="text"
                   placeholder="City, ST" style="text-align:left">
          </div>
        </div>
        <div class="dlm-cf">
          <span class="dlm-cf-label">DH Miles</span>
          <div class="dlm-cf-row">
            <input class="dlm-cf-input" data-dlm="dh" type="number" min="0" placeholder="—">
            <span class="dlm-cf-suf">mi</span>
          </div>
        </div>
        <div class="dlm-cf-sep"></div>
        <div class="dlm-cf">
          <span class="dlm-cf-label">MPG</span>
          <div class="dlm-cf-row">
            <input class="dlm-cf-input" data-dlm="mpg" type="number" min="1" step="0.1"
                   value="${dlmMpg}">
          </div>
        </div>
        <div class="dlm-cf">
          <span class="dlm-cf-label">Fuel</span>
          <div class="dlm-cf-row">
            <span class="dlm-cf-pre">$</span>
            <input class="dlm-cf-input" data-dlm="fuel" type="number" min="0" step="0.01"
                   value="${dlmFuelPrice}">
            <span class="dlm-cf-suf">/gal</span>
          </div>
        </div>
        <div class="dlm-cf dlm-cf-computed">
          <span class="dlm-cf-label">Fuel Cost</span>
          <span class="dlm-cf-val" data-dlm="fuelcost">—</span>
        </div>
        <div class="dlm-cf-sep"></div>
        <div class="dlm-cf">
          <span class="dlm-cf-label">Driver $/mi</span>
          <div class="dlm-cf-row">
            <span class="dlm-cf-pre">$</span>
            <input class="dlm-cf-input" data-dlm="driver-rpm" type="number" min="0" step="0.01"
                   value="${dlmDriverRate || ''}" placeholder="0.00">
          </div>
        </div>
        <div class="dlm-cf dlm-cf-computed">
          <span class="dlm-cf-label">Driver Cost</span>
          <span class="dlm-cf-val" data-dlm="drivercost">—</span>
        </div>
        <div class="dlm-cf">
          <span class="dlm-cf-label">Tolls</span>
          <div class="dlm-cf-row">
            <span class="dlm-cf-pre">$</span>
            <input class="dlm-cf-input" data-dlm="tolls" type="number" min="0" step="1" placeholder="0">
          </div>
        </div>
        <div class="dlm-cf dlm-cf-computed" style="margin-top:4px">
          <span class="dlm-cf-label">Profit</span>
          <span class="dlm-cf-profit-val" data-dlm="profit">—</span>
        </div>
      </div>`;

    mbody.append(left, right);

    // ── Live calculator (q scoped to THIS pane's mbody, not box) ─────────────
    function q(attr) { return mbody.querySelector(`[data-dlm="${attr}"]`); }

    function calc() {
      const rateV      = parseFloat(q('rate')?.value)       || 0;
      const miles      = parseFloat(q('miles')?.value)      || 0;
      const mpg        = parseFloat(q('mpg')?.value)        || 0;
      const fuel       = parseFloat(q('fuel')?.value)       || 0;
      const dhMiles    = parseFloat(q('dh')?.value)         || 0;
      const driverRpm  = parseFloat(q('driver-rpm')?.value) || 0;
      const tolls      = parseFloat(q('tolls')?.value)      || 0;

      const totalMiles = miles + dhMiles;
      const rpm        = (rateV && miles) ? rateV / miles                             : null;
      const fuelCost   = (totalMiles && mpg && fuel) ? (totalMiles / mpg) * fuel      : null;
      const driverCost = (totalMiles && driverRpm)   ? totalMiles * driverRpm         : 0;
      const profit     = rateV ? rateV - (fuelCost || 0) - tolls - driverCost        : null;

      q('rpm').textContent        = rpm        ? `$${rpm.toFixed(2)}/mi`                       : '—';
      q('fuelcost').textContent   = fuelCost   ? `$${Math.round(fuelCost).toLocaleString()}`   : '—';
      q('drivercost').textContent = driverCost ? `$${Math.round(driverCost).toLocaleString()}` : '—';

      const pEl = q('profit');
      pEl.textContent = profit != null ? `$${Math.round(profit).toLocaleString()}` : '—';
      pEl.style.color = profit == null ? '#1d1d1f' : profit >= 0 ? '#34c759' : '#ff3b30';

      // Persist user-entered values
      if (mpg       && mpg       !== dlmMpg)        { dlmMpg        = mpg;       chrome.storage.local.set({ dlmMpg: mpg }); }
      if (fuel      && fuel      !== dlmFuelPrice)   { dlmFuelPrice  = fuel;      chrome.storage.local.set({ dlmFuelPrice: fuel }); }
      if (driverRpm && driverRpm !== dlmDriverRate)  { dlmDriverRate = driverRpm; chrome.storage.local.set({ dlmDriverRate: driverRpm }); }
    }

    ['rate','miles','mpg','fuel','dh','driver-rpm','tolls'].forEach(k => q(k)?.addEventListener('input', calc));

    // ── DH From → auto-fetch DH miles + redraw map ────────────────────────────
    function fetchDHRoute() {
      if (!mapsApiKey) return;
      const dhCity = q('dh-from')?.value?.trim();
      const dhDistEl = q('stat-dh-dist');
      const dhDurEl  = q('stat-dh-dur');
      const dhEl     = q('dh');

      // Cleared field — reset DH stats and redraw without DH leg
      if (!dhCity || dhCity.length < 3) {
        if (dhDistEl) dhDistEl.textContent = '—';
        if (dhDurEl)  dhDurEl.textContent  = '';
        if (dhEl)     { dhEl.value = ''; calc(); }
        renderMap(null, null);
        return;
      }

      if (dhDistEl) dhDistEl.textContent = '…';

      chrome.runtime.sendMessage(
        { type: 'getRoute', origin: dhCity, dest: origin, apiKey: mapsApiKey }
      ).then(resp => {
        if (!resp || resp.error) {
          if (dhDistEl) dhDistEl.textContent = '—';
          return;
        }
        if (dhEl) { dhEl.value = resp.miles; calc(); }
        if (dhDistEl) dhDistEl.textContent = `${resp.miles} mi`;
        if (dhDurEl)  dhDurEl.textContent  = resp.duration;
        renderMap(resp.polyline, dhCity);
      }).catch(() => { if (dhDistEl) dhDistEl.textContent = '—'; });
    }

    // ── DH From: manual typing → debounced fetch ──────────────────────────────
    // dhResolved gates the origin watcher: once the field is set (auto or by
    // the user) we don't re-watch on re-activate, and never clobber a manual edit.
    let _dhDebounce = null;
    let stopOriginWatch = () => {};   // no-op until activate() starts the watcher
    let dhResolved = false;
    const dhFromEl = q('dh-from');
    if (dhFromEl) {
      dhFromEl.addEventListener('change', () => { dhResolved = true; fetchDHRoute(); });
      dhFromEl.addEventListener('input', () => {
        dhResolved = true;
        clearTimeout(_dhDebounce);
        _dhDebounce = setTimeout(fetchDHRoute, 800);
      });
    }

    calc();

    const label = `${origin || '—'} → ${dest || '—'}`;

    // Only the ACTIVE pane runs a DH origin watcher → at most one observer alive.
    function activate() {
      mbody.style.display = '';
      if (!dhResolved && dhFromEl) {
        stopOriginWatch = getDATOriginValue(dhFromEl, () => { dhResolved = true; fetchDHRoute(); });
      }
    }
    function deactivate() {
      mbody.style.display = 'none';
      stopOriginWatch(); stopOriginWatch = () => {};
    }
    function destroy() {
      stopOriginWatch(); stopOriginWatch = () => {};
      clearTimeout(_dhDebounce);
      mbody.remove();
    }

    return { origin, dest, label, paneEl: mbody, activate, deactivate, destroy };
    }
    // ===== end buildPane =====

    // ===== SHELL behavior: position / persist / minimize / drag / resize =====
    const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
    const isCollapsed = () => box.classList.contains('dlm-modal-collapsed');

    // Position: restore saved rect (validated + clamped) or center by default.
    const sr = _routeModalRect;
    const savedW = sr ? num(sr.width)  : null;
    const savedH = sr ? num(sr.height) : null;
    if (sr && num(sr.left) > 0 && num(sr.top) > 0) {
      const w = savedW || 1222;
      box.style.left = Math.max(0, Math.min(window.innerWidth  - Math.min(w, window.innerWidth), sr.left)) + 'px';
      box.style.top  = Math.max(0, Math.min(window.innerHeight - 40, sr.top)) + 'px';
      if (savedW) box.style.width  = savedW + 'px';
      if (savedH) box.style.height = savedH + 'px';
    } else {
      const w = Math.min(1222, window.innerWidth - 48);
      box.style.left = Math.max(0, (window.innerWidth - w) / 2) + 'px';
      box.style.top  = '36px';
    }
    if (sr && sr.min) {
      box.classList.add('dlm-modal-collapsed');
      minBtn.textContent = '▢'; minBtn.title = 'Expand';
    }

    document.body.appendChild(wrap);

    const persistRect = () => {
      if (!document.body.contains(box)) return;
      const b = box.getBoundingClientRect();
      if (!(b.width > 0 && b.height > 0)) return;
      if (!(b.left > 0 && b.top > 0)) return;
      if (isCollapsed()) {
        const prev = _routeModalRect || {};
        _routeModalRect = { left: b.left, top: b.top, width: num(prev.width), height: num(prev.height), min: true };
      } else {
        _routeModalRect = { left: b.left, top: b.top, width: b.width, height: b.height, min: false };
      }
      chrome.storage.local.set({ 'dlm-route-modal-rect': _routeModalRect });
    };

    const setCollapsed = (on) => {
      box.classList.toggle('dlm-modal-collapsed', on);
      minBtn.textContent = on ? '▢' : '—';
      minBtn.title = on ? 'Expand' : 'Minimize';
      persistRect();
    };
    minBtn.addEventListener('click', e => { e.stopPropagation(); setCollapsed(!isCollapsed()); });

    let mdlDragging = false, mdlOffX = 0, mdlOffY = 0, mdlMoved = false;
    mhdr.style.cursor = 'grab';
    const onHdrDown = e => {
      if (e.target.closest('.dlm-modal-close') || e.target.closest('.dlm-modal-min') || e.target.closest('.dlm-modal-tab')) return;
      mdlDragging = true; mdlMoved = false;
      const b = box.getBoundingClientRect();
      mdlOffX = e.clientX - b.left; mdlOffY = e.clientY - b.top;
      e.preventDefault();
    };
    const onMove = e => {
      if (!mdlDragging) return;
      mdlMoved = true;
      const w = box.offsetWidth;
      box.style.left = Math.max(0, Math.min(window.innerWidth  - w, e.clientX - mdlOffX)) + 'px';
      box.style.top  = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - mdlOffY)) + 'px';
    };
    const onUp = () => {
      if (!mdlDragging) return;
      mdlDragging = false;
      if (mdlMoved) persistRect();
      else if (isCollapsed()) setCollapsed(false);
    };
    mhdr.addEventListener('mousedown', onHdrDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);

    let _rzTimer = null, _roReady = false;
    const ro = new ResizeObserver(() => {
      if (!_roReady) { _roReady = true; return; }
      clearTimeout(_rzTimer);
      _rzTimer = setTimeout(persistRect, 300);
    });
    ro.observe(box);

    // ===== 8-point resize (edges + corners; replaces native resize:both) =====
    // Edges resize one dimension; corners resize both. Top/left edges anchor the
    // OPPOSITE edge (move left/top while resizing) so the box grows/shrinks from
    // the grabbed side. Mins mirror the CSS (.dlm-modal min-width/height); all
    // sides clamp to the viewport.
    const MINW = 520, MINH = 360;
    const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    let rzActive = false, rzN = false, rzS = false, rzE = false, rzW = false;
    let rzSX = 0, rzSY = 0, rzSL = 0, rzST = 0, rzSW = 0, rzSH = 0;

    const onRzMove = e => {
      if (!rzActive) return;
      const dx = e.clientX - rzSX, dy = e.clientY - rzSY;
      let L = rzSL, T = rzST, W = rzSW, H = rzSH;
      if (rzE) W = clampN(rzSW + dx, MINW, window.innerWidth  - rzSL);
      if (rzW) { const right  = rzSL + rzSW; W = clampN(rzSW - dx, MINW, right);  L = right  - W; }
      if (rzS) H = clampN(rzSH + dy, MINH, window.innerHeight - rzST);
      if (rzN) { const bottom = rzST + rzSH; H = clampN(rzSH - dy, MINH, bottom); T = bottom - H; }
      box.style.left = L + 'px'; box.style.top = T + 'px';
      box.style.width = W + 'px'; box.style.height = H + 'px';
    };
    const onRzUp = () => {
      if (!rzActive) return;
      rzActive = false;
      document.body.style.userSelect = '';
      persistRect();
    };
    const startRz = (e, dirs) => {
      if (isCollapsed()) return;
      // preventDefault + stopPropagation so a top/left edge strip never also
      // triggers the header drag or a text selection.
      e.preventDefault(); e.stopPropagation();
      rzActive = true;
      rzN = !!dirs.n; rzS = !!dirs.s; rzE = !!dirs.e; rzW = !!dirs.w;
      const b = box.getBoundingClientRect();
      rzSX = e.clientX; rzSY = e.clientY;
      rzSL = b.left; rzST = b.top; rzSW = b.width; rzSH = b.height;
      document.body.style.userSelect = 'none';
    };
    [['n', {n:1}], ['s', {s:1}], ['e', {e:1}], ['w', {w:1}],
     ['ne', {n:1,e:1}], ['nw', {n:1,w:1}], ['se', {s:1,e:1}], ['sw', {s:1,w:1}]
    ].forEach(([k, dirs]) => {
      const h = document.createElement('div');
      h.className = 'dlm-mrz dlm-mrz-' + k;
      h.addEventListener('mousedown', ev => startRz(ev, dirs));
      box.appendChild(h);
    });
    document.addEventListener('mousemove', onRzMove);
    document.addEventListener('mouseup', onRzUp);

    // ===== Tab controller =====
    const tabs = [];            // pane objects, insertion order, MAX 5
    let activeIdx = -1;

    function renderTabStrip() {
      tabStrip.innerHTML = '';
      tabs.forEach((pane, i) => {
        const tab = document.createElement('div');
        tab.className = 'dlm-modal-tab' + (i === activeIdx ? ' dlm-modal-tab-active' : '');
        const lbl = document.createElement('span');
        lbl.className = 'dlm-modal-tab-label';
        lbl.textContent = pane.label;
        lbl.title = pane.label;
        lbl.addEventListener('click', () => switchTab(i));
        const x = document.createElement('button');
        x.className = 'dlm-modal-tab-x';
        x.textContent = '✕';
        x.title = 'Close tab';
        x.addEventListener('click', e => { e.stopPropagation(); closeTab(i); });
        tab.append(lbl, x);
        tabStrip.appendChild(tab);
      });
    }

    function switchTab(i) {
      if (i < 0 || i >= tabs.length) return;
      if (activeIdx >= 0 && tabs[activeIdx]) tabs[activeIdx].deactivate();
      activeIdx = i;
      tabs[i].activate();
      titleEl.innerHTML = `${esc(tabs[i].origin || '—')}<span>→</span>${esc(tabs[i].dest || '—')}`;
      renderTabStrip();
    }

    function closeTab(i) {
      if (i < 0 || i >= tabs.length) return;
      const wasActive = (i === activeIdx);
      tabs[i].destroy();
      tabs.splice(i, 1);
      if (tabs.length === 0) { doClose(); return; }
      if (wasActive) {
        // Active pane is gone (destroyed) — force-activate a neighbor.
        activeIdx = -1;
        switchTab(Math.min(i, tabs.length - 1));
      } else {
        // A background tab closed — keep the current pane visible, just fix indices.
        if (i < activeIdx) activeIdx -= 1;
        renderTabStrip();
      }
    }

    function openTab(o, d, r) {
      const pane = buildPane(o, d, r);
      bodyHost.appendChild(pane.paneEl);
      tabs.push(pane);
      if (tabs.length > 5) {            // cap at 5 → oldest drops off
        tabs.shift().destroy();
        if (activeIdx >= 0) activeIdx -= 1;   // indices shifted left by one
      }
      // Do NOT reset activeIdx — switchTab must deactivate the currently-active
      // pane (hide it) before showing the new one, else panes overlap.
      switchTab(tabs.length - 1);
    }

    // ===== Close (tears down shell + ALL panes → zero observers survive) =====
    const doClose = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('mousemove', onRzMove);
      document.removeEventListener('mouseup', onRzUp);
      document.body.style.userSelect = '';
      document.removeEventListener('keydown', onKey);
      clearTimeout(_rzTimer);
      ro.disconnect();
      tabs.forEach(p => p.destroy());
      tabs.length = 0;
      wrap.remove();
      _routeModal = null;
      _routeModalTeardown = null;
      if (onClose) onClose();
    };
    closeBtn.addEventListener('click', doClose);
    const onKey = e => { if (e.key === 'Escape') doClose(); };
    document.addEventListener('keydown', onKey);
    _routeModalTeardown = doClose;
    _routeModal = { box, openTab, switchTab, closeTab, doClose };

    // Open the first tab for this lane.
    openTab(origin, dest, rate);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();

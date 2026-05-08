(function() {
  'use strict';

  // ── State ───────────────────────────────────────────────────────────────────
  let odIndex = null, oIndex = null, brokerIndex = null;
  let senderEmail = '', emailSubject = '', emailTemplate = '', senderGmailIndex = 0;
  let userName = '', userCompany = '';
  let gmailIndex = 0;
  let panel = null;
  let panelBodyHTML = '';
  let isDragging = false, dragOffX = 0, dragOffY = 0;
  let isResizing = false, resizeRightEdge = 0, resizeCorner = false;
  let _dlmT;
  // Memoization caches — keyed by raw input string, populated on first call
  const _normCache = new Map();
  const _dtCache   = new Map();
  let _initialized = false; // guard: don't re-read storage on edge-case re-init
  let panelPopped  = false; // true while the floating pop-out window is open
  let mapsApiKey   = '';    // Google Maps Distance Matrix API key
  let dlmMpg        = 6.5;  // saved MPG (persists across sessions)
  let dlmFuelPrice  = 3.89; // saved fuel price
  let dlmDriverRate = 0;    // saved driver pay $/mi

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
    const m = String(raw).match(/([A-Z]{2})\s*$/);
    return m ? m[1].toLowerCase() : '';
  }

  // Build an index key that normalizes the city name but preserves the state so
  // that "Columbia, MO" and "Columbia, PA" land in separate index buckets.
  // e.g. "S San Frncsco, CA" → "san francisco, ca"
  function normKey(raw) {
    const st   = getState(raw);   // extract state from raw before norm() strips it
    const city = norm(raw);       // normalize city (abbreviations, punctuation, etc.)
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

  // ── Lookup functions ────────────────────────────────────────────────────────
  // Index keys are built by popup.js as normKey(origin)+'|'+normKey(dest),
  // preserving the state so "Columbia, MO" and "Columbia, PA" are separate
  // buckets. The post-filter below is kept as a safety net for edge cases
  // where state data is missing from either DAT or the CSV.
  function findOD(origin, dest) {
    if (!odIndex) return [];
    const no = normKey(origin), nd = normKey(dest);
    if (!no || !nd) return [];
    const recs = odIndex[no + '|' + nd] || [];
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
    return dedup(filtered).slice(0, 15);
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
    const rates = recs.map(r => parseFloat(String(r.rate||''))).filter(r => r > 0);
    return {
      count: recs.length,
      avg:  rates.length ? '$' + Math.round(rates.reduce((a,b)=>a+b,0)/rates.length).toLocaleString() : 'N/A',
      best: rates.length ? '$' + Math.max(...rates).toLocaleString() : 'N/A',
    };
  }

  function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

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

  // ── Send email via Gmail compose URL ──────────────────────────────────────
  function sendEmail(brokerEmail, originRaw, destRaw) {
    const origin  = cleanCity(originRaw);
    const dest    = cleanCity(destRaw);
    const subject = emailSubject
      .replace(/\{origin\}/g, origin)
      .replace(/\{destination\}/g, dest);
    const body    = emailTemplate
      .replace(/\{origin\}/g, origin)
      .replace(/\{destination\}/g, dest)
      .replace(/\{name\}/g, userName)
      .replace(/\{company\}/g, userCompany);

    const acct = senderGmailIndex;
    const url  = `https://mail.google.com/mail/u/${acct}/?view=cm&fs=1` +
                 `&to=${encodeURIComponent(brokerEmail)}` +
                 `&su=${encodeURIComponent(subject)}` +
                 `&body=${encodeURIComponent(body)}`;
    window.open(url, '_blank');
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

  // ── Toast notification ────────────────────────────────────────────────────
  function showToast(msg) {
    const old = document.getElementById('dlm-toast');
    if (old) old.remove();
    const t = document.createElement('div');
    t.id = 'dlm-toast';
    const span = document.createElement('span');
    span.textContent = msg;
    const btn = document.createElement('button');
    btn.title = 'Dismiss'; btn.textContent = '✕';
    btn.addEventListener('click', () => t.remove());
    t.append(span, btn);
    document.body.appendChild(t);
    setTimeout(() => { if (t.parentElement) t.remove(); }, 3000);
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

  // ── Style the broker's email address as a tappable chip ───────────────────
  function injectEmailChip(row) {
    if (row.dataset.dlmChip) return;
    const email = getBrokerEmail(row);
    if (!email) return;
    const { origin, dest } = getCities(row);
    if (!origin || origin.length < 3) return;
    row.dataset.dlmChip = '1';

    const onClick = e => {
      e.stopPropagation(); e.preventDefault();
      sendEmail(email, origin, dest || 'destination');
      showToast(`Email sent to ${email}`);
    };

    // ── Case 1: email is already in a mailto anchor — style it directly ───────
    for (const a of row.querySelectorAll('a[href^="mailto:"]')) {
      if (a.dataset.dlmChip) return;            // element-level guard — prevents
      const href = a.href.replace(/^mailto:/i, '').split('?')[0].trim(); // duplicate
      if (href.toLowerCase() === email.toLowerCase()) { // listeners across scans
        a.dataset.dlmChip = '1';
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
    const oEl = row.querySelector('div[class="origin"], [class*="origin"] .truncate, [class*="origin"]');
    const dEl = row.querySelector('div[class="destination"], [class*="destination"] .truncate, [class*="destination"]');

    let origin = oEl ? oEl.textContent.trim() : '';
    let dest   = dEl ? dEl.textContent.trim() : '';

    // Clean up — remove DH-O numbers that get mixed in
    origin = origin.replace(/^\d+\s*/, '').trim();
    dest   = dest.replace(/^\d+\s*/, '').trim();

    if (origin.length > 3 && dest.length > 3) return { origin, dest };

    // Fallback: regex scan on row text
    const text = row.textContent;
    const CITY_RE = /\b([A-Za-z][A-Za-z\s\.]{1,22}),\s*([A-Z]{2})\b/g;
    const cities = [];
    let m;
    CITY_RE.lastIndex = 0;
    while ((m = CITY_RE.exec(text)) !== null && cities.length < 2) {
      const c = m[1].trim();
      if (c.length >= 2 && !['Van','Full','Partial','Reefer','Flat','Step'].includes(c)) {
        cities.push(`${c}, ${m[2]}`);
      }
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

    const { origin, dest } = getCities(row);
    if (!origin || origin.length < 3) return;

    // Skip rows whose city data hasn't changed since the last scan — this is
    // the main guard against redundant matching on unchanged visible rows.
    if (row.dataset.dlmOrigin === origin && row.dataset.dlmDest === (dest || '')) return;

    // Row is new or DAT reused the element for different data — clear stale state.
    row.classList.remove('dlm-green', 'dlm-yellow', 'dlm-blue', 'dlm-purple');
    const oldBadge = row.querySelector('.dlm-badge');
    if (oldBadge) oldBadge.remove();
    row.querySelectorAll('.dlm-badge-host').forEach(el => el.classList.remove('dlm-badge-host'));
    delete row.dataset.dlmChip; // let injectEmailChip re-run for the new row content

    // Always stamp city data before any early return so getDetailCities works
    // on every row, including unmatched ones (needed for RPM/Maps button).
    row.dataset.dlmOrigin = origin;
    row.dataset.dlmDest   = dest || '';

    const datBroker = getBroker(row);
    const odM = dest ? findOD(origin, dest) : [];
    const oM  = findO(origin);
    const bM  = datBroker ? findBroker(datBroker, origin) : [];

    if (!odM.length && !oM.length && !bM.length) return;

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
  }

  // ── Search ───────────────────────────────────────────────────────────────────
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
        if ((r.origin      || '').toLowerCase().includes(q) ||
            (r.destination || '').toLowerCase().includes(q) ||
            (r.broker      || '').toLowerCase().includes(q)) {
          seen.add(key);
          results.push(r);
        }
      }
    }
    return results.sort((a, b) => parseDate(b.puDate) - parseDate(a.puDate)).slice(0, 50);
  }

  function showSearchResults(query) {
    const results = searchHistory(query);
    const body = document.getElementById('dlm-body');
    if (!results.length) {
      body.innerHTML = `<div style="text-align:center;padding:36px 20px;color:#aeaeb2;font-size:13px;line-height:1.6">No results for<br><strong style="color:#6e6e73;font-weight:600">${esc(query)}</strong></div>`;
      return;
    }
    const st = calcStats(results);
    const cap = results.length >= 50;
    body.innerHTML = `
      <div class="dlm-sum">
        <div style="font-size:10px;color:#aeaeb2;letter-spacing:.05em;text-transform:uppercase;margin-bottom:8px;font-weight:600">Search</div>
        <div class="dlm-lane" style="color:#6e6e73">${esc(query)}</div>
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
      <div id="dlm-search-wrap">
        <span style="color:#4b5563;font-size:13px;flex-shrink:0;line-height:1">⌕</span>
        <input id="dlm-search" type="text" placeholder="Search origin, destination, broker…" autocomplete="off" spellcheck="false">
        <button id="dlm-search-clear" title="Clear search">✕</button>
      </div>
      <div id="dlm-body">
        <div style="text-align:center;padding:36px 20px;color:#aeaeb2;font-size:13px;line-height:1.6;letter-spacing:-.01em">
          Click a highlighted row<br>to see booking history
        </div>
      </div>
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
      if (!q) { document.getElementById('dlm-body').innerHTML = panelBodyHTML; return; }
      searchTimer = setTimeout(() => showSearchResults(q), 150);
    });
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchClear.style.display = 'none';
      document.getElementById('dlm-body').innerHTML = panelBodyHTML;
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

    document.addEventListener('mousemove', e => {
      if (isDragging) {
        d.style.left  = Math.max(0, Math.min(window.innerWidth  - d.offsetWidth,  e.clientX - dragOffX)) + 'px';
        d.style.top   = Math.max(0, Math.min(window.innerHeight - d.offsetHeight, e.clientY - dragOffY)) + 'px';
        d.style.right = 'auto';
      }
      if (isResizing) {
        const newWidth = Math.max(220, Math.min(560, resizeRightEdge - e.clientX));
        d.style.width = newWidth + 'px';
        d.style.left  = (resizeRightEdge - newWidth) + 'px';
        if (resizeCorner) {
          const top = d.getBoundingClientRect().top;
          d.style.maxHeight = Math.max(150, Math.min(window.innerHeight - top - 10, e.clientY - top)) + 'px';
        }
      }
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      if (isResizing) { isResizing = false; resizeCorner = false; d.classList.remove('dlm-resizing'); }
    });

    return d;
  }

  function showPanel(origin, dest, odM, oM, bM, datBroker) {
    // Only persist state when the pop-out window is actually open — avoids a
    // large storage write (full match arrays) on every row click otherwise.
    if (panelPopped) chrome.storage.local.set({ panelState: { origin, dest, odM, oM, bM, datBroker } });

    if (!panel) panel = buildPanel();
    if (!panelPopped) panel.style.display = 'flex';

    const titleEl = panel.querySelector('#dlm-title');
    if (titleEl) {
      const laneShort = dest
        ? `${origin.split(',')[0].trim()} → ${dest.split(',')[0].trim()}`
        : origin.split(',')[0].trim();
      titleEl.innerHTML = `◈ ${esc(laneShort)}<small> · drag</small>`;
    }
    const pri = odM.length ? odM : oM.length ? oM : bM;
    const st = calcStats(pri);
    const arrow = dest ? `<span style="color:#aeaeb2;margin:0 5px;font-weight:300">→</span>${esc(dest)}` : '';

    let html = `
      <div class="dlm-sum">
        <div style="font-size:10px;color:#aeaeb2;letter-spacing:.05em;text-transform:uppercase;margin-bottom:8px;font-weight:600">Current Load</div>
        <div class="dlm-lane">${esc(origin)}${arrow}</div>
        <div class="dlm-stats">
          <div><div class="dlm-sv">${st.count}</div><div class="dlm-sl">Bookings</div></div>
          <div><div class="dlm-sv">${st.avg}</div><div class="dlm-sl">Avg Rate</div></div>
          <div><div class="dlm-sv">${st.best}</div><div class="dlm-sl">Best Rate</div></div>
        </div>
      </div>`;

    if (odM.length) {
      // skipAnim=true: all records use animation-delay:0 so none are hidden during a
      // stagger delay. The .dlm-rec CSS animation still runs (opacity 0→1) but fires
      // immediately for every record, so the panel is never empty on first open.
      html += `<div class="dlm-stitle">Exact Lane Matches · ${odM.length}</div>` +
              renderRecs(odM, '#34c759', 20, true, true);
    }

    // Purple: same lane + same broker
    if (odM.length && bM.length && datBroker) {
      const brokerLane = bM.filter(r => odM.find(o => o.loadNum === r.loadNum));
      if (brokerLane.length) html += `<div class="dlm-stitle" style="color:#af52de">Same Broker — ${esc(datBroker)}</div>`;
    }

    // Blue: same origin city only
    if (!odM.length && oM.length) {
      console.log('[LaneIQ] oM records[0]:', JSON.stringify(oM[0]));
      console.log('[LaneIQ] oM records[1]:', JSON.stringify(oM[1]));
      console.log('[LaneIQ] oM records[2]:', JSON.stringify(oM[2]));
      html += `<div class="dlm-stitle">Same Origin · ${oM.length} loads</div>` + renderRecs(oM, '#007aff', 20, true, true);
    } else if (odM.length && oM.length) {
      const originOnly = oM.filter(r => !odM.find(o => o.loadNum === r.loadNum));
      if (originOnly.length) html += `<div class="dlm-stitle">Other Loads from This Origin · ${originOnly.length}</div>` + renderRecs(originOnly, '#007aff', 20, true, true);
    }

    panelBodyHTML = html;
    const searchEl = panel.querySelector('#dlm-search');
    if (searchEl && searchEl.value) {
      searchEl.value = '';
      const clearEl = panel.querySelector('#dlm-search-clear');
      if (clearEl) clearEl.style.display = 'none';
    }

    // Always replace content immediately — no conditional branching that could
    // leave the panel empty, and no setTimeout delay before content is visible.
    const bodyEl = document.getElementById('dlm-body');
    bodyEl.innerHTML = html;
    bodyEl.scrollTop = 0;
  }

  function renderRecs(list, color, limit = 20, skipAnim = false, skipFilter = false) {
    // skipFilter = true for exact lane matches — never hide a confirmed match
    // regardless of whether it has a rate/pickup/commodity filled in.
    const filtered = skipFilter ? list : list.filter(r => {
      const rate = String(r.rate||'').trim();
      return (rate && rate !== 'nan') ||
             (r.pickupCompany   && r.pickupCompany   !== 'nan' && r.pickupCompany.trim())   ||
             (r.deliveryCompany && r.deliveryCompany !== 'nan' && r.deliveryCompany.trim()) ||
             (r.commodity       && r.commodity       !== 'nan' && r.commodity.trim());
    });
    return filtered.slice(0, limit).map((r, i) => {
      const rate = String(r.rate||'').trim();
      const rateNum = parseFloat(rate);
      const rd   = rate && rate !== 'nan' && !isNaN(rateNum)
                     ? '$' + rateNum.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
                     : (rate && rate !== 'nan' ? rate : 'N/A'); // fall back to raw string if not a clean number
      const ln   = String(r.loadNum||'').replace(/\n.*/,'').trim() || '—';
      const dt   = String(r.puDate||'').split('T')[0].substring(0, 10);
      const broker = String(r.broker||'').trim();
      const gUrl = ln !== '—' ? gmailUrl(ln) : null;
      const gmailBtn = gUrl ? `<a href="${gUrl}" target="_blank" class="dlm-gmail-btn">📧 Gmail</a>` : '';

      const pickupAddr   = parseCompanyAddress(r.pickupCompany   || '');
      const deliveryAddr = parseCompanyAddress(r.deliveryCompany || '');
      const commodity = String(r.commodity || '').trim();

      const addrHtml = (addr) =>
        addr ? `${esc(addr.company)}${addr.street ? `<br><span style="font-size:10px;color:#8e8e93;font-weight:400">${esc(addr.street)}</span>` : ''}` : '';

      return `
        <div class="dlm-rec" style="border-left-color:${color};animation-delay:${skipAnim ? 0 : i*.04}s">
          <div class="dlm-rh">
            <div style="display:flex;flex-direction:column;gap:2px;max-width:165px">
              <span class="dlm-ln">#${esc(ln)}</span>
              ${broker && broker !== 'nan' ? `<span style="font-size:11px;color:#6e6e73;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(broker)}</span>` : ''}
            </div>
            <div style="display:flex;align-items:center;gap:5px">${gmailBtn}<span class="dlm-dt">${esc(dt)}</span></div>
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

  // ── Scan ────────────────────────────────────────────────────────────────────
  function scan() {
    if (!odIndex && !oIndex) return;
    // processRow skips rows whose origin/dest hasn't changed, so no bulk
    // class-removal pass is needed — stale state is cleared per-row on demand.
    document.querySelectorAll('[class*="row-container"], [class*="row-cells"]').forEach(r => {
      processRow(r);
      injectEmailChip(r);
    });
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  async function init() {
    if (_initialized) return; // indexes already in memory — nothing to do

    const s = await chrome.storage.local.get(['odIndex','oIndex','brokerIndex','laneCount','gmailIndex','senderEmail','senderGmailIndex','emailSubject','emailTemplate','userName','userCompany','panelPopped','mapsApiKey','dlmMpg','dlmFuelPrice','dlmDriverRate']);
    if (!s.laneCount) return;

    odIndex     = s.odIndex     || {};
    oIndex      = s.oIndex      || {};
    brokerIndex = s.brokerIndex || {};
    const _sampleRecs = Object.values(oIndex).flat().slice(0, 3);
    console.log('[LaneIQ] Index sample records (raw stored shape):');
    _sampleRecs.forEach((r, i) => console.log(`  [${i}]`, JSON.stringify(r)));
    gmailIndex       = s.gmailIndex    || 0;
    senderEmail      = s.senderEmail   || '';
    senderGmailIndex = typeof s.senderGmailIndex !== 'undefined' ? s.senderGmailIndex : 0;
    userName         = s.userName      || '';
    userCompany      = s.userCompany   || '';
    emailSubject     = s.emailSubject  || 'Load Inquiry – {origin} → {destination}';
    emailTemplate    = s.emailTemplate || `Hi,

My name is {name} with {company}. I'm reaching out about your load from {origin} to {destination} posted on DAT today.

Can you share the rate, pickup window, and any special requirements?

Thanks,
{name}
{company}`;

    panelPopped    = s.panelPopped    || false;
    mapsApiKey     = s.mapsApiKey     || '';
    dlmMpg         = +s.dlmMpg         || 6.5;
    dlmFuelPrice   = +s.dlmFuelPrice   || 3.89;
    dlmDriverRate  = +s.dlmDriverRate  || 0;
    _initialized = true;

    // Re-show the side panel when the pop-out window is closed
    chrome.storage.onChanged.addListener((changes) => {
      if ('panelPopped' in changes) {
        panelPopped = changes.panelPopped.newValue || false;
        if (!panelPopped && panel && panelBodyHTML) panel.style.display = 'flex';
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
            console.log('[LaneIQ] findDATInput ✓ via "Origin" label → input:', {
              id: input.id, name: input.name, placeholder: input.placeholder,
              class: input.className.slice(0, 80), value: input.value,
            });
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
          console.log(`[LaneIQ] findDATInput ✓ via "${sel}":`, {
            id: el.id, name: el.name, placeholder: el.placeholder,
            class: el.className.slice(0, 80), value: el.value,
          });
          return el;
        }
      }

      console.warn('[LaneIQ] findDATInput: no match found. All inputs on page:',
        [...document.querySelectorAll('input')].map(i => ({
          id: i.id, name: i.name, placeholder: i.placeholder,
          ariaLabel: i.getAttribute('aria-label'), value: i.value,
          class: i.className.slice(0, 80),
        }))
      );
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
          console.log('[LaneIQ] DH From overridden by DAT search box →', v);
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

      console.log('[LaneIQ] DH From watching →',
        datInput.placeholder || datInput.getAttribute('aria-label') || datInput.id || '(unlabelled)');
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
    console.log('[LaneIQ] DH From: DAT origin input not found yet — observing…');

    // Return cleanup so the caller can stop the observer when the modal closes
    return () => { if (obs) { obs.disconnect(); obs = null; } };
  }

  // ── VIEW ROUTE interceptor ───────────────────────────────────────────────────
  function setupRouteInterceptor() {
    function tryIntercept(el) {
      if (el.dataset.dlmRouteOk) return;
      if (!/view\s*route/i.test(el.textContent.replace(/\s+/g,' ').trim())) return;
      el.dataset.dlmRouteOk = '1';

      // Force gradient via inline style — inline !important beats any stylesheet,
      // including DAT's own !important class rules on the same element.
      el.style.setProperty('background', 'linear-gradient(180deg,#72d4ff 0%,#0a84ff 45%,#0060df 46%,#004fc4 100%)', 'important');
      el.style.setProperty('box-shadow', 'inset 0 1px 0 rgba(255,255,255,.5),0 4px 10px rgba(0,80,200,.4)', 'important');

      // Replace DAT's button content with our styled version
      el.innerHTML =
        `<svg class="dlm-route-icon" viewBox="0 0 16 16" width="12" height="12"
              fill="currentColor" aria-hidden="true">
           <path d="M8 1C5.24 1 3 3.24 3 6c0 3.9 5 9 5 9s5-5.1 5-9c0-2.76-2.24-5-5-5z
                    m0 7c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/>
         </svg>RPM / Maps`;

      el.addEventListener('mousedown', () => { el.style.display = 'none'; }, true);
      el.addEventListener('click', e => {
        e.stopPropagation();
        e.preventDefault();
        const { origin, dest } = getDetailCities(el);
        const rate = getDetailRate(el);
        showRouteModal(origin, dest, rate, () => { el.style.display = ''; });
      }, true);
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
      for (const node of _pendingExpand) {
        if (!node.isConnected || node.closest('[id^="dlm-"]')) continue;
        if (node.dataset.dlmExpandSeen) continue;

        // Walk back through siblings and ancestor-siblings to find the highlighted
        // row (stamped with data-dlm-origin by processRow) that owns this detail panel.
        let row = null;

        // Strategy 1: direct previous siblings of the inserted node
        let sib = node.previousElementSibling;
        while (sib && !row) {
          if (sib.dataset.dlmOrigin) row = sib;
          else { const r = sib.querySelector?.('[data-dlm-origin]'); if (r) row = r; }
          sib = sib.previousElementSibling;
        }

        // Strategy 2: previous siblings of parent / grandparent (handles wrapper divs)
        if (!row) {
          let ancestor = node.parentElement;
          for (let depth = 0; depth < 3 && ancestor && !row; depth++) {
            sib = ancestor.previousElementSibling;
            while (sib && !row) {
              if (sib.dataset.dlmOrigin) row = sib;
              else { const r = sib.querySelector?.('[data-dlm-origin]'); if (r) row = r; }
              sib = sib.previousElementSibling;
            }
            ancestor = ancestor.parentElement;
          }
        }

        if (!row) continue;
        node.dataset.dlmExpandSeen = '1';

        const o = row.dataset.dlmOrigin;
        const d = row.dataset.dlmDest   || '';
        const b = row.dataset.dlmBroker || '';
        if (o) showPanel(o, d, d ? findOD(o, d) : [], findO(o), b ? findBroker(b, o) : [], b);
      }
      _pendingExpand.clear();
    }

    let _rt;
    new MutationObserver(mutations => {
      for (const { addedNodes } of mutations) {
        for (const node of addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.closest?.('[id^="dlm-"]')) continue; // skip our own injected elements

          // Email detection (existing)
          if (EMAIL_SNIFF.test(node.textContent || '')) _pendingEmail.add(node);

          // Queue for expansion detection if the node is directly after a highlighted
          // row, or has class names suggesting it is a DAT detail/drawer panel.
          const cls = (node.className || '').toLowerCase();
          if (cls.includes('detail') || cls.includes('drawer') || cls.includes('expand') ||
              node.previousElementSibling?.dataset?.dlmOrigin) {
            _pendingExpand.add(node);
          }
        }
      }
      // Expansion detection fires at 80 ms — fast enough to feel immediate,
      // slow enough to let DAT finish its own render pass first.
      clearTimeout(_expandTimer);
      _expandTimer = setTimeout(flushExpand, 80);
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
      const { origin, dest } = getDetailCities(parent);
      const onClick = e => {
        e.stopPropagation(); e.preventDefault();
        sendEmail(email, origin, dest || 'destination');
        showToast(`Email sent to ${email}`);
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
        const re = /\b([A-Za-z][A-Za-z\s\.]{1,22}),\s*([A-Z]{2})\b/g;
        const cities = [];
        let m;
        while ((m = re.exec(scope.innerText)) !== null && cities.length < 3) {
          const c = m[1].trim();
          if (c.length >= 2 && !SKIP.test(c)) cities.push(`${c}, ${m[2]}`);
        }
        if (cities.length >= 2)
          return { origin: cleanCity(cities[0]), dest: cleanCity(cities[1]) };
      }
    }

    return { origin: '', dest: '' };
  }

  function getDetailRate(fromEl) {
    // Walk up to the stamped row element, then query only DAT's own rate
    // elements — never LaneIQ's injected DOM (dlm- prefixed classes).
    //
    // Skip elements inside DAT iQ / market-rate / estimate containers — those
    // show projected prices (Spot, Contract, Avg), not the broker's posted rate.
    const SKIP_CONTAINER =
      '[class*="iq"],[class*="Iq"],[class*="IQ"],' +
      '[class*="market"],[class*="Market"],' +
      '[class*="estimate"],[class*="Estimate"],' +
      '[class*="spot"],[class*="Spot"],' +
      '[class*="contract"],[class*="Contract"],' +
      '[class*="suggest"],[class*="Suggest"],' +
      '[class*="average"],[class*="Average"]';

    let node = fromEl;
    while (node && node !== document.body) {
      if (node.dataset.dlmOrigin) {
        const candidates = Array.from(
          node.querySelectorAll(
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
          // Require text to START with "$" — this rejects DAT iQ labels like
          // "Spot $2,150" or "Est $1,800" where the dollar sign is not first.
          const m = text.match(/^\$\s*([\d,]+(?:\.\d{1,2})?)/);
          if (m) {
            const v = parseFloat(m[1].replace(/,/g, ''));
            if (v > 0) return v;
          }
        }
        return 0; // no broker-posted rate found — leave field blank
      }
      node = node.parentElement;
    }
    return 0;
  }

  // ── Route modal ──────────────────────────────────────────────────────────────
  function showRouteModal(origin, dest, rate, onClose = null) {
    document.getElementById('dlm-route-modal')?.remove();

    const wrap = document.createElement('div');
    wrap.id = 'dlm-route-modal';

    // ── Header ────────────────────────────────────────────────────────────────
    const hdr = document.createElement('div');
    hdr.className = 'dlm-modal-overlay';

    const box = document.createElement('div');
    box.className = 'dlm-modal';
    box.setAttribute('role', 'dialog');

    const mhdr = document.createElement('div');
    mhdr.className = 'dlm-modal-hdr';
    mhdr.innerHTML = `
      <div class="dlm-modal-hdr-title">
        ${esc(origin || '—')}<span>→</span>${esc(dest || '—')}
      </div>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'dlm-modal-close';
    closeBtn.title = 'Close (Esc)';
    closeBtn.textContent = '✕';
    mhdr.appendChild(closeBtn);

    // ── Body ──────────────────────────────────────────────────────────────────
    const mbody = document.createElement('div');
    mbody.className = 'dlm-modal-body';

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
          mapContainer.innerHTML = `<span style="font-size:13px;color:#8e8e93">Map unavailable: ${mainResp?.error || 'no response'}</span>`;
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
    box.append(mhdr, mbody);
    wrap.append(hdr, box);
    document.body.appendChild(wrap);

    // ── Live calculator ────────────────────────────────────────────────────────
    function q(attr) { return box.querySelector(`[data-dlm="${attr}"]`); }

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

    // ── DH From: manual typing → debounced fetch (independent of Rate logic) ────
    let _dhDebounce = null;
    let stopOriginWatch = () => {};          // no-op until getDATOriginValue runs
    const dhFromEl = q('dh-from');
    if (dhFromEl) {
      // Manual edits to the DH From field
      dhFromEl.addEventListener('change', fetchDHRoute);
      dhFromEl.addEventListener('input', () => {
        clearTimeout(_dhDebounce);
        _dhDebounce = setTimeout(fetchDHRoute, 800);
      });

      // ── getDATOriginValue: watch DAT's Origin search box and auto-fill DH From ──
      // Called every time the modal opens. Runs independently of the Rate field.
      // Disconnects its MutationObserver the moment the input is found.
      // Will override the pre-fill above if/when a real DAT input becomes readable.
      stopOriginWatch = getDATOriginValue(dhFromEl, () => fetchDHRoute());
    }

    // ── Close handlers ─────────────────────────────────────────────────────────
    const doClose = () => { wrap.remove(); stopOriginWatch(); if (onClose) onClose(); };
    closeBtn.addEventListener('click', doClose);
    hdr.addEventListener('click', doClose);           // click outside box closes
    box.addEventListener('click', e => e.stopPropagation()); // prevent close on box click
    const onKey = e => { if (e.key === 'Escape') { doClose(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);

    calc();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();

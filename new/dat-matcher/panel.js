(function () {
  'use strict';

  let gmailIndex  = 0;
  let odIndex     = null, oIndex = null, brokerIndex = null;
  let panelBodyHTML = '';
  let pendingState  = null; // state queued while the window is minimized
  let _activeTab  = 'history';
  let lovedLoads  = {};   // loadKey → { record, savedAt }
  let _recPool    = {};   // loadKey → record, for heart click lookup

  // ── Utilities (mirrored from content.js) ─────────────────────────────────
  function esc(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function norm(raw) {
    if (!raw) return '';
    return String(raw).toLowerCase()
      .replace(/\bmt\b/g,'mount').replace(/\bmtn\b/g,'mountain').replace(/\bft\b/g,'fort')
      .replace(/\bpt\b/g,'point').replace(/\blk\b/g,'lake').replace(/\bcyn\b/g,'canyon')
      .replace(/\bvly\b/g,'valley').replace(/\bbch\b/g,'beach').replace(/\bhls\b/g,'hills')
      .replace(/\bhts\b/g,'heights').replace(/\bhgts\b/g,'heights')
      .replace(/\bspgs\b/g,'springs').replace(/\bspg\b/g,'spring')
      .replace(/\bvlg\b/g,'village').replace(/\bjct\b/g,'junction')
      .replace(/\bst\.?\b/g,'saint').replace(/\bfrncsco\b/g,'francisco')
      .replace(/\b(ca|fl|tx|pa|nv|ga|nc|va|ct|mi|in|oh|mo|co|az|or|ut|wa|mn|ne|ks|sc|al|ms|la|ar|ky|tn|wv|md|nj|ny|ma|ri|nh|vt|me|de|nm|id|mt|wy|sd|nd|ok|ia|il|ak|hi|dc|wi)\b/g,'')
      .replace(/\d+/g,'').replace(/[^a-z\s]/g,' ').replace(/\s+/g,' ').trim()
      .replace(/^[nsew] /,'');
  }

  function getState(raw) {
    const m = String(raw).match(/([A-Z]{2})\s*$/);
    return m ? m[1].toLowerCase() : '';
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
      .replace(/logistics|transport|brokerage|freight|group|inc|llc|corp|co/gi,'')
      .replace(/[^a-z\s]/g,' ').replace(/\s+/g,' ').trim();
  }

  function parseDate(raw) {
    if (!raw) return 0;
    const s = String(raw).trim();
    let m;
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);           if (m) return new Date(+m[1],+m[2]-1,+m[3]).getTime();
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);     if (m) return new Date(+m[3],+m[1]-1,+m[2]).getTime();
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\b/);   if (m) return new Date(2000+(+m[3]),+m[1]-1,+m[2]).getTime();
    m = s.match(/([A-Za-z]{3,9})\s+(\d{1,2})[,\s]+(\d{4})/);
    if (m) { const d = new Date(m[1]+' '+m[2]+' '+m[3]); if (!isNaN(d)) return d.getTime(); }
    m = s.match(/^(\d{1,2})\/(\d{1,2})\b/);            if (m) return new Date(new Date().getFullYear(),+m[1]-1,+m[2]).getTime();
    const d = new Date(s); return isNaN(d) ? 0 : d.getTime();
  }

  function dedup(recs) {
    const seen = new Set();
    return recs
      .filter(r => {
        const k = r.loadNum || (r.origin+'|'+(r.destination||'')+'|'+r.puDate);
        if (seen.has(k)) return false; seen.add(k); return true;
      })
      .sort((a, b) => parseDate(b.puDate) - parseDate(a.puDate));
  }

  function calcStats(recs) {
    const rates = recs.map(r => parseFloat(String(r.rate).replace(/[^0-9.]/g,''))).filter(r => r > 0);
    return {
      count: recs.length,
      avg:  rates.length ? '$'+Math.round(rates.reduce((a,b)=>a+b,0)/rates.length).toLocaleString() : 'N/A',
      best: rates.length ? '$'+Math.max(...rates).toLocaleString() : 'N/A',
    };
  }

  function cleanStreet(s) {
    if (!s) return '';
    const ci = s.lastIndexOf(',');
    if (ci > 0) s = s.slice(0, ci).trim();
    s = s.replace(/\.\s+[A-Za-z][A-Za-z\s]*$/, '.').trim();
    return s;
  }

  function parseCompanyAddress(raw) {
    if (!raw || raw === 'nan') return null;
    let s = raw.trim();
    s = s.replace(/\s+\d{5}(-\d{4})?\s*$/, '').trim();
    s = s.replace(/,?\s+[A-Z]{2}\s*$/, '').trim();
    const lastComma = s.lastIndexOf(',');
    if (lastComma > 0) {
      const tail = s.slice(lastComma+1).trim();
      if (/^[A-Za-z][A-Za-z\s]*$/.test(tail) && tail.length < 35)
        s = s.slice(0, lastComma).trim();
    }
    let m = s.match(/^([^,]+),\s*(\d+.*)$/);
    if (m) return { company: m[1].trim(), street: cleanStreet(m[2]) };
    m = s.match(/^(.+?)\s+(\d+\s+\S.*)$/);
    if (m) return { company: m[1].replace(/,+$/,'').trim(), street: cleanStreet(m[2]) };
    return { company: s.replace(/,+$/,'').trim(), street: '' };
  }

  function showLovedSearchResults(q) {
    const bodyEl = document.getElementById('dlm-body');
    if (!bodyEl) return;
    const lq = q.toLowerCase();
    const filtered = Object.values(lovedLoads)
      .map(e => e.record)
      .filter(r =>
        (r.origin      || '').toLowerCase().includes(lq) ||
        (r.destination || '').toLowerCase().includes(lq) ||
        (r.broker      || '').toLowerCase().includes(lq) ||
        String(r.loadNum || '').toLowerCase().includes(lq)
      );
    if (!filtered.length) {
      bodyEl.innerHTML = `<div class="dlm-placeholder">No preferred loads match<br><strong style="color:#6e6e73;font-weight:600">${esc(q)}</strong></div>`;
      return;
    }
    bodyEl.innerHTML =
      '<div class="dlm-stitle" style="margin:12px 4px 6px">Matching Preferred · ' + filtered.length + '</div>' +
      renderRecs(filtered, '#e05c5c', 999, true, new Set(Object.keys(lovedLoads)));
  }

  function loveKey(r) {
    return String(r.loadNum || '').trim() || [r.origin || '', r.destination || '', r.puDate || ''].join('|');
  }

  function switchTab(name) {
    _activeTab = name;
    document.querySelectorAll('.dlm-tab').forEach(t =>
      t.classList.toggle('dlm-tab-active', t.dataset.tab === name)
    );
    const searchWrap = document.getElementById('dlm-search-wrap');
    const bodyEl     = document.getElementById('dlm-body');
    if (!bodyEl) return;

    if (name === 'history') {
      if (searchWrap) searchWrap.style.display = '';
      const searchEl = document.getElementById('dlm-search');
      if (searchEl) searchEl.placeholder = 'Search origin, destination, broker…';
      bodyEl.innerHTML = panelBodyHTML ||
        '<div class="dlm-placeholder">Click a highlighted row on DAT<br>to see booking history here</div>';
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
          '<div class="dlm-stitle" style="margin:6px 4px 6px">Preferred Loads · ' + recs.length + '</div>' +
          renderRecs(recs, '#e05c5c', 999, true, new Set(Object.keys(lovedLoads)))
        : '<div class="dlm-placeholder">Tap ♡ on any load<br>to mark it as preferred</div>';
      bodyEl.scrollTop = 0;
    } else if (name === 'regions') {
      if (searchWrap) searchWrap.style.display = 'none';
      bodyEl.innerHTML = `
        <a href="https://iq.dat.com/market-conditions/conditions/REEFER~KMA~PREV_BUSINESS_DAY~OUT~~~0"
           target="_blank"
           style="display:flex;align-items:center;justify-content:center;gap:6px;margin:12px;padding:10px 14px;background:#0058e0;color:#fff;border-radius:10px;font-size:12px;font-weight:700;text-decoration:none;letter-spacing:.01em;box-shadow:0 2px 8px rgba(0,88,224,.28)"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="flex-shrink:0">
            <path d="M2 12L6 8l3 3 5-6" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          View DAT Market Conditions
        </a>
        <div class="dlm-placeholder" style="padding-top:12px;font-size:12px;color:#c7c7cc">
          Live origin counts are available<br>in the inline panel on DAT
        </div>`;
      bodyEl.scrollTop = 0;
    }
  }

  function gmailUrl(loadNum) {
    const q = String(loadNum||'').replace(/[^a-zA-Z0-9]/g,'').trim();
    if (!q) return null;
    return `https://mail.google.com/mail/u/${gmailIndex}/#search/${encodeURIComponent(q)}`;
  }

  function addrHtml(addr) {
    if (!addr) return '';
    return esc(addr.company) +
      (addr.street ? `<br><span style="font-size:10px;color:#8e8e93;font-weight:400">${esc(addr.street)}</span>` : '');
  }

  function renderRecs(list, color, limit = 20, skipFilter = false, lovedKeys = new Set()) {
    const filtered = skipFilter ? list : list.filter(r => {
      const rate = String(r.rate||'').trim();
      return (rate && rate !== 'nan') ||
             (r.pickupCompany   && r.pickupCompany   !== 'nan' && r.pickupCompany.trim())   ||
             (r.deliveryCompany && r.deliveryCompany !== 'nan' && r.deliveryCompany.trim()) ||
             (r.commodity       && r.commodity       !== 'nan' && r.commodity.trim());
    });
    return filtered.slice(0, limit).map((r, i) => {
      const key  = loveKey(r);
      _recPool[key] = r;
      const loved = lovedKeys.has(key);

      const rate   = String(r.rate||'').trim();
      const rd     = rate.startsWith('$') ? rate : (rate ? '$'+rate : '');
      const ln     = String(r.loadNum||'').replace(/\n.*/,'').trim() || '—';
      const dt     = String(r.puDate||'').split('T')[0].substring(0, 10);
      const broker = String(r.broker||'').trim();
      const gUrl   = ln !== '—' ? gmailUrl(ln) : null;
      const gmailBtn  = gUrl ? `<a href="${gUrl}" target="_blank" class="dlm-gmail-btn">📧 Gmail</a>` : '';
      const heartBtn  = `<button class="dlm-heart-btn${loved ? ' dlm-loved' : ''}" data-load-key="${esc(key)}" title="${loved ? 'Remove from Preferred' : 'Save to Preferred'}">♥</button>`;
      const pickupAddr   = parseCompanyAddress(r.pickupCompany   || '');
      const deliveryAddr = parseCompanyAddress(r.deliveryCompany || '');
      const commodity    = String(r.commodity || '').trim();
      return `
        <div class="dlm-rec" style="border-left-color:${color};animation-delay:${i*.04}s">
          <div class="dlm-rh">
            <div style="display:flex;flex-direction:column;gap:2px;max-width:165px">
              <span class="dlm-ln">#${esc(ln)}</span>
              ${broker && broker !== 'nan' ? `<span style="font-size:11px;color:#6e6e73;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(broker)}</span>` : ''}
            </div>
            <div style="display:flex;align-items:center;gap:5px">${gmailBtn}${heartBtn}<span class="dlm-dt">${esc(dt)}</span></div>
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

  // ── Render panel content from saved state ─────────────────────────────────
  function showContent(state, flash = false) {
    if (!state) return;
    // Activate history tab visually without replacing body (showContent handles that)
    _activeTab = 'history';
    document.querySelectorAll('.dlm-tab').forEach(t =>
      t.classList.toggle('dlm-tab-active', t.dataset.tab === 'history')
    );
    const searchWrap = document.getElementById('dlm-search-wrap');
    if (searchWrap) searchWrap.style.display = '';

    if (state.mode === 'api') {
      const titleEl = document.getElementById('dlm-title');
      const bodyEl  = document.getElementById('dlm-body');
      if (titleEl) titleEl.innerHTML = `◈ ${esc(state.origin.split(',')[0].trim())}${state.dest ? ` <span style="color:#aeaeb2;margin:0 5px;font-weight:300">→</span>${esc(state.dest.split(',')[0].trim())}` : ''}`;
      bodyEl.innerHTML = state.renderedHTML;
      panelBodyHTML = state.renderedHTML;
      bodyEl.scrollTop = 0;
      if (flash) { bodyEl.classList.remove('dlm-refreshed'); void bodyEl.offsetWidth; bodyEl.classList.add('dlm-refreshed'); }
      return;
    }
    const { origin, dest, odM = [], oM = [], bM = [], datBroker } = state;

    const titleEl = document.getElementById('dlm-title');
    if (titleEl) {
      const laneShort = dest
        ? `${origin.split(',')[0].trim()} → ${dest.split(',')[0].trim()}`
        : origin.split(',')[0].trim();
      titleEl.innerHTML = `◈ ${esc(laneShort)}`;
    }

    const pri = odM.length ? odM : oM.length ? oM : bM;
    const st  = calcStats(pri);
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

    const lk = new Set(Object.keys(lovedLoads));
    if (odM.length) {
      html += `<div class="dlm-stitle">Exact Lane Matches · ${odM.length}</div>` +
              renderRecs(odM, '#34c759', 20, true /* skipFilter */, lk);
    }

    if (!odM.length && oM.length) {
      html += `<div class="dlm-stitle">Same Origin · ${oM.length} loads</div>` + renderRecs(oM, '#007aff', 20, false, lk);
    } else if (odM.length && oM.length) {
      const originOnly = oM.filter(r => !odM.find(o => o.loadNum === r.loadNum));
      if (originOnly.length)
        html += `<div class="dlm-stitle">Other Loads from This Origin · ${originOnly.length}</div>` + renderRecs(originOnly, '#007aff', 20, false, lk);
    }

    panelBodyHTML = html;
    const bodyEl = document.getElementById('dlm-body');
    bodyEl.innerHTML = html;
    bodyEl.scrollTop = 0;

    if (flash) {
      bodyEl.classList.remove('dlm-refreshed');
      void bodyEl.offsetWidth; // force reflow to restart animation
      bodyEl.classList.add('dlm-refreshed');
    }
  }

  // ── Search ────────────────────────────────────────────────────────────────
  function searchHistory(query) {
    if (!oIndex) return [];
    const q = query.toLowerCase().trim();
    if (q.length < 2) return [];
    const seen = new Set(), results = [];
    for (const recs of Object.values(oIndex)) {
      for (const r of recs) {
        const key = r.loadNum || (r.origin + r.puDate);
        if (seen.has(key)) continue;
        if ((r.origin      ||'').toLowerCase().includes(q) ||
            (r.destination ||'').toLowerCase().includes(q) ||
            (r.broker      ||'').toLowerCase().includes(q)) {
          seen.add(key); results.push(r);
        }
      }
    }
    return results.sort((a,b) => parseDate(b.puDate)-parseDate(a.puDate)).slice(0, 50);
  }

  function showSearchResults(query) {
    const results = searchHistory(query);
    const bodyEl  = document.getElementById('dlm-body');
    if (!results.length) {
      bodyEl.innerHTML = `<div style="text-align:center;padding:36px 20px;color:#aeaeb2;font-size:13px;line-height:1.6">No results for<br><strong style="color:#6e6e73;font-weight:600">${esc(query)}</strong></div>`;
      return;
    }
    const st  = calcStats(results);
    const cap = results.length >= 50;
    bodyEl.innerHTML = `
      <div class="dlm-sum">
        <div style="font-size:10px;color:#aeaeb2;letter-spacing:.05em;text-transform:uppercase;margin-bottom:8px;font-weight:600">Search</div>
        <div class="dlm-lane" style="color:#6e6e73">${esc(query)}</div>
        <div class="dlm-stats">
          <div><div class="dlm-sv">${cap?'50+':results.length}</div><div class="dlm-sl">Results</div></div>
          <div><div class="dlm-sv">${st.avg}</div><div class="dlm-sl">Avg Rate</div></div>
          <div><div class="dlm-sv">${st.best}</div><div class="dlm-sl">Best Rate</div></div>
        </div>
      </div>
      <div class="dlm-stitle">Matching Loads${cap?' · Top 50':''}</div>
      ${renderRecs(results, '#c7c7cc', 50)}`;
  }

  // ── DOM wiring ────────────────────────────────────────────────────────────
  document.getElementById('dlm-close').addEventListener('click', () => {
    chrome.storage.local.set({ panelPopped: false });
    window.close();
  });

  // When the floating window closes (any method), re-show the side panel in DAT
  window.addEventListener('unload', () => {
    chrome.storage.local.set({ panelPopped: false });
  });

  // ── Search wiring ─────────────────────────────────────────────────────────
  const searchInput = document.getElementById('dlm-search');
  const searchClear = document.getElementById('dlm-search-clear');
  let searchTimer   = null;

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

  // ── Init ──────────────────────────────────────────────────────────────────
  async function init() {
    const s = await chrome.storage.local.get([
      'panelState','gmailIndex','odIndex','oIndex','brokerIndex','lovedLoads'
    ]);
    gmailIndex  = s.gmailIndex  || 0;
    odIndex     = s.odIndex     || {};
    oIndex      = s.oIndex      || {};
    brokerIndex = s.brokerIndex || {};
    lovedLoads  = s.lovedLoads  || {};

    if (s.panelState) {
      showContent(s.panelState);
    } else {
      document.getElementById('dlm-body').innerHTML =
        `<div style="text-align:center;padding:36px 20px;color:#aeaeb2;font-size:13px;line-height:1.6">
          Click a highlighted row on DAT<br>to see booking history here
        </div>`;
    }

    // Tab clicks
    document.querySelectorAll('.dlm-tab').forEach(btn =>
      btn.addEventListener('click', () => switchTab(btn.dataset.tab))
    );

    // Heart (Loved) delegation on body
    document.getElementById('dlm-body').addEventListener('click', e => {
      const btn = e.target.closest('.dlm-heart-btn');
      if (!btn) return;
      e.stopPropagation();
      const key = btn.dataset.loadKey;
      if (!key) return;
      if (lovedLoads[key]) {
        delete lovedLoads[key];
        btn.classList.remove('dlm-loved');
        btn.title = 'Save to Preferred';
      } else {
        const rec = _recPool[key];
        if (rec) lovedLoads[key] = { record: rec, savedAt: Date.now() };
        btn.classList.add('dlm-loved');
        btn.title = 'Remove from Preferred';
      }
      chrome.storage.local.set({ lovedLoads });
      if (_activeTab === 'loved') switchTab('loved');
    });

    // Live-update: whenever the user clicks a new DAT row, refresh this window.
    // Check the real window state via the Chrome API — document.hidden is not
    // reliable for minimized popup windows. If minimized, queue silently.
    chrome.storage.onChanged.addListener(async (changes) => {
      if (changes.lovedLoads) lovedLoads = changes.lovedLoads.newValue || {};
      if (!changes.panelState || searchInput.value.trim()) return;
      const newState = changes.panelState.newValue;
      const win = await chrome.windows.getCurrent();
      if (win.state === 'minimized') {
        pendingState = newState; // store silently; don't touch the DOM
      } else {
        showContent(newState, true);
      }
    });

    // window.focus fires when the user restores the window from minimized —
    // more reliable than visibilitychange for popup windows.
    window.addEventListener('focus', () => {
      if (pendingState) {
        showContent(pendingState, false); // no flash — user is just restoring
        pendingState = null;
      }
    });
  }

  init();
})();

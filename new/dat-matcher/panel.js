(function () {
  'use strict';

  let gmailIndex  = 0;
  let odIndex     = null, oIndex = null, brokerIndex = null;
  let panelBodyHTML = '';
  let pendingState  = null; // state queued while the window is minimized
  let _activeTab          = 'history';
  let lovedLoads          = {};
  let _recPool            = {};
  let emailTemplates      = [];
  let activeTemplateIndex = 0;
  let signature           = '';
  let senderGmailIndex    = 0;
  let gmailOAuthEmail     = '';
  let outlookOAuthEmail   = '';
  let useCSV              = true;
  let useDB               = false;
  let licenseTier         = 'solo';
  let gmailEmail          = '';
  let filesMeta           = [];

  // ── CSV index helpers for file remove (panel.js — no upload, remove only) ───
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
                           font-family:inherit;letter-spacing:.01em">
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
      : '<div style="font-size:12px;color:#aeaeb2;padding:8px 0">No CSV files loaded. Upload CSVs in the LaneIQ popup or inline panel.</div>';
    bodyEl.innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:8px;background:#f0f7ff;border:1px solid #cce0ff;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:11.5px;color:#3a3a3a;line-height:1.45;">
        <span style="font-size:14px;margin-top:1px;">🔒</span>
        <span>Your load data stays in your browser. Only <strong>YOU</strong> can see it or manage it.</span>
      </div>
      <div style="${CARD}">
        <div style="${LABEL}">Data Source</div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div><div style="font-size:13px;font-weight:500;color:#1d1d1f">My CSV</div><div style="font-size:11px;color:#aeaeb2">Your own freight history</div></div>
          <label style="position:relative;width:44px;height:24px;cursor:pointer;flex-shrink:0">
            <input id="dlm-setup-csv-toggle" type="checkbox" ${useCSV ? 'checked' : ''} style="opacity:0;width:0;height:0;position:absolute">
            <span style="position:absolute;inset:0;background:${useCSV ? '#34c759' : '#c7c7cc'};border-radius:34px;transition:background .2s">
              <span style="position:absolute;width:18px;height:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:transform .2s;transform:${useCSV ? 'translateX(20px)' : 'none'};box-shadow:0 1px 3px rgba(0,0,0,.25)"></span>
            </span>
          </label>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div><div style="font-size:13px;font-weight:500;color:#1d1d1f">LaneIQ Database ${licenseTier !== 'pro' ? '<span style="font-size:10px;color:#ff9500">🔒 Pro</span>' : ''}</div><div style="font-size:11px;color:#aeaeb2">Market-wide rate data</div></div>
          <label style="position:relative;width:44px;height:24px;cursor:${licenseTier==='pro'?'pointer':'default'};flex-shrink:0;opacity:${licenseTier==='pro'?'1':'.5'}">
            <input id="dlm-setup-db-toggle" type="checkbox" ${useDB ? 'checked' : ''} ${licenseTier!=='pro'?'disabled':''} style="opacity:0;width:0;height:0;position:absolute">
            <span style="position:absolute;inset:0;background:${useDB ? '#34c759' : '#c7c7cc'};border-radius:34px;transition:background .2s">
              <span style="position:absolute;width:18px;height:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:transform .2s;transform:${useDB ? 'translateX(20px)' : 'none'};box-shadow:0 1px 3px rgba(0,0,0,.25)"></span>
            </span>
          </label>
        </div>
        <div id="dlm-setup-ds-status" style="font-size:11px;color:#aeaeb2;margin-top:8px">
          ${useCSV && useDB ? 'Both sources active' : useCSV ? 'My CSV active' : useDB ? 'LaneIQ Database active' : 'No data source selected'}
        </div>
      </div>
      <div style="${CARD}">
        <div style="${LABEL}">Freight History CSV</div>
        <div id="dlm-setup-file-list">${fileListHTML}</div>
        <div style="font-size:11px;color:#aeaeb2;margin-top:8px;padding:8px;background:rgba(0,0,0,.03);border-radius:8px;text-align:center">
          To upload CSV files, open the LaneIQ popup or use the inline panel on DAT
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
                     background:${n===gmailIndex?'#0058e0':'rgba(0,0,0,.05)'};color:${n===gmailIndex?'#fff':'#6e6e73'}">${n}</button>`).join('')}
        </div>
        <div style="font-size:10px;color:#aeaeb2;line-height:1.5;margin-bottom:6px">Open your freight Gmail → check URL: mail.google.com/mail/<strong>u/1</strong>/</div>
        <div id="dlm-setup-gmail-status" style="font-size:11px;font-weight:500;color:${gmailEmail?'#34c759':'#aeaeb2'}">
          ${gmailEmail ? `✓ ${esc(gmailEmail)} · Account #${gmailIndex}` : 'Not configured yet'}
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
    // Wire toggles
    const csvT = bodyEl.querySelector('#dlm-setup-csv-toggle');
    const dbT  = bodyEl.querySelector('#dlm-setup-db-toggle');
    if (csvT) csvT.addEventListener('change', async () => { useCSV = csvT.checked; await chrome.storage.local.set({ useCSV }); renderSetupBody(bodyEl); });
    if (dbT)  dbT.addEventListener('change',  async () => {
      if (licenseTier !== 'pro') { dbT.checked = false; const st = bodyEl.querySelector('#dlm-setup-ds-status'); if (st) { st.textContent = '🔒 Pro feature'; st.style.color = '#ff9500'; } return; }
      useDB = dbT.checked; await chrome.storage.local.set({ useDB }); renderSetupBody(bodyEl);
    });
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
    refreshNoteBadges(bodyEl);
  }

  function loveKey(r) {
    return String(r.loadNum || '').trim() || [r.origin || '', r.destination || '', r.puDate || ''].join('|');
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

  function openNotePopover(badge) {
    document.querySelector('.dlm-note-popover')?.remove();
    const noteKey = badge.dataset.noteKey;
    const root = document.getElementById('dlm-wrap');
    if (!root) return;
    const popover = document.createElement('div');
    popover.className = 'dlm-note-popover';
    popover.innerHTML =
      '<div class="dlm-note-hdr">' +
        '<span class="dlm-note-title">NOTE</span>' +
        '<button class="dlm-note-close">✕</button>' +
      '</div>' +
      '<textarea class="dlm-note-ta" placeholder="Add your note…"></textarea>' +
      '<div class="dlm-note-saved" style="display:none">Saved</div>';
    root.appendChild(popover);
    const br = badge.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    popover.style.top  = Math.max(0, br.top - rr.top - 8) + 'px';
    popover.style.left = Math.max(0, br.left - rr.left - 218) + 'px';
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
    const root = document.getElementById('dlm-wrap');
    if (!root) return;
    const toast = document.createElement('div');
    toast.className = 'dlm-undo-toast';
    toast.innerHTML = 'Load removed — <button class="dlm-undo-btn">Undo</button>';
    root.appendChild(toast);
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

  function switchTab(name) {
    _activeTab = name;
    document.querySelectorAll('.dlm-tab').forEach(t =>
      t.classList.toggle('dlm-tab-active', t.dataset.tab === name)
    );
    const _tabLabels = { history: 'Load History', loved: 'Preferred', regions: 'Hot Regions', templates: 'Templates', setup: 'Setup', notes: 'Notes' };
    const titleEl = document.getElementById('dlm-title');
    if (titleEl) titleEl.innerHTML = '◈ ' + (_tabLabels[name] || name);
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
    } else if (name === 'notes') {
      if (searchWrap) searchWrap.style.display = 'none';
      bodyEl.style.padding = '0';
      bodyEl.style.background = '#fef3c7';
      bodyEl.style.overflow = 'hidden';
      bodyEl.style.display = 'flex';
      bodyEl.style.flexDirection = 'column';
      const panelEl = document.getElementById('dlm-wrap');
      const panelHeight = panelEl ? panelEl.offsetHeight : 600;
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
        ta.addEventListener('input', () => {
          clearTimeout(_notesTimer);
          _notesTimer = setTimeout(() => {
            chrome.storage.local.set({ 'dlm-global-notes': ta.value }, () => {
              savedEl.style.display = 'block';
              setTimeout(() => { savedEl.style.display = 'none'; }, 1500);
            });
          }, 300);
        });
      });
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

  function renderRecs(list, color, limit = 20, skipFilter = false, lovedKeys = new Set(), datBroker = '') {
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

      const rate   = String(r.rate||'').trim();
      const rd     = rate.startsWith('$') ? rate : (rate ? '$'+rate : '');
      const ln     = String(r.loadNum||'').replace(/\n.*/,'').trim() || '—';
      const dt     = String(r.puDate||'').split('T')[0].substring(0, 10);
      const broker = String(r.broker||'').trim();
      const gUrl   = ln !== '—' ? gmailUrl(ln) : null;
      const gmailBtn  = gUrl ? `<a href="${gUrl}" target="_blank" class="dlm-gmail-btn">📧 Gmail</a>` : '';
      const heartBtn  = `<button class="dlm-heart-btn${loved ? ' dlm-loved' : ''}" data-load-key="${esc(key)}" title="${loved ? 'Remove from Preferred' : 'Save to Preferred'}">♥</button>`;
      const noteBadgeBtn = loved ? `<button class="dlm-note-badge" data-note-key="note_${esc(key)}" data-load-key="${esc(key)}" title="Add note"><svg width="9" height="9" viewBox="0 0 14 14" fill="none" style="flex-shrink:0;margin-bottom:1px"><path d="M9.5 2L12 4.5L4.5 12H2V9.5L9.5 2Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Note</button>` : '';
      const pickupAddr   = parseCompanyAddress(r.pickupCompany   || '');
      const deliveryAddr = parseCompanyAddress(r.deliveryCompany || '');
      const commodity    = String(r.commodity || '').trim();
      const isBrokerMatch = normDatB && r.broker && normBroker(r.broker).includes(normDatB);
      const cardColor = isBrokerMatch ? '#9b59b6' : color;
      return `
        <div class="dlm-rec" style="border-left-color:${cardColor};animation-delay:${i*.04}s">
          <div class="dlm-rh">
            <div style="display:flex;flex-direction:column;gap:2px;max-width:165px">
              <span class="dlm-ln">#${esc(ln)}</span>
              ${broker && broker !== 'nan' ? `<span style="font-size:11px;color:#6e6e73;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(broker)}</span>` : ''}
            </div>
            <div style="display:flex;align-items:center;gap:5px">${gmailBtn}${noteBadgeBtn}${heartBtn}<span class="dlm-dt">${esc(dt)}</span></div>
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
      const bodyEl  = document.getElementById('dlm-body');
      if (state.renderedHTML) {
        bodyEl.innerHTML = state.renderedHTML;
        panelBodyHTML = state.renderedHTML;
      } else {
        bodyEl.innerHTML = '<div class="dlm-placeholder">Click a highlighted row on DAT<br>to see booking history here</div>';
      }
      bodyEl.scrollTop = 0;
      if (flash) { bodyEl.classList.remove('dlm-refreshed'); void bodyEl.offsetWidth; bodyEl.classList.add('dlm-refreshed'); }
      return;
    }
    const { origin, dest, odM = [], oM = [], bM = [], datBroker } = state;

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
              renderRecs(odM, odM.length >= 3 ? '#34c759' : '#f5a623', 20, true /* skipFilter */, lk, datBroker);
    }

    if (!odM.length && oM.length) {
      html += `<div class="dlm-stitle">Same Origin · ${oM.length} loads</div>` + renderRecs(oM, '#007aff', 20, false, lk, datBroker);
    } else if (odM.length && oM.length) {
      const originOnly = oM.filter(r => !odM.find(o => o.loadNum === r.loadNum));
      if (originOnly.length)
        html += `<div class="dlm-stitle">Other Loads from This Origin · ${originOnly.length}</div>` + renderRecs(originOnly, '#007aff', 20, false, lk, datBroker);
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
      'panelState','gmailIndex','gmailEmail','gmailOAuthEmail','outlookOAuthEmail','odIndex','oIndex','brokerIndex','lovedLoads','emailTemplates','activeTemplate','signature','senderGmailIndex','useCSV','useDB','licenseTier','filesMeta'
    ]);
    gmailIndex          = s.gmailIndex  || 0;
    odIndex             = s.odIndex     || {};
    oIndex              = s.oIndex      || {};
    brokerIndex         = s.brokerIndex || {};
    lovedLoads          = s.lovedLoads  || {};
    emailTemplates      = s.emailTemplates || DEFAULT_TEMPLATES.map(t => ({...t}));
    activeTemplateIndex = s.activeTemplate ?? 0;
    // Migrate old template names if user has the previous defaults saved
    const nameMap = { 'Template 1': 'Standard', 'Template 2': 'Follow Up', 'Template 3': 'Custom' };
    let migrated = false;
    emailTemplates.forEach(t => { if (nameMap[t.name]) { t.name = nameMap[t.name]; migrated = true; } });
    if (migrated) chrome.storage.local.set({ emailTemplates });
    signature           = s.signature        || '';
    gmailOAuthEmail     = s.gmailOAuthEmail   || '';
    outlookOAuthEmail   = s.outlookOAuthEmail || '';
    senderGmailIndex    = s.senderGmailIndex ?? 0;
    useCSV              = s.useCSV           !== false;
    useDB               = s.useDB            ?? true;
    licenseTier         = s.licenseTier      || 'solo';
    gmailEmail          = s.gmailEmail       || '';
    filesMeta           = s.filesMeta        || [];

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
        const savedEntry = lovedLoads[key];
        delete lovedLoads[key];
        btn.classList.remove('dlm-loved');
        btn.title = 'Save to Preferred';
        chrome.storage.local.set({ lovedLoads });
        if (_activeTab === 'loved') switchTab('loved');
        showUndoToast(key, savedEntry);
      } else {
        const rec = _recPool[key];
        if (rec) lovedLoads[key] = { record: rec, savedAt: Date.now() };
        btn.classList.add('dlm-loved');
        btn.title = 'Remove from Preferred';
        chrome.storage.local.set({ lovedLoads });
        if (_activeTab === 'loved') switchTab('loved');
      }
    });

    // Note badge delegation
    document.getElementById('dlm-body').addEventListener('click', e => {
      const badge = e.target.closest('.dlm-note-badge');
      if (!badge) return;
      e.stopPropagation();
      openNotePopover(badge);
    });

    // Live-update: whenever the user clicks a new DAT row, refresh this window.
    // Check the real window state via the Chrome API — document.hidden is not
    // reliable for minimized popup windows. If minimized, queue silently.
    // Template click delegation (Use This) and blur (auto-save)
    document.getElementById('dlm-body').addEventListener('click', async e => {
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
        const bodyEl = document.getElementById('dlm-body');
        chrome.runtime.sendMessage({ type: 'gmailConnect' }, (res) => {
          if (res?.ok && res.email) {
            gmailOAuthEmail = res.email;
            chrome.storage.local.set({ gmailOAuthEmail: res.email });
            renderTemplatesBody(bodyEl);
          } else {
            console.warn('[LaneIQ] Gmail connect failed:', res?.error);
          }
        });
        return;
      }
      if (e.target.classList.contains('dlm-gmail-disconnect')) {
        const bodyEl = document.getElementById('dlm-body');
        chrome.runtime.sendMessage({ type: 'gmailDisconnect' }, (res) => {
          if (res?.ok) {
            gmailOAuthEmail = '';
            chrome.storage.local.remove(['gmailOAuthEmail']);
            renderTemplatesBody(bodyEl);
          }
        });
        return;
      }
      if (e.target.classList.contains('dlm-outlook-connect')) {
        const bodyEl = document.getElementById('dlm-body');
        chrome.runtime.sendMessage({ type: 'outlookConnect' }, (res) => {
          if (res?.ok && res.email) {
            outlookOAuthEmail = res.email;
            chrome.storage.local.set({ outlookOAuthEmail: res.email });
            renderTemplatesBody(bodyEl);
          } else {
            console.warn('[LaneIQ] Outlook connect failed:', res?.error);
          }
        });
        return;
      }
      if (e.target.classList.contains('dlm-outlook-disconnect')) {
        const bodyEl = document.getElementById('dlm-body');
        chrome.runtime.sendMessage({ type: 'outlookDisconnect' }, (res) => {
          if (res?.ok) {
            outlookOAuthEmail = '';
            chrome.storage.local.remove(['outlookOAuthEmail']);
            renderTemplatesBody(bodyEl);
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
        await chrome.storage.local.set({ filesMeta: newMeta, odIndex: odI, oIndex: oI, brokerIndex: bI, laneCount: count });
        filesMeta = newMeta;
        if (_activeTab === 'setup') renderSetupBody(e.currentTarget);
        return;
      }
      if (e.target.closest('.dlm-setup-gmail-save')) {
        const raw = document.getElementById('dlm-setup-gmail-input')?.value.trim() || '';
        const urlMatch = raw.match(/mail\.google\.com\/mail\/u\/(\d+)/);
        if (urlMatch) { gmailIndex = parseInt(urlMatch[1]); gmailEmail = `Account #${gmailIndex}`; }
        else if (raw && raw.includes('@')) { gmailEmail = raw; }
        await chrome.storage.local.set({ gmailEmail, gmailIndex });
        if (_activeTab === 'setup') renderSetupBody(e.currentTarget);
        return;
      }
      if (e.target.closest('.dlm-setup-acct-btn')) {
        const acctBtn = e.target.closest('.dlm-setup-acct-btn');
        gmailIndex = parseInt(acctBtn.dataset.gmailIdx, 10);
        await chrome.storage.local.set({ gmailIndex });
        document.querySelectorAll('.dlm-setup-acct-btn').forEach(b => {
          const a = parseInt(b.dataset.gmailIdx) === gmailIndex;
          b.style.background = a ? '#007aff' : 'rgba(0,0,0,.05)';
          b.style.color      = a ? '#fff'    : '#6e6e73';
        });
        return;
      }
      const saveBtn = e.target.closest('.dlm-tpl-save');
      if (saveBtn) {
        const idx = parseInt(saveBtn.dataset.tplIndex, 10);
        const card = saveBtn.closest('.dlm-tpl-card');
        const subjectArea = card?.querySelector('.dlm-tpl-subject');
        const bodyArea = card?.querySelector('.dlm-tpl-body');
        const tmpls = emailTemplates.length ? emailTemplates : DEFAULT_TEMPLATES.map(t => ({...t}));
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

    document.getElementById('dlm-body').addEventListener('blur', e => {
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

    chrome.storage.onChanged.addListener(async (changes) => {
      if (changes.lovedLoads)     lovedLoads          = changes.lovedLoads.newValue     || {};
      if (changes.emailTemplates) emailTemplates      = changes.emailTemplates.newValue || DEFAULT_TEMPLATES.map(t => ({...t}));
      if (changes.activeTemplate) activeTemplateIndex = changes.activeTemplate.newValue ?? 0;
      if (changes.signature)        signature        = changes.signature.newValue        || '';
      if (changes.gmailOAuthEmail)  gmailOAuthEmail  = changes.gmailOAuthEmail.newValue  || '';
      if (changes.outlookOAuthEmail) outlookOAuthEmail = changes.outlookOAuthEmail.newValue || '';
      if (changes.senderGmailIndex) senderGmailIndex = changes.senderGmailIndex.newValue ?? 0;
      if (changes.useCSV)           useCSV           = changes.useCSV.newValue            !== false;
      if (changes.useDB)            useDB            = changes.useDB.newValue             ?? true;
      if (changes.licenseTier)      licenseTier      = changes.licenseTier.newValue       || 'solo';
      if (changes.gmailEmail)       gmailEmail       = changes.gmailEmail.newValue        || '';
      if (changes.gmailIndex)       gmailIndex       = changes.gmailIndex.newValue        ?? 0;
      if (changes.filesMeta)        filesMeta        = changes.filesMeta.newValue         || [];
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

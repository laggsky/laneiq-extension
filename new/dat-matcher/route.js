// route.js — the floating RPM/map route window. Mirrors the inline modal's
// multi-lane TABS: renders one STATIC map (cached Maps proxy) + INTERACTIVE RPM
// calculator per lane, kept live-synced via chrome.storage.local 'routeState'.
//
// Source of truth: content.js's inline tabs[] is authoritative for the lane SET.
// This window is a CONSUMER — it reconciles its rendered tabs to each routeState
// push (keyed by stable pane id) and NEVER writes routeState. The only route→content
// signal is the one-shot 'routeCommand' channel (floating × → close a lane). Calculator
// edits + tab-switching are purely LOCAL to this window (not synced back, by design).
//
// routeState shape (v=2):
//   { v:2, tabs:[{ id, origin, dest, rate, miles, dhFrom, dhMiles, mpg, fuel,
//                  driverRpm, tolls, mainPolyline, dhPolyline, dhCity, mapUrl,
//                  mapMsg, statDist, statDur, statDhDist, statDhDur }, ...≤5],
//     activeId, newId, rev }
// A legacy v1 single-lane object is migrated to one tab (id:'legacy').
(function () {
  'use strict';

  const PROXY = 'https://laneiq-backend-production.up.railway.app';

  let mapsApiKey    = '';
  let dlmMpg        = 6.5;
  let dlmFuelPrice  = 3.89;
  let dlmDriverRate = 0;
  let dlmDriverPercent = 0;          // driver pay as % of the posted rate
  let dlmDriverPayMode = 'permile';  // 'permile' | 'percent' — which driver-pay formula calc() uses

  const titleEl  = document.getElementById('route-title');
  const tabStrip = document.getElementById('route-tabs');
  const paneHost = document.getElementById('route-panes');
  const emptyEl  = document.getElementById('route-empty');

  // ── Tab controller state ───────────────────────────────────────────────────
  const tabs = [];           // pane controllers, insertion order (mirrors content, ≤5)
  let activeIdx = -1;
  let _initialized = false;  // first render done? (focus activeId once)
  let _cmdSeq = 0;           // local counter → unique routeCommand nonces

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Static-map framing widener (DUPLICATED VERBATIM from content.js) ────────
  // Decodes the route polyline (plain varint decode — NOT projection math) to get
  // its lat/lng bounding box, then returns a Google Static Maps "&visible=" rect
  // padded ~35% on every side (min 0.3°). Google keeps the route centered and draws
  // the accurate line; the wider viewport gives surrounding cities/states to zoom
  // out into. One fetch per lane — this only reshapes the cached image's framing.
  function dlmDecodePolyline(str) {
    let index = 0, lat = 0, lng = 0; const out = [];
    while (index < str.length) {
      let b, shift = 0, result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      out.push([lat / 1e5, lng / 1e5]);
    }
    return out;
  }
  function dlmVisiblePad(polylines) {
    let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity, n = 0;
    for (const p of polylines) {
      if (!p) continue;
      for (const pt of dlmDecodePolyline(p)) {
        if (pt[0] < minLat) minLat = pt[0]; if (pt[0] > maxLat) maxLat = pt[0];
        if (pt[1] < minLng) minLng = pt[1]; if (pt[1] > maxLng) maxLng = pt[1];
        n++;
      }
    }
    if (!n) return '';
    // Pad fraction scales inversely with route span (max of lat/lng deltas):
    // ~30% for short lanes (span <= 3°) tapering linearly to ~6% for long
    // cross-country routes (span >= 25°), clamped to [6%, 30%]. Long routes thus
    // fill the frame instead of shrinking to a tiny line. Absolute min 0.15°.
    const span = Math.max(maxLat - minLat, maxLng - minLng);
    let frac = 0.30 + (span - 3) * ((0.06 - 0.30) / (25 - 3));
    frac = Math.max(0.06, Math.min(0.30, frac));
    const pad = Math.max(span * frac, 0.15);
    const sw = (minLat - pad).toFixed(5) + ',' + (minLng - pad).toFixed(5);
    const ne = (maxLat + pad).toFixed(5) + ',' + (maxLng + pad).toFixed(5);
    return '&visible=' + sw + '|' + ne;
  }

  // ── Static map (byte-identical URL to content.js renderMap) ────────────────
  function buildMapUrl(main, origin, dest, dh, dhCity) {
    // size=640x400 is Google's max framed size (it clamps the size param at 640);
    // scale=2 returns a 1280x800 landscape PNG — the practical max resolution.
    let url = PROXY + '/maps/staticmap' +
      '?size=640x400&scale=2' +
      `&path=color:0x007affff|weight:5|enc:${encodeURIComponent(main)}`;
    if (dh && dhCity) {
      url += `&path=color:0x8e8e93cc|weight:3|enc:${encodeURIComponent(dh)}`;
      url += `&markers=color:gray|label:T|${encodeURIComponent(dhCity)}`;
      url += `&markers=color:blue|label:A|${encodeURIComponent(origin)}`;
      url += `&markers=color:green|label:B|${encodeURIComponent(dest)}`;
    } else {
      url += `&markers=color:blue|label:A|${encodeURIComponent(origin)}`;
      url += `&markers=color:green|label:B|${encodeURIComponent(dest)}`;
    }
    // Widen the auto-framed viewport ~35% on all sides (route stays centered).
    url += dlmVisiblePad(dh && dhCity ? [main, dh] : [main]);
    return url;
  }

  // ── Calculator markup for one pane (values injected from state + defaults) ──
  function calcHtml(state) {
    const mpgVal    = state.mpg       !== '' && state.mpg       != null ? state.mpg       : dlmMpg;
    const fuelVal   = state.fuel      !== '' && state.fuel      != null ? state.fuel      : dlmFuelPrice;
    const driverVal = state.driverRpm !== '' && state.driverRpm != null ? state.driverRpm : (dlmDriverRate || '');
    return `
      <div class="dlm-calc-hdr">RPM Calculator</div>
      <div class="dlm-calc-body">
        <div class="dlm-cf">
          <span class="dlm-cf-label">Rate</span>
          <div class="dlm-cf-row">
            <span class="dlm-cf-pre">$</span>
            <input class="dlm-cf-input" data-dlm="rate" type="number" min="0"
                   value="${esc(state.rate || '')}" placeholder="0">
          </div>
        </div>
        <div class="dlm-cf">
          <span class="dlm-cf-label">Miles</span>
          <div class="dlm-cf-row">
            <input class="dlm-cf-input" data-dlm="miles" type="number" min="0"
                   value="${esc(state.miles || '')}" placeholder="loading…">
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
                   value="${esc(state.dhFrom || '')}" placeholder="City, ST" style="text-align:left">
          </div>
        </div>
        <div class="dlm-cf">
          <span class="dlm-cf-label">DH Miles</span>
          <div class="dlm-cf-row">
            <input class="dlm-cf-input" data-dlm="dh" type="number" min="0"
                   value="${esc(state.dhMiles || '')}" placeholder="—">
            <span class="dlm-cf-suf">mi</span>
          </div>
        </div>
        <div class="dlm-cf-sep"></div>
        <div class="dlm-cf">
          <span class="dlm-cf-label">MPG</span>
          <div class="dlm-cf-row">
            <input class="dlm-cf-input" data-dlm="mpg" type="number" min="1" step="0.1"
                   value="${esc(mpgVal)}">
          </div>
        </div>
        <div class="dlm-cf">
          <span class="dlm-cf-label">Fuel</span>
          <div class="dlm-cf-row">
            <span class="dlm-cf-pre">$</span>
            <input class="dlm-cf-input" data-dlm="fuel" type="number" min="0" step="0.01"
                   value="${esc(fuelVal)}">
            <span class="dlm-cf-suf">/gal</span>
          </div>
        </div>
        <div class="dlm-cf dlm-cf-computed">
          <span class="dlm-cf-label">Fuel Cost</span>
          <span class="dlm-cf-val" data-dlm="fuelcost">—</span>
        </div>
        <div class="dlm-cf-sep"></div>
        <div class="dlm-cf">
          <span class="dlm-cf-label" style="display:flex;flex-direction:column;gap:3px;align-items:flex-start">
            <span data-dlm="driver-label">Driver $/mi</span>
            <span class="dlm-driver-toggle" data-dlm="driver-toggle" data-dtg="permile">
              <button type="button" data-dlm="driver-tg-permile" class="dlm-dtg-on">$/mi</button>
              <button type="button" data-dlm="driver-tg-percent">%</button>
            </span>
          </span>
          <div class="dlm-cf-row">
            <span class="dlm-cf-pre" data-dlm="driver-pre">$</span>
            <input class="dlm-cf-input" data-dlm="driver-rpm" type="number" min="0" step="0.01"
                   value="${esc(driverVal)}" placeholder="0.00">
            <span class="dlm-cf-suf" data-dlm="driver-suf" style="display:none">%</span>
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
            <input class="dlm-cf-input" data-dlm="tolls" type="number" min="0" step="1"
                   value="${esc(state.tolls || '')}" placeholder="0">
          </div>
        </div>
        <div class="dlm-cf dlm-cf-computed" style="margin-top:4px">
          <span class="dlm-cf-label">Profit</span>
          <span class="dlm-cf-profit-val" data-dlm="profit">—</span>
        </div>
      </div>`;
  }

  function statsHtml(state) {
    return `
      <span style="font-size:11px;color:#aeaeb2;font-weight:500">Loaded</span>
      <span class="dlm-map-stat" data-dlm="stat-dist">${esc(state.statDist || '—')}</span>
      <span class="dlm-map-stat-sep">·</span>
      <span class="dlm-map-stat" data-dlm="stat-dur">${esc(state.statDur || '')}</span>
      <span class="dlm-map-stat-sep" style="margin-left:8px">|</span>
      <span style="font-size:11px;color:#aeaeb2;font-weight:500;margin-left:8px">DH</span>
      <span class="dlm-map-stat" data-dlm="stat-dh-dist">${esc(state.statDhDist || '—')}</span>
      <span class="dlm-map-stat-sep">·</span>
      <span class="dlm-map-stat" data-dlm="stat-dh-dur">${esc(state.statDhDur || '')}</span>`;
  }

  // ── Per-lane pane factory (mirrors content.js buildPane; NO DAT origin-watcher,
  //    NO drag/resize — the OS window handles those) ───────────────────────────
  function buildFloatPane(state) {
    const id = state.id;
    let mainPolyline = state.mainPolyline || null;
    let dhPolyline   = state.dhPolyline   || null;
    let dhCity       = state.dhCity       || '';
    let mapMsg       = state.mapMsg       || '';
    const origin = state.origin || '';
    const dest   = state.dest   || '';
    const label  = `${origin || '—'} → ${dest || '—'}`;
    let _dhDebounce = null;
    // True once the user types their OWN DH here → reconcile() must stop applying
    // carried DH from content (preserve manual input). Programmatic value-sets
    // (build/reconcile) do NOT fire input/change, so they never trip this.
    let _dhUserEdited = false;

    const mbody = document.createElement('div');
    mbody.className = 'dlm-modal-body';
    mbody.style.display = 'none';

    const left = document.createElement('div');
    left.className = 'dlm-modal-left';
    const mapEl = document.createElement('div');
    mapEl.className = 'dlm-map-frame';
    mapEl.style.cssText = 'display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;background:#f5f5f7;';
    const statsEl = document.createElement('div');
    statsEl.className = 'dlm-map-stats';
    statsEl.innerHTML = statsHtml(state);
    left.append(mapEl, statsEl);

    const right = document.createElement('div');
    right.className = 'dlm-modal-right';
    right.innerHTML = calcHtml(state);

    mbody.append(left, right);

    // q() scoped to THIS pane — multiple panes share data-dlm attrs.
    const q = (attr) => mbody.querySelector(`[data-dlm="${attr}"]`);

    function drawMap() {
      mapEl.innerHTML = '';
      if (mainPolyline) {
        const img = document.createElement('img');
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
        img.alt = 'Route map';
        img.src = buildMapUrl(mainPolyline, origin, dest, dhPolyline, dhCity);
        mapEl.appendChild(img);
        // Zoom/pan the already-loaded static image (no per-zoom network requests).
        if (window.attachMapZoomPan) window.attachMapZoomPan(mapEl, img);
      } else {
        mapEl.innerHTML = `<span style="font-size:13px;color:#8e8e93;text-align:center;padding:24px">${esc(mapMsg || 'Loading map…')}</span>`;
      }
    }

    // Driver pay mode: '$/mi' (totalMiles × rate) OR '%' (posted rate × pct).
    let driverMode = (dlmDriverPayMode === 'percent') ? 'percent' : 'permile';

    function calc() {
      if (!q('rpm')) return;
      const rateV       = parseFloat(q('rate')?.value)       || 0;
      const miles       = parseFloat(q('miles')?.value)      || 0;
      const mpg         = parseFloat(q('mpg')?.value)        || 0;
      const fuel        = parseFloat(q('fuel')?.value)       || 0;
      const dhMiles     = parseFloat(q('dh')?.value)         || 0;
      const driverInput = parseFloat(q('driver-rpm')?.value) || 0;
      const tolls       = parseFloat(q('tolls')?.value)      || 0;

      const totalMiles = miles + dhMiles;
      const rpm        = (rateV && miles) ? rateV / miles                        : null;
      const fuelCost   = (totalMiles && mpg && fuel) ? (totalMiles / mpg) * fuel : null;
      // '%' → posted rate × (pct/100) (NOT incl. deadhead); '$/mi' → (miles+DH) × rate.
      const driverCost = driverMode === 'percent'
        ? (rateV && driverInput ? rateV * (driverInput / 100) : 0)
        : (totalMiles && driverInput ? totalMiles * driverInput : 0);
      const profit     = rateV ? rateV - (fuelCost || 0) - tolls - driverCost    : null;

      q('rpm').textContent        = rpm        ? `$${rpm.toFixed(2)}/mi`                       : '—';
      q('fuelcost').textContent   = fuelCost   ? `$${Math.round(fuelCost).toLocaleString()}`   : '—';
      q('drivercost').textContent = driverCost ? `$${Math.round(driverCost).toLocaleString()}` : '—';

      const pEl = q('profit');
      pEl.textContent = profit != null ? `$${Math.round(profit).toLocaleString()}` : '—';
      pEl.style.color = profit == null ? '#1d1d1f' : profit >= 0 ? '#34c759' : '#ff3b30';

      // Persist user-entered values globally (content.js picks these up). Driver
      // value persists to its OWN key per mode so switching never loses the other.
      if (mpg       && mpg       !== dlmMpg)        { dlmMpg        = mpg;       chrome.storage.local.set({ dlmMpg: mpg }); }
      if (fuel      && fuel      !== dlmFuelPrice)   { dlmFuelPrice  = fuel;      chrome.storage.local.set({ dlmFuelPrice: fuel }); }
      if (driverMode === 'percent') {
        if (driverInput && driverInput !== dlmDriverPercent) { dlmDriverPercent = driverInput; chrome.storage.local.set({ dlmDriverPercent: driverInput }); }
      } else {
        if (driverInput && driverInput !== dlmDriverRate)    { dlmDriverRate    = driverInput; chrome.storage.local.set({ dlmDriverRate: driverInput }); }
      }
    }

    // Apply a driver-pay mode to the UI: label, $ prefix vs % suffix, active
    // toggle button, and the input value (each mode keeps its own stored value).
    // keepCurrent: on the initial paint, preserve the per-lane $/mi value
    // calcHtml already baked into the input (don't clobber it with the global).
    function applyDriverMode(mode, keepCurrent) {
      driverMode = (mode === 'percent') ? 'percent' : 'permile';
      const lbl = q('driver-label'), pre = q('driver-pre'), suf = q('driver-suf'), inp = q('driver-rpm');
      const tgPm = q('driver-tg-permile'), tgPc = q('driver-tg-percent');
      if (driverMode === 'percent') {
        if (lbl) lbl.textContent = 'Driver %';
        if (pre) pre.style.display = 'none';
        if (suf) suf.style.display = '';
        if (inp) { inp.step = '0.5'; inp.value = dlmDriverPercent > 0 ? dlmDriverPercent : ''; }
      } else {
        if (lbl) lbl.textContent = 'Driver $/mi';
        if (pre) pre.style.display = '';
        if (suf) suf.style.display = 'none';
        if (inp) { inp.step = '0.01'; if (!keepCurrent) inp.value = dlmDriverRate > 0 ? dlmDriverRate : ''; }
      }
      if (tgPm) tgPm.classList.toggle('dlm-dtg-on', driverMode === 'permile');
      if (tgPc) tgPc.classList.toggle('dlm-dtg-on', driverMode === 'percent');
      q('driver-toggle')?.setAttribute('data-dtg', driverMode);   // slide the thumb
      calc();
    }
    function setDriverMode(mode) {
      applyDriverMode(mode);
      dlmDriverPayMode = driverMode;
      chrome.storage.local.set({ dlmDriverPayMode: driverMode });
    }

    // DH From → fetch DH miles + redraw map (manual; getRoute proxy). Local only.
    function fetchDHRoute() {
      const dhCityV  = q('dh-from')?.value?.trim();
      const dhDistEl = q('stat-dh-dist');
      const dhDurEl  = q('stat-dh-dur');
      const dhEl     = q('dh');

      if (!dhCityV || dhCityV.length < 3) {
        if (dhDistEl) dhDistEl.textContent = '—';
        if (dhDurEl)  dhDurEl.textContent  = '';
        if (dhEl)     { dhEl.value = ''; calc(); }
        dhPolyline = null; dhCity = '';
        drawMap();
        return;
      }
      if (dhDistEl) dhDistEl.textContent = '…';
      chrome.runtime.sendMessage(
        { type: 'getRoute', origin: dhCityV, dest: origin, apiKey: mapsApiKey }
      ).then(resp => {
        if (!resp || resp.error) { if (dhDistEl) dhDistEl.textContent = '—'; return; }
        if (dhEl) { dhEl.value = resp.miles; calc(); }
        if (dhDistEl) dhDistEl.textContent = `${resp.miles} mi`;
        if (dhDurEl)  dhDurEl.textContent  = resp.duration;
        dhPolyline = resp.polyline; dhCity = dhCityV;
        drawMap();
      }).catch(() => { if (dhDistEl) dhDistEl.textContent = '—'; });
    }

    drawMap();
    ['rate', 'miles', 'mpg', 'fuel', 'dh', 'driver-rpm', 'tolls']
      .forEach(k => q(k)?.addEventListener('input', calc));
    q('driver-tg-permile')?.addEventListener('click', () => setDriverMode('permile'));
    q('driver-tg-percent')?.addEventListener('click', () => setDriverMode('percent'));
    // A manual edit to the DH Miles field also counts as a user DH override.
    q('dh')?.addEventListener('input', () => { _dhUserEdited = true; });
    const dhFromEl = q('dh-from');
    if (dhFromEl) {
      dhFromEl.addEventListener('change', () => { _dhUserEdited = true; fetchDHRoute(); });
      dhFromEl.addEventListener('input', () => {
        _dhUserEdited = true;
        clearTimeout(_dhDebounce);
        _dhDebounce = setTimeout(fetchDHRoute, 800);
      });
    }
    applyDriverMode(dlmDriverPayMode, true);   // paint saved mode; keep the carried $/mi value, then compute

    // Same-lane reconcile from a content push: refresh map + Loaded stats, auto-fill
    // Miles only if still blank — NEVER overwrite the user's calculator inputs or
    // their locally-typed DH (preserve in-progress edits).
    function reconcile(ts) {
      if (ts.mainPolyline) mainPolyline = ts.mainPolyline;

      // Option A — apply carried DH (no getRoute): the push that CREATED this tab can
      // snapshot before the inline DH fetch resolves (dhMiles empty); a later push
      // carries the completed dhMiles/dhPolyline/dhCity. Apply it here so the gray leg
      // + financials populate without a retype — UNLESS the user typed their own DH.
      let dhApplied = false;
      if (!_dhUserEdited && (ts.dhFrom || ts.dhMiles)) {
        const dhFromEl = q('dh-from'), dhEl = q('dh');
        if (dhFromEl) dhFromEl.value = ts.dhFrom  || '';
        if (dhEl)     dhEl.value     = ts.dhMiles || '';
        dhPolyline = ts.dhPolyline || null;
        dhCity     = ts.dhCity     || '';
        const dd = q('stat-dh-dist'), ddu = q('stat-dh-dur');
        if (dd)  dd.textContent  = ts.statDhDist || '—';
        if (ddu) ddu.textContent = ts.statDhDur  || '';
        dhApplied = true;
      }

      drawMap();   // redraws the gray DH leg from the (possibly just-applied) dhPolyline

      const milesEl = q('miles');
      let milesFilled = false;
      if (milesEl && !milesEl.value && ts.miles) { milesEl.value = ts.miles; milesFilled = true; }
      const d = q('stat-dist'), du = q('stat-dur');
      if (d  && ts.statDist) d.textContent  = ts.statDist;
      if (du && ts.statDur)  du.textContent = ts.statDur;

      // Fold any newly-applied DH/Miles into totalMiles → fuel/driver/profit.
      if (dhApplied || milesFilled) calc();
    }

    function activate()   { mbody.style.display = ''; }
    function deactivate() { mbody.style.display = 'none'; }
    function destroy()    { clearTimeout(_dhDebounce); mbody.remove(); }

    return { id, origin, dest, label, paneEl: mbody, activate, deactivate, reconcile, destroy };
  }

  // ── Tab strip + local switching ────────────────────────────────────────────
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
      x.addEventListener('click', e => { e.stopPropagation(); closeTabLocal(i); });
      tab.append(lbl, x);
      tabStrip.appendChild(tab);
    });
  }

  // Tab switch is LOCAL only — never writes storage.
  function switchTab(i) {
    if (i < 0 || i >= tabs.length) return;
    if (activeIdx >= 0 && tabs[activeIdx]) tabs[activeIdx].deactivate();
    activeIdx = i;
    tabs[i].activate();
    titleEl.innerHTML = `${esc(tabs[i].origin || '—')}<span>→</span>${esc(tabs[i].dest || '—')}`;
    renderTabStrip();
  }

  // Floating × → ask content.js (the authority) to close this lane via a one-shot
  // command. We do NOT remove locally; content closes its inline pane and re-pushes
  // routeState without it, then applyRouteState() removes it here. If content was
  // torn down, the command is harmlessly dropped (the tab simply stays).
  function closeTabLocal(i) {
    const pane = tabs[i];
    if (!pane) return;
    _cmdSeq += 1;
    chrome.storage.local.set({ routeCommand: { type: 'closeTab', id: pane.id, nonce: Date.now() + '-' + _cmdSeq } });
  }

  function flash(el) {
    el.classList.remove('route-refreshed');
    void el.offsetWidth;
    el.classList.add('route-refreshed');
  }
  function destroyAll() { tabs.forEach(t => t.destroy()); tabs.length = 0; activeIdx = -1; tabStrip.innerHTML = ''; }
  function showEmpty()  { titleEl.textContent = 'Route'; tabStrip.innerHTML = ''; if (emptyEl) emptyEl.style.display = 'flex'; }
  function hideEmpty()  { if (emptyEl) emptyEl.style.display = 'none'; }

  // ── Reconcile rendered tabs to a routeState push (diff by stable id) ────────
  function applyRouteState(rs) {
    if (!rs) { destroyAll(); showEmpty(); return; }
    // v=2 multi-lane, or migrate a legacy v1 single-lane object to one tab.
    const norm = (rs.v === 2 && Array.isArray(rs.tabs))
      ? rs
      : { v: 2, tabs: [Object.assign({ id: 'legacy' }, rs)], activeId: 'legacy', newId: null };
    const incoming = norm.tabs;
    if (!incoming.length) { destroyAll(); showEmpty(); return; }

    const prevActiveId  = (activeIdx >= 0 && tabs[activeIdx]) ? tabs[activeIdx].id : null;
    const prevActiveIdx = activeIdx;
    const incomingIds   = new Set(incoming.map(t => t.id));

    // 1. Remove tabs no longer present (content closed them or 5-cap dropped them).
    for (let i = tabs.length - 1; i >= 0; i--) {
      if (!incomingIds.has(tabs[i].id)) { tabs[i].destroy(); tabs.splice(i, 1); }
    }
    // 2. Add new / update existing, aligning array order to incoming.
    for (let pos = 0; pos < incoming.length; pos++) {
      const ts = incoming[pos];
      const idx = tabs.findIndex(t => t.id === ts.id);
      if (idx === -1) {
        const pane = buildFloatPane(ts);
        pane.deactivate();
        paneHost.appendChild(pane.paneEl);
        tabs.splice(pos, 0, pane);
      } else {
        tabs[idx].reconcile(ts);
        if (idx !== pos) { const [p] = tabs.splice(idx, 1); tabs.splice(pos, 0, p); }
      }
    }
    hideEmpty();

    // 3. Decide focus: first render → activeId; a brand-new tab → newId; otherwise
    //    keep the user's current view (don't yank it on a mere data refresh).
    let focusId;
    if (!_initialized) { _initialized = true; focusId = norm.activeId; }
    else if (norm.newId != null && tabs.some(t => t.id === norm.newId)) { focusId = norm.newId; }
    else { focusId = prevActiveId; }
    let fi = tabs.findIndex(t => t.id === focusId);
    if (fi < 0) fi = Math.min(prevActiveIdx < 0 ? 0 : prevActiveIdx, tabs.length - 1);

    // Deactivate every pane (some may still be visible after removals) then show one.
    tabs.forEach(t => t.deactivate());
    activeIdx = -1;
    switchTab(fi);
    if (focusId === norm.newId && tabs[fi]) flash(tabs[fi].paneEl);
  }

  // When this window closes (any method), tell content.js to tear the inline modal
  // down COMPLETELY (NOT re-show). background.js's onRemoved emits routeClosed too —
  // belt-and-suspenders; content dedups the token and the teardown is idempotent.
  window.addEventListener('unload', () => {
    chrome.storage.local.set({
      routePopped: false,
      routeClosed: Date.now() + '-' + Math.random().toString(36).slice(2),
    });
  });

  async function init() {
    const s = await chrome.storage.local.get(['routeState', 'mapsApiKey', 'dlmMpg', 'dlmFuelPrice', 'dlmDriverRate', 'dlmDriverPercent', 'dlmDriverPayMode']);
    mapsApiKey    = s.mapsApiKey || '';
    dlmMpg        = +s.dlmMpg        || 6.5;
    dlmFuelPrice  = +s.dlmFuelPrice  || 3.89;
    dlmDriverRate = +s.dlmDriverRate || 0;
    dlmDriverPercent = +s.dlmDriverPercent || 0;
    dlmDriverPayMode = (s.dlmDriverPayMode === 'percent') ? 'percent' : 'permile';

    if (s.routeState) applyRouteState(s.routeState);
    else showEmpty();

    chrome.storage.onChanged.addListener((changes) => {
      if (changes.mapsApiKey)    mapsApiKey    = changes.mapsApiKey.newValue    || '';
      if (changes.dlmMpg)        dlmMpg        = +changes.dlmMpg.newValue        || 6.5;
      if (changes.dlmFuelPrice)  dlmFuelPrice  = +changes.dlmFuelPrice.newValue  || 3.89;
      if (changes.dlmDriverRate) dlmDriverRate = +changes.dlmDriverRate.newValue || 0;
      if (changes.dlmDriverPercent) dlmDriverPercent = +changes.dlmDriverPercent.newValue || 0;
      if (changes.dlmDriverPayMode) dlmDriverPayMode = (changes.dlmDriverPayMode.newValue === 'percent') ? 'percent' : 'permile';
      if (changes.routeState)    applyRouteState(changes.routeState.newValue);
    });
  }

  init();
})();

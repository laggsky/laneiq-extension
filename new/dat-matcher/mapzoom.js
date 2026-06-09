// mapzoom.js — SHARED static-map zoom/pan helper.
//
// Loaded by BOTH surfaces so the attached (inline modal, content.js) and detached
// (floating window, route.js) maps behave identically from one source of truth:
//   • As a content script (manifest content_scripts, listed BEFORE content.js) it
//     runs in the page's isolated world and content.js reads window.attachMapZoomPan.
//   • In route.html it's a <script> before route.js, same window.
//
// PURE CSS-transform manipulation of the already-loaded static <img>. Zoom and pan
// never trigger a network request — the cached proxy image is just magnified/moved.
// Attached fresh per map render (each renderMap/drawMap builds a new <img>), so a
// new lane always starts at 1x fit with no carried-over zoom state.
(function () {
  'use strict';

  // container: the overflow:hidden, position:relative map frame.
  // img:       the <img> inside it (width/height 100% of the frame).
  function attachMapZoomPan(container, img, opts) {
    opts = opts || {};
    const MIN = 1, MAX = opts.max || 4;     // 1x = fitted default, never below
    let scale = 1, tx = 0, ty = 0;
    let dragging = false, sx = 0, sy = 0, stx = 0, sty = 0;

    img.draggable = false;                   // kill native image-drag ghost
    img.style.transformOrigin = '0 0';
    img.style.willChange = 'transform';

    // Constrain pan so the scaled image always covers the frame — no empty gaps.
    // With transform-origin 0 0, the image spans [tx, tx + W*scale]; to cover
    // [0, W] we need tx in [W*(1-scale), 0]. At 1x the range collapses to 0 (no pan).
    function clampPan() {
      const W = container.clientWidth, H = container.clientHeight;
      const minX = W * (1 - scale), minY = H * (1 - scale);
      if (tx > 0) tx = 0; if (tx < minX) tx = minX;
      if (ty > 0) ty = 0; if (ty < minY) ty = minY;
      if (scale <= MIN) { tx = 0; ty = 0; }
    }
    function apply() {
      clampPan();
      img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      img.style.cursor = scale > MIN ? (dragging ? 'grabbing' : 'grab') : 'default';
    }
    // Zoom keeping the image point under (cx,cy) — frame-relative — fixed.
    function zoomAt(cx, cy, factor) {
      const newScale = Math.max(MIN, Math.min(MAX, scale * factor));
      if (newScale === scale) return;
      tx = cx - (cx - tx) * (newScale / scale);
      ty = cy - (cy - ty) * (newScale / scale);
      scale = newScale;
      apply();
    }
    function reset() { scale = 1; tx = 0; ty = 0; apply(); }

    // ── Wheel / trackpad zoom, centered on the cursor ──────────────────────────
    function onWheel(e) {
      e.preventDefault(); e.stopPropagation();
      const r = container.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.pow(1.0015, -e.deltaY));
    }
    // ── Click-drag pan (only when zoomed in). stopPropagation so the map drag
    //    never reaches the modal-header / window drag handler. ──────────────────
    function onDown(e) {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      if (scale <= MIN) return;              // 1x is fully fit — nothing to pan
      dragging = true; sx = e.clientX; sy = e.clientY; stx = tx; sty = ty;
      img.style.cursor = 'grabbing';
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    }
    function onMove(e) {
      if (!dragging) return;
      e.preventDefault(); e.stopPropagation();
      tx = stx + (e.clientX - sx); ty = sty + (e.clientY - sy);
      apply();
    }
    function onUp(e) {
      if (!dragging) return;
      dragging = false;
      if (e) e.stopPropagation();
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      apply();
    }
    function onDbl(e) { e.preventDefault(); e.stopPropagation(); reset(); }

    container.addEventListener('wheel', onWheel, { passive: false });
    img.addEventListener('mousedown', onDown, true);
    container.addEventListener('dblclick', onDbl, true);

    // ── +/− / reset overlay (bottom-right). mousedown stopPropagation so a button
    //    press never starts a pan or a header/window drag. ───────────────────────
    const ctrl = document.createElement('div');
    ctrl.className = 'dlm-map-zoom';
    const cr = () => container.getBoundingClientRect();
    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'dlm-map-zoom-btn';
      b.textContent = label; b.title = title;
      b.addEventListener('mousedown', e => { e.stopPropagation(); });
      b.addEventListener('dblclick',  e => { e.stopPropagation(); });
      b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); fn(); });
      return b;
    };
    ctrl.append(
      mk('+', 'Zoom in',  () => { const r = cr(); zoomAt(r.width / 2, r.height / 2, 1.4); }),
      mk('−', 'Zoom out', () => { const r = cr(); zoomAt(r.width / 2, r.height / 2, 1 / 1.4); }),
      mk('↻', 'Reset to fit', () => reset())
    );
    container.appendChild(ctrl);

    apply();
    return { reset };
  }

  if (typeof window !== 'undefined') window.attachMapZoomPan = attachMapZoomPan;
})();

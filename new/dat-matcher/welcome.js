const VALIDATE_URL = 'https://laneiq-backend-production.up.railway.app/validate';
const NUM_SCREENS  = 7;

// Stable per-install device id (privacy-friendly UUID, no fingerprinting).
// Created once and reused; shared across all extension contexts via storage.local.
async function getDeviceId() {
  const { dlmDeviceId } = await chrome.storage.local.get('dlmDeviceId');
  if (dlmDeviceId) return dlmDeviceId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ dlmDeviceId: id });
  return id;
}

const deck    = document.getElementById('deck');
const screens = Array.from(document.querySelectorAll('.screen'));
const dots    = Array.from(document.querySelectorAll('.pdot'));

// ── Deck navigation ──────────────────────────────────────────────────────────

function goTo(n) {
  deck.classList.remove('show-2','show-3','show-4','show-5','show-6','show-7');
  if (n > 1) deck.classList.add('show-' + n);
  screens.forEach((s, i) => s.classList.toggle('active', i === n - 1));
  dots.forEach((d, i)    => d.classList.toggle('active', i === n - 1));
}

document.querySelectorAll('[data-go]').forEach(el => {
  el.addEventListener('click', () => {
    const target = parseInt(el.dataset.go, 10);
    if (!isNaN(target)) goTo(target);
  });
});

// Stripe plan links: open in new tab then advance to activate screen
document.querySelectorAll('[data-stripe]').forEach(link => {
  link.addEventListener('click', () => {
    setTimeout(() => goTo(NUM_SCREENS), 250);
  });
});

// Final CTA — open DAT load board
document.getElementById('go-btn').addEventListener('click', () => {
  window.open('https://one.dat.com', '_blank', 'noopener');
});

// ── URL param deep-link (e.g. welcome.html?screen=7) ──────────────────────

(function deepLink() {
  const params    = new URLSearchParams(window.location.search);
  const requested = parseInt(params.get('screen'), 10);
  if (isNaN(requested) || requested < 1 || requested > NUM_SCREENS) return;
  if (requested === 1) return;
  const prev = deck.style.transition;
  deck.style.transition = 'none';
  goTo(requested);
  requestAnimationFrame(() => requestAnimationFrame(() => { deck.style.transition = prev; }));
})();

// ── Email template switcher ──────────────────────────────────────────────────

const TEMPLATES = {
  quick: {
    subject: 'Load Available? – <span class="hl">Sacramento, CA</span> → <span class="hl">Chicago, IL</span>',
    body:    'Hi,\n\nIs your <span class="hl">Sacramento, CA</span> → <span class="hl">Chicago, IL</span> load still available? What\'s your best rate?',
  },
  friendly: {
    subject: 'Load Inquiry – <span class="hl">Sacramento, CA</span> → <span class="hl">Chicago, IL</span>',
    body:    'Hi,\n\nThis is <span class="hl">Maria</span> with <span class="hl">LaneIQ</span>. Please tell me more about your load from <span class="hl">Sacramento, CA</span>, pickup on <span class="hl">01/15</span>, going to <span class="hl">Chicago, IL</span>, posted on DAT today.',
  },
  detailed: {
    subject: 'Interested in your <span class="hl">Sacramento, CA</span> load on <span class="hl">01/15</span>',
    body:    'Hi,\n\nI\'m interested in your <span class="hl">Sacramento, CA</span> load on <span class="hl">01/15</span>. Could you share the rate, weight, equipment type, and pickup window for your load going to <span class="hl">Chicago, IL</span>?\n\nThank you.',
  },
};

const gmailSubject = document.getElementById('gmailSubject');
const gmailBody    = document.getElementById('gmailBody');

document.querySelectorAll('.tpl-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.tpl-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    const tpl = TEMPLATES[card.dataset.tpl];
    if (tpl && gmailSubject && gmailBody) {
      gmailSubject.innerHTML = tpl.subject;
      gmailBody.innerHTML    = tpl.body;
    }
  });
});

// ── License activation — same endpoint + storage shape as the Setup tab ──────
// Keys written here are identical to those written by popup.js on activation:
//   licenseKey, licenseValid, licenseCheckedAt, licenseTier

const actInput   = document.getElementById('act-input');
const actBtn     = document.getElementById('activate-btn');
const actError   = document.getElementById('act-error');

function showActError(msg) {
  actError.textContent = msg;
  actError.style.display = 'block';
}

function clearActError() {
  actError.style.display = 'none';
  actError.textContent   = '';
}

actBtn.addEventListener('click', handleActivate);
actInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleActivate(); });

async function handleActivate() {
  const raw = actInput.value.trim().toUpperCase();
  if (!raw) { showActError('Please enter your activation key.'); return; }

  clearActError();
  actBtn.disabled     = true;
  actBtn.textContent  = 'Activating…';
  actInput.disabled   = true;

  try {
    const deviceId = await getDeviceId();
    const resp = await fetch(VALIDATE_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ key: raw, deviceId }),
    });

    if (!resp.ok) throw new Error('server');

    const data = await resp.json();

    if (!data.valid) {
      const msg = data.reason === 'device_limit'
        ? `This license is already active on ${data.deviceLimit || 3} devices. Contact support@laneiq.org to reset a device.`
        : "That key isn't valid — check your email and try again.";
      showActError(msg);
      actBtn.disabled    = false;
      actBtn.textContent = 'Activate';
      actInput.disabled  = false;
      actInput.select();
      return;
    }

    // Store with the exact same keys the Setup tab uses so the extension
    // treats onboarding activation and Setup-tab activation identically.
    await chrome.storage.local.set({
      licenseKey:        raw,
      licenseValid:      true,
      licenseCheckedAt:  new Date().toISOString(),
      licenseTier:       data.tier || 'solo',
    });

    // Success state
    actBtn.textContent = '✓ Activated!';
    actBtn.style.background  = '#16a34a';
    actBtn.style.boxShadow   = '0 8px 20px rgba(22,163,74,.28)';
    actInput.style.borderColor = '#16a34a';

    // Surface the "Open DAT" button more prominently
    const goBtn = document.getElementById('go-btn');
    if (goBtn) {
      goBtn.style.marginTop = '24px';
      goBtn.focus();
    }

  } catch (err) {
    const msg = err.message === 'server'
      ? 'Server error — please try again in a moment.'
      : "Couldn't reach the server — check your connection and try again.";
    showActError(msg);
    actBtn.disabled    = false;
    actBtn.textContent = 'Activate';
    actInput.disabled  = false;
  }
}

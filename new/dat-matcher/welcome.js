const deck    = document.getElementById('deck');
const screens = Array.from(document.querySelectorAll('.screen'));
const dots    = Array.from(document.querySelectorAll('.pdot'));

function goTo(n) {
  // Slide deck: remove all show-N classes, add the target one (or none for screen 1)
  deck.classList.remove('show-2', 'show-3', 'show-4', 'show-5', 'show-6');
  if (n > 1) deck.classList.add(`show-${n}`);

  // Activate the target screen's inner fade-up; deactivate the others
  screens.forEach((s, i) => s.classList.toggle('active', i === n - 1));

  // Indicator dots
  dots.forEach((d, i) => d.classList.toggle('active', i === n - 1));
}

// Wire every element with [data-go="N"] to slide to screen N
document.querySelectorAll('[data-go]').forEach(el => {
  el.addEventListener('click', () => {
    const target = parseInt(el.dataset.go, 10);
    if (!isNaN(target)) goTo(target);
  });
});

// Stripe plan links open in a new tab and auto-advance the welcome page
// to Screen 6 (Pin It) so the user lands on the final step when they
// switch back. Don't preventDefault — let the link open Stripe normally.
document.querySelectorAll('[data-stripe]').forEach(link => {
  link.addEventListener('click', () => {
    // Small delay so the new tab opens before the slide animation steals focus
    setTimeout(() => goTo(6), 250);
  });
});

// Final CTA on the last screen — open DAT load board
document.getElementById('go-btn').addEventListener('click', () => {
  window.location.href = 'https://one.dat.com';
});

// ── URL param: deep-link directly to a specific screen ──────────────────
// e.g. welcome.html?screen=2 lands the user on the Setup screen.
// Suppress the slide transition for the initial jump so it doesn't look
// like the deck slid in from screen 1.
(function deepLink() {
  const params = new URLSearchParams(window.location.search);
  const requested = parseInt(params.get('screen'), 10);
  if (isNaN(requested) || requested < 1 || requested > screens.length) return;
  if (requested === 1) return; // default — nothing to do

  const prevTransition = deck.style.transition;
  deck.style.transition = 'none';
  goTo(requested);
  // Force layout flush, then restore the transition for subsequent clicks.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => { deck.style.transition = prevTransition; });
  });
})();

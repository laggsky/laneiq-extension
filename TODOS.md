# LaneIQ — Deferred Work

## TODO-001: DAT Terms of Service Review

**What:** Read DAT's ToS to confirm a paid third-party extension operating on their load board is permitted.

**Why:** Acquiring paying customers creates legal exposure if DAT's ToS prohibits commercial tools. Low-urgency for first 5 customers, high-urgency before any public marketing push or Chrome Store featuring.

**Context:** Flagged in CLAUDE.md and the design doc but never formally reviewed. LoadConnect.io (15,000+ users) operating in the same space is indirect evidence the risk is low — but not proof. One 30-minute read resolves the question.

**Depends on / blocked by:** Nothing. 30-minute task.

---

## TODO-002: DOM Health Check for Silent Extension Failure

**What:** Add a health check to `content.js` that detects when LaneIQ is running but highlighting zero rows on a page that has visible DAT load rows. Surface a warning in the popup: "LaneIQ may be out of sync with DAT — contact support."

**Why:** DAT periodically changes their DOM structure, which breaks all selector-based matching silently. A paying customer sees no highlights, no error — just silence. This becomes a churn event. A health check converts silent failure into a visible one.

**Context:** Deferred from Phase 1 eng review because the first 5 customers have a direct line to the founder. Becomes higher priority when customer count exceeds ~10 and personal monitoring isn't practical. Implementation: ~30 lines in `content.js`, check if `processed` WeakSet entries exist but highlight count is zero after a scan pass.

**Depends on / blocked by:** Nothing. ~30 lines in `new/dat-matcher/content.js`.

---

## TODO-003: License Key Backend — Automated Issuance via Stripe Webhook

**What:** Upgrade the Phase 1 manual license key system to a fully automated flow: Stripe `checkout.session.completed` webhook → generate UUID license key → store in database → email key to customer. Replace manual key issuance with self-serve.

**Why:** Phase 1 requires the founder to manually generate and email a license key to each new customer. At 20+ customers this becomes a daily support burden and blocks self-serve growth.

**Context:** Railway is already identified as the planned backend (CLAUDE.md). The Phase 1 validation endpoint architecture is the same — just the key issuance gets automated. The upgrade path is: (1) add Stripe webhook handler, (2) add key storage table, (3) trigger key email on `checkout.session.completed`. The extension-side validation code doesn't change.

**Depends on / blocked by:** Phase 1 license key implementation must be shipped and working first.

# LaneIQ — DAT Lane Matcher Extension
## CLAUDE CODE MUST READ THIS FILE FIRST EVERY SESSION

---

## ⚠️ CRITICAL SESSION RULES
1. Always confirm pwd = /Users/alex/Desktop/LaneIQ-project  2.0/ before touching any file
2. NEVER work in: LaneIQ-project  2.0 may 19/ — that is an old abandoned folder
3. Show before/after plan and wait for explicit "go ahead" before any file write
4. Read this file before doing anything else. No exceptions.

---

## Working Directories
- Extension: /Users/alex/Desktop/LaneIQ-project  2.0/new/dat-matcher/
- Backend: /Users/alex/Desktop/LaneIQ-project  2.0/backend/index.js
- Website: /Users/alex/Desktop/LaneIQ- Netlify/
- Folder name has TWO spaces: "LaneIQ-project  2.0" — not one

---

## Architecture
- Chrome Extension (Manifest V3) — content.js injected into one.dat.com
- Railway backend: https://laneiq-backend-production.up.railway.app
- Neon Postgres: licenses table (key, email, tier, stripe_customer_id, stripe_subscription_id, active)
- Resend: transactional email from hello@laneiq.org (DKIM/SPF verified on Cloudflare)
- ImprovMX: forwards hello@laneiq.org → laneiqapp@gmail.com
- Bruno agent: https://hermes-agent-production-5bd94.up.railway.app (Telegram @bruno_laneiq_bot)
- DNS: Cloudflare (NOT Namecheap — nameservers already switched)
- Website: laneiq.org hosted on Netlify

---

## Current Version
- Manifest: 1.31
- Chrome Store target: v1.31 (submitted, awaiting Published confirmation)
- Last submitted to store: v1.25 (May 26 2026)

## Ship Checklist (do IN ORDER — prevents shipping a stale build)
A stale v1.29 once shipped because code landed but the manifest was never
bumped, so the corrected build couldn't be re-uploaded. Never again:
1. Bump manifest "version" in new/dat-matcher/manifest.json BEFORE zipping
2. Commit (and push) the bump + code
3. Zip: `cd new/dat-matcher && zip -r ~/Desktop/laneiq-vX.YZ.zip . -x "*.DS_Store"`
4. Verify INSIDE the zip — not just the folder:
   - `unzip -p ~/Desktop/laneiq-vX.YZ.zip manifest.json | grep '"version"'` → matches intended
   - `unzip -p ~/Desktop/laneiq-vX.YZ.zip content.js | grep -c "getMiles"` → >0 (a known-new code marker; swap for whatever's newest)
5. Confirm the zipped version is STRICTLY GREATER than what's live on the Store (Store rejects equal/lower)

---

## Pricing
- Solo: $19/month — CSV only
- Pro: $39/month — CSV + LaneIQ Database
- Trial: 30 days free, no card required
- BETA coupon: BETA2 (100% off, 3-redemption cap)
- Solo payment link: https://buy.stripe.com/4gM14mazng8ydXabdv5EY02
- Pro payment link: https://buy.stripe.com/4gMaEW22RcWm9GU1CV5EY01
- Stripe Customer Portal: https://billing.stripe.com/p/login/7sY9AScHv3lMaKY2GZ5EY00

---

## How the Extension Works
1. User uploads CSV history or activates Pro DB access via license key
2. content.js builds OD index, origin index, broker index in chrome.storage
3. DAT load rows highlighted by tier:
   - Purple — same lane + same broker
   - Green — same lane, 3+ times
   - Yellow — same lane, 1-2 times
   - Blue — same origin city/state only
4. Clicking a row opens side panel with lane history + rate data
5. License validated against Railway /validate on every page load
6. Stripe webhook → Railway → generates key → Resend sends activation email

---

## Known Architecture Notes
- Two email injection systems in content.js (~line 351 and ~line 1795) — always check both when debugging email chip issues. Merging is a future task, do not combine now.
- DAT renames CSS classes without warning — if extension stops working, check class names first
- chrome.storage.sync tied to Chrome profile — not to license key
- License validation uses direct Railway /validate call on every page load
- Dispatchers never open popup after initial setup — any logic requiring popup interaction is broken by design
- processRow is async, chip injection is sync — race condition possible

---

## Bugs Fixed May 26 2026
1. const → let on _dbMatchCache — silent TypeError crash on every toggle
2. _initializing flag — prevented concurrent init() runs
3. _observersSetup flag — prevented duplicate MutationObservers accumulating
4. flushExpand guard: if (!_initialized) return — panel hiding mid re-init
5. clearAllHighlights hoisted to module scope, onChanged listener moved inside _observersSetup (registers once only)
6. flushExpand destination fix: if (!o) → if (!o || !d), Strategy 3 now tries node.innerText first
7. 8 switchTab('history') calls guarded — Setup/Notes/Templates tabs no longer hijacked by row clicks or re-init

---

## Email System
- Activation emails sent via Resend from hello@laneiq.org
- sendKeyEmail() has retry logic: fails → waits 5s → retries → on second failure sends Bruno Telegram alert with customer email + key
- Resend domain laneiq.org verified on Cloudflare (DKIM + SPF + MX all green as of May 26 2026)
- If email not in Resend logs → check Railway logs for [LaneIQ] Resend error

---

## Bruno Cron Stack
| Job | Schedule | What it does |
|---|---|---|
| dat-monitor | every 30m | Checks DAT for missing row-container selector |
| stripe-webhook-monitor | daily | Checks Stripe webhook endpoints are enabled |
| webhook-monitor | every 60m | Polls /webhook-failures, texts Alex if unacknowledged |
| selector-monitor | every 30m | Polls /selector-errors, texts Alex if DAT selectors broken |

---

## Debugging Rules
1. Map ALL code paths before debugging
2. content.js has TWO email injection systems — check both
3. Check chrome.storage for stuck booleans if UI breaks silently
4. DAT renames CSS classes — check first if extension stops working
5. processRow async, chip injection sync — race condition possible
6. Extension silently dead → add checkpoint logs to init()
7. Any extension file change = new version + Chrome Store submission
8. Dev version OAuth won't work — needs stable Chrome Store ID

---

## Gmail / OAuth Status
- gmail.send scope: submitted for Google verification May 25 2026
- Do NOT re-add Gmail signature feature until Google verifies gmail.send
- Current Gmail button opens compose window (no OAuth needed)
- OAuth reply sent May 25 with domain fix + demo video

---

## Infrastructure Costs
- Railway: $5/month
- Neon: $0 (free tier)
- Resend: free tier
- Total: ~$8-12/month

---

## Session Notes
- May 13: v1.9 submitted, panelPopped fix, DAT class rename handled
- May 15: Bruno save-link skill, webhook failure logging
- May 17: Bruno cron stack complete, stripe-webhook-monitor added
- May 18: DAT selector alerts, v1.17 submitted
- May 26: v1.25 submitted — 7 major content.js fixes + email system fixed

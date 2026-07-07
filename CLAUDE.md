# LaneIQ — DAT Lane Matcher Extension
## CLAUDE CODE MUST READ THIS FILE FIRST EVERY SESSION

Deep history + session-by-session detail lives in GBrain. This file is the operating cheat sheet: current-state facts Claude Code needs to work. When in doubt about recent work, check GBrain notes (latest: laneiq-welcome-business-device-0628, laneiq-popup-cleanup-0628, laneiq-team-plan-layer4-packaged).

---

## ⚠️ CRITICAL SESSION RULES
1. Always confirm pwd = /Users/alex/Desktop/LaneIQ-project  2.0/ (TWO spaces) before touching any file
2. NEVER work in old abandoned folders (e.g. "LaneIQ-project  2.0 may 19/")
3. Show before/after plan and wait for explicit "go ahead" before any file write
4. Read this file before doing anything else. No exceptions.
5. Confirm exact values (model names, links, config strings) from source before suggesting changes
6. When multiple files are uploaded, read ALL before acting

---

## Working Directories
- Extension: /Users/alex/Desktop/LaneIQ-project  2.0/new/dat-matcher/
- Backend: /Users/alex/Desktop/LaneIQ-project  2.0/backend/index.js
- Website: /Users/alex/Desktop/LaneIQ- Netlify/ (space BEFORE "Netlify")
- Folder name has TWO spaces: "LaneIQ-project  2.0" — not one
- Extension ID: fbnmkdnkghigdkpakmeehholcbekddol

---

## Architecture
- Chrome Extension (Manifest V3) — content.js injected into one.dat.com
- Railway backend: https://laneiq-backend-production.up.railway.app (deploys via `railway up` from backend/, NOT git push)
- Neon Postgres: licenses table (key, email, tier, stripe_customer_id, stripe_subscription_id, active) + team_lanes + team_devices
- Brevo: transactional email (license keys). MIGRATED from Resend (persistent DKIM failure). Brevo authenticated instantly.
- ImprovMX: forwards hello@laneiq.org → laneiqapp@gmail.com
- Bruno agent: https://hermes-agent-production-5bd94.up.railway.app (Telegram @bruno_laneiq_bot). Provider: xAI OAuth / grok-4.3. HERMES_REF must never go below v2026.5.16. NEVER change Bruno auth/provider/API key without explicit permission.
- DNS: Cloudflare (NOT Namecheap — nameservers switched)
- Website: laneiq.org deploys via CLOUDFLARE PAGES (project "laneiq"), NOT Netlify despite the folder name. Deploy: `cd "/Users/alex/Desktop/LaneIQ- Netlify" && npx wrangler pages deploy . --project-name=laneiq`. Deploying pushes FILES only — does NOT touch DNS or OAuth.
- laneiq.co: future home (only trips.laneiq.co live there now — the Trip Planner). Main site still on laneiq.org.

---

## Current Version
- v1.53 submitted to Chrome Store (July 6/7). v1.52 is/was live in the meantime.
- v1.53 adds: email required on activation for ALL plans (solo/pro + team), validated with a real regex not just "@" presence; welcome.html footer corrected to list Business + $17/month floor.
- Backend land-grab mode LIVE since July 6: ENFORCE_LIMITS env flag (Railway, set to "false") bypasses all device/seat caps — everyone activates freely, all activity still logged (license_devices, team_devices). Flip to "true" to restore full enforcement instantly, no redeploy needed.
- Backend also captures optional `email` on solo/pro /validate calls now (license_devices.email column) — never required server-side, only required client-side in the extension UI.
- Git: PAT is WORKING. If push fails with "Invalid username or token" or "not a git repository," check (a) you're in the right directory, (b) `git remote -v` for a dead token embedded IN the URL (fix: `git remote set-url origin https://github.com/laggsky/<repo>.git`). Do NOT assume PAT is expired without checking this first — it caused hours of false debugging.

## Ship Checklist (do IN ORDER — prevents shipping a stale build)
A stale build once shipped because code landed but the manifest wasn't bumped, so the corrected build couldn't be re-uploaded. Never again:
1. Bump manifest "version" in new/dat-matcher/manifest.json BEFORE zipping
2. Commit (and push if PAT available) the bump + code
3. Zip: `cd new/dat-matcher && zip -r ~/Desktop/laneiq-vX.YZ.zip . -x "*.DS_Store"`
4. Verify INSIDE the zip (not just the folder):
   - `unzip -p ~/Desktop/laneiq-vX.YZ.zip manifest.json | grep '"version"'` → matches intended
   - confirm xlsx.full.min.js is present inside the zip (SheetJS — required, ~951KB)
5. Confirm the zipped version is STRICTLY GREATER than what's live on the Store (Store rejects equal/lower)

---

## Pricing — THREE TIERS
- Solo: $19/month — CSV only
- Pro: $39/month — CSV + LaneIQ Database
- Business: $17/SEAT/month — shared team lane history (qty 2–99)
- Trial: 30 days free, no card required
- BETA coupon: BETA2 (100% off, 3-redemption cap)
- Solo link:     https://buy.stripe.com/cNiaEW22R2hI7yM0yR5EY05
- Pro link:      https://buy.stripe.com/8x26oG9vjf4u6uIchz5EY06
- Business link: https://buy.stripe.com/6oU4gy4aZcWmg5i3L35EY07
- Trial link:    https://buy.stripe.com/cNi4gy7nb4pQ1ao1CV5EY03
- Customer Portal: https://billing.stripe.com/p/login/7sY9AScHv3lMaKY2GZ5EY00
- Price IDs (PRICE_TO_TIER in backend/index.js): solo price_1TWKyTCI8743sDK5S8CqHUrW, pro price_1TWKztCI8743sDK5h9xqtSNv, team price_1Tn5w4CI8743sDK5UZuu2ZLe
- NOTE: website seat stepper is a SELLING VISUAL ONLY — `?quantity=N` does NOT carry to Stripe Payment Links (Stripe ignores it). Buyer sets qty on Stripe's page.

---

## Team / Business Plan (architecture — locked)
- TWO keys per purchase: a private MANAGER key (LANEIQ-TEAM-MGR-...) that uploads team data + manages seats + counts as a seat; and a SHARED DISPATCHER key (LANEIQ-TEAM-...) that every dispatcher activates with their OWN email.
- Authority = the BUYER'S EMAIL (licenses.email), not key possession. Manager = whoever activates with the buyer email.
- Seat = a person (email), 2 devices each. seat_limit from Stripe quantity. Manager bypasses seat cap, not device cap.
- Team matching is LOCAL / CSV-style, NOT server-side: manager uploads via the same CSV mapper → rows go to team_lanes (cloud) → dispatchers fetch ALL rows from /team/lanes → feed into buildIndexesFromCSVRows → match in-browser, identical to a local CSV (incl. purple/broker). New upload REPLACES old.
- Team tier = TWO sources: Local CSV + Team (mirrors Pro's CSV + Database). NO Database access for team tier.
- Backend endpoints (all live): /validate-team (seat gatekeeper), /team/upload (manager-only REPLACE), /team/lanes (any seat fetches full set), /team/seats/list, /team/seats/remove. /validate is HARDENED to reject team keys (returns use_team_validation).
- team_lanes schema (14 cols): team_id, origin, pu_date, destination, weight_info, rate, pickup_address, delivery_address, commodity, source_file, broker, trailer, truck, load_num, uploaded_at. (broker drives purple matching. source_file is stored but NOT returned by /team/lanes.)
- Webhook (customer.subscription.created): if tier==='team', forks → seat_limit from quantity → team_id 'TEAM-'+8hex → mints 2 keys → 2 licenses rows (manager carries sub_id, dispatcher NULL) → Brevo emails both keys.

---

## Activation & Popup (current behavior)
- SOLO/PRO: key only → POST /validate {key, deviceId}. No email field shown.
- TEAM: key + email → POST /validate-team {key, email, deviceId}. Email field reveals when a LANEIQ-TEAM key is typed.
- TWO activation surfaces, both team-aware and storing the SAME shape: the popup (popup.js / popup.html) AND the welcome page (welcome.js / welcome.html, Screen 7).
- Team success stores: licenseKey, licenseValid, licenseCheckedAt, licenseTier:'team', teamId, teamEmail, teamRole, seatLimit, seatsUsed, useTeam:true.
- useTeam:true AUTO-ENABLES Team mode on activation so new dispatchers don't hunt for a toggle. CAVEAT: only fresh activations get it — pre-existing team users aren't backfilled until they re-activate.
- Popup License Key section: a SINGLE "Log out" button (full-width red). It wipes session storage and reloads to the activation screen. No in-place key swap — to change keys, log out + re-enter. The old Activate/Change-key + Clear two-button setup is GONE. The "Clear all data" button is REMOVED entirely.
- silentRevalidate (runs on popup open) branches on isTeamKey: team keys revalidate against /validate-team (with stored teamEmail); solo/pro against /validate. (Earlier flicker bug fixed — team keys were looping a reload through plain /validate.)

## Device Model (important — avoids lockouts)
- dlmDeviceId is a random UUID in chrome.storage.local, scoped to the CHROME PROFILE (not the physical machine). 2 devices per email.
- Different Chrome WINDOWS = same profile = same device. To simulate a 2nd dispatcher on one machine, use a different Chrome PROFILE + different email.
- Logout PRESERVES dlmDeviceId (targeted remove, never wipes it) — re-activating on the same machine reuses the slot. The old "Clear all data" button used to wipe it and burn a slot; that button is now removed.
- WELCOME PAGE GOTCHA: welcome.html MUST be opened as a real chrome-extension:// page (first-install flow or popup link). In a preview panel / file://, chrome.storage is undefined → getDeviceId() throws → the catch MISLABELS it as "Couldn't reach the server" even though no fetch happened.

---

## How the Extension Works
1. User uploads CSV history, activates Pro DB access, or (team) gets shared team data via the manager upload
2. content.js builds OD index, origin index, broker index
3. DAT load rows highlighted by tier:
   - Purple — same lane + same broker
   - Green — same lane, 3+ times
   - Yellow — same lane, 1-2 times
   - Blue — same origin city/state only
4. Clicking a row opens side panel with lane history + rate data
5. License validated against Railway /validate (or /validate-team for team keys) on page load
6. Stripe webhook → Railway → generates key → Brevo sends activation email

---

## Known Architecture Notes / Gotchas
- Two email injection systems in content.js — always check both when debugging email chip issues. Do not merge now.
- DAT renames CSS classes without warning — if extension stops working, check class names first
- chrome.storage tied to Chrome profile, not license key
- processRow is async, chip injection is sync — race condition possible
- Check chrome.storage for stuck booleans if UI breaks silently (e.g. useTeam, useDB, useCSV)
- Google Maps proxied server-side: backend /maps/directions (Neon-cached) + /maps/staticmap, key in Railway env GOOGLE_MAPS_KEY. Old client-side key deleted.
- DUAL renderSetupBody: one in content.js (inline panel) AND one in panel.js (detached panel) — Setup-tab UI changes may need BOTH.

---

## Email System
- License-key emails via BREVO (migrated from Resend — Resend had persistent DKIM failure)
- Retry logic: fail → wait → retry → on second failure, Bruno Telegram alert with customer email + key
- If email missing → check Railway logs for the send error

---

## Bruno Agent
- Hermes agent on Railway, xAI OAuth / grok-4.3. 12+ cron jobs (Morning Briefing, Railway Crash Alert, Chrome Web Store Monitor, stripe-webhook-monitor, dat-monitor, selector-monitor, webhook-monitor, Weekly GBrain Digest, etc.). Full current list lives in GBrain.
- DAT alert threshold: 50 failed rows before Telegram alert; dedup applied.
- NEVER change Bruno auth/provider/API key without explicit permission. HERMES_REF never below v2026.5.16.

---

## Gmail / OAuth Status
- gmail.send scope: in Google verification. 4/5 Verification Center items GREEN; only Privacy policy was red.
- Privacy policy content IS correct on live laneiq.org AND laneiq.org/privacy.html (both required clauses present).
- Likely block: Google was pointed at laneiq.org/#privacy (a fragment anchor reviewers can't reliably parse). Fix: point OAuth consent screen Privacy policy URL at the STANDALONE https://laneiq.org/privacy.html. Reply sent to Trust & Safety with the standalone URL.
- Do NOT re-add the Gmail signature feature until gmail.send is verified.
- Verification is driven by the Cloud Console Verification Center + email replies to Trust & Safety — not just resubmitting.

---

## Infrastructure Costs
- Railway ~$5/mo, Neon (Launch plan), Brevo free tier. Watch: GBrain autopilot daemon firing every 5 min kept Neon awake (cost leak) — noted.

---

## Deep history / session notes → GBrain
Per-session detail (what changed when, why) lives in GBrain, not here. Key slugs: laneiq-welcome-business-device-0628, laneiq-popup-cleanup-0628, laneiq-team-plan-layer4-packaged, laneiq-new-chat-briefing-0526.

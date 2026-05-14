# LaneIQ — DAT Lane Matcher Extension

## What This Project Is
A Chrome extension (Manifest V3) that highlights loads on the DAT load board that match the user's personal freight history. Built for Sunrise Logistics (Sacramento-based carrier). Being commercialized as **LaneIQ** — a SaaS product for carriers and dispatchers.

## Project Structure
```
LaneIQ project/
├── CLAUDE.md                          ← you are here
├── new/dat-matcher/                   ← active extension source
│   ├── manifest.json                  ← extension config, version 1.9
│   ├── popup.html / popup.js          ← settings UI (CSV upload, Gmail, template)
│   ├── content.js                     ← injected into DAT pages, does all matching
│   └── content.css                    ← sidebar + highlight styles
├── Sac_history_part1_clean.csv        ← 15,500+ lane records (user uploads these)
├── Sac_history_part2_clean.csv
├── Sacramento Loads. Sunrise Logistics. Original.xlsx
├── Sacramento history.xlsx
└── LaneIQ-v1.9.zip                    ← previous stable build (on Desktop)
```

## How the Extension Works
1. User uploads their CSV history files via the popup drop zone
2. `content.js` builds three lookup indexes in `chrome.storage`: OD index, origin-only index, broker index
3. When the DAT load board loads, content.js scans load rows and highlights matches by tier:
   - **Purple** — same lane + same broker (call immediately)
   - **Green** — same lane, ran 3+ times
   - **Yellow** — same lane, ran 1–2 times
   - **Blue** — same pickup city/state only
4. Clicking a highlighted load opens a side panel with history details + Gmail button
5. Gmail button opens rate confirmation search in the configured Gmail account

## Key Technical Details
- Manifest V3
- All data stays in browser (`chrome.storage.local`) — never sent to a server
- City matching uses fuzzy normalization (`norm()` function in content.js) — strips state abbreviations, numbers, punctuation before comparing
- Broker matching via `normBroker()` — strips generic words (logistics, freight, inc, llc) before comparing
- `WeakSet` (`processed`) prevents re-processing DOM nodes on DAT page updates
- Extension only runs on `*.dat.com` and `one.dat.com`

## Deployment
- To install locally: Chrome → Extensions → Developer mode → Load unpacked → select `new/dat-matcher/`
- To ship an update: zip the `dat-matcher/` folder → upload to Chrome Web Store (auto-pushes to all users within 24h)
- Chrome Developer account: $5 one-time fee

## Commercialization (LaneIQ)
- **Target customers:** solo dispatchers and small carriers on DAT
- **Pricing:** $49/mo solo · $149/mo team (5) · $399/mo enterprise
- **Distribution:** Chrome Web Store (public listing)
- **Payments:** Stripe
- **Planned backend:** Railway (for license key validation in Phase 2)
- **Phase 2 features:** Gmail API for in-panel PDF preview, cloud email parser, DAT Connect API integration

## Working Directory
All file edits default to: /Users/alex/Desktop/LaneIQ-project  2.0/new/dat-matcher/
Note: folder name has TWO spaces — "LaneIQ-project  2.0" not one.

## Open Questions / Known Issues
- DAT occasionally changes their DOM structure — content.js selectors may need updating when this happens
- Product name "LaneIQ" is provisional

## Working With Claude
- When DAT breaks something, describe what stopped working and paste the relevant DOM snippet if possible
- CSV format: expects columns for origin, destination, broker, rate, date — check `Sac_history_part1_clean.csv` as reference
- To test changes: reload the unpacked extension in Chrome, then refresh a DAT search results page

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore

## GBrain Search Guidance (configured by /sync-gbrain)
<!-- gstack-gbrain-search-guidance:start -->

GBrain is set up and synced on this machine. The agent should prefer gbrain
over Grep when the question is semantic or when you don't know the exact
identifier yet.

**This worktree is pinned to a worktree-scoped code source** via the
`.gbrain-source` file in the repo root (kubectl-style context). Any
`gbrain code-def`, `code-refs`, `code-callers`, `code-callees`, or `query`
call from anywhere under this worktree routes to that source by default —
no `--source` flag needed. Conductor sibling worktrees of the same repo
each have their own pin and their own indexed pages, so semantic results
match the actual code on disk in this worktree.

Two indexed corpora available via the `gbrain` CLI:
- This worktree's code (auto-pinned via `.gbrain-source`).
- `~/.gstack/` curated memory (registered as `gstack-brain-<user>` source via
  the existing federation pipeline).

Prefer gbrain when:
- "Where is X handled?" / semantic intent, no exact string yet:
    `gbrain search "<terms>"` or `gbrain query "<question>"`
- "Where is symbol Y defined?" / symbol-based code questions:
    `gbrain code-def <symbol>` or `gbrain code-refs <symbol>`
- "What calls Y?" / "What does Y depend on?":
    `gbrain code-callers <symbol>` / `gbrain code-callees <symbol>`
- "What did we decide last time?" / past plans, retros, learnings:
    `gbrain search "<terms>" --source gstack-brain-<user>`

Grep is still right for known exact strings, regex, multiline patterns, and
file globs. Run `/sync-gbrain` after meaningful code changes; for ongoing
auto-sync across all worktrees, run `gbrain autopilot --install` once per
machine — gbrain's daemon handles incremental refresh on a schedule.

<!-- gstack-gbrain-search-guidance:end -->

## Session Notes — May 13 2026
- panelPopped stuck state fixed — resets to false on every content script init
- DAT class rename handled — MutationObserver now checks both details-container and dat-load-details
- Silent license re-validation added to popup.js on every popup open
- Two email injection systems exist in content.js — injectEmailChip() at line ~351 and inline block at line ~1795 — always check both when debugging email chip issues
- Email chip cities fixed — getDetailCities called fresh on click, not captured at injection time
- View Route + RPM/Maps + Google Maps buttons now stacked in expanded DAT row
- Google Maps button includes deadhead (DAT search origin) + load origin + destination
- Stripe Customer Portal wired up — Manage Subscription button in popup
- v1.9 submitted to Chrome Store May 13 2026

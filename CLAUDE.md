# LaneIQ — DAT Lane Matcher Extension

## What This Project Is
A Chrome extension (Manifest V3) that highlights loads on the DAT load board that match the user's personal freight history. Built for Sunrise Logistics (Sacramento-based carrier). Being commercialized as **LaneIQ** — a SaaS product for carriers and dispatchers.

## Project Structure
```
LaneIQ project/
├── CLAUDE.md                          ← you are here
├── new/dat-matcher/                   ← active extension source
│   ├── manifest.json                  ← extension config, version 1.5
│   ├── popup.html / popup.js          ← settings UI (CSV upload, Gmail, template)
│   ├── content.js                     ← injected into DAT pages, does all matching
│   └── content.css                    ← sidebar + highlight styles
├── Sac_history_part1_clean.csv        ← 15,500+ lane records (user uploads these)
├── Sac_history_part2_clean.csv
├── Sacramento Loads. Sunrise Logistics. Original.xlsx
├── Sacramento history.xlsx
└── DAT-Lane-Matcher-Extension_LAST VERSION.zip  ← previous stable build
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
- Manifest V3, no background service worker needed
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

## Open Questions / Known Issues
- DAT occasionally changes their DOM structure — content.js selectors may need updating when this happens
- DAT ToS review needed before public commercialization (does selling a tool that runs on their page require permission?)
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

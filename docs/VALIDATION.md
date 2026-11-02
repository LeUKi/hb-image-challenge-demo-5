# Validation

Verified on 2026-11-02. These checks use local simulated AI and funds; they do not deploy a production Worker or publish the separately stored hongbao judge.

## Current checks

| Check | Result |
| --- | --- |
| `npm run check` | ESLint, TypeScript, 131 application tests in 14 files, client/Worker SSR builds, 76 official judge tests and official source check pass |
| `npm run smoke` | Built SSR HTML/styles, 1440/390/320px, readable text, file selection/removal, first-use guide, modal help and author setup pass |
| `node scripts/participant-smoke.mjs` | Official SDK across two virtual origins: existing 30 browser scenarios plus five multiple-reward scenarios pass, with no uncaught page/hydration errors |
| `node scripts/simulator-api-smoke.mjs` | Real product handler, official signed identities, local D1/R2, cumulative rewards and final settlement pass |
| `node scripts/simulator-smoke.mjs` | Actual official simulator and built player UI in Chrome pass, including two independently rewarded images, refresh restoration and final settlement |
| `npm run judge:page -- --shot` | Official SDK connection/request report passes; wide, phone and open-phone screenshots inspected |

Node 22.20.0, Vite 8.3.5 and Wrangler 4.156.0 were used. Vite still emits its upstream CSS sourcemap warning; actual built HTML, linked CSS and rendered layouts were checked. Expected 409 duplicate responses and the deliberate dropped-like-response scenario produce network errors, not uncaught browser errors.

## Multiple rewards and final payment

The official platform contract was verified against `LeUKi/hb` main `09477c538350c4388a87a552ad12bf69c092bf1b`: repeated `add` operations accumulate a player's pending reward; each player settles once. Settled players cannot submit again. Deadline, activity end and full pool allocation also settle outstanding players. This implementation provides multiple independently rewarded images followed by one payment, rather than claiming the platform supports repeated payments followed by more participation.

- New author forms default `multiReward` to true. Missing parameters and old frozen records default to false, retaining the prior single-reward behavior and v1 private view. All 44 original judge tests remain; new cases bring the total to 76 tests and 97 judgments.
- Each accepted image, including a zero-reward miss, is recorded once in the private v2 results ledger. The trusted used-ID list rejects a replay before making a Worker request. Fixed or interval-mapped dynamic rewards apply to each image independently, capped to the remaining pool. The player's platform pending amount remains authoritative.
- The authenticated judge-only result response freezes the selected mode and reports actual remaining uploads, all ready result IDs and whether processing is ongoing. Queries are bound to the signed packet and requested numeric player, with at most ten results. Failed and duplicate uploads count toward the attempt limit.
- Automatic exhaustion settlement requires no remaining uploads, no processing images, and every ready result already accepted. Submitting the highest attempt number before an earlier ready image does not forfeit that older result. A last miss preserves prior pending winnings. Pool-tail allocation and the full ten-result ledger are covered.
- Exact input `结算` settles using trusted platform pending without requesting the image service. It also provides an exit when the last upload failed or was a duplicate. No uploaded images is a valid zero-reward final settlement. A confirmed settlement ends participation and forfeits unused attempts/unsubmitted scores.
- During accumulation, a gallery grant stays in judge-private state, surviving later misses. It appears in the player's private view only on settlement; activity end uses the existing trusted ended-state permission. Public activity/gallery data does not expose the grant or numeric player identity.
- The frontend restores every accepted image and its actual reward after reload, including images older than the latest result. It shows cumulative pending separately from paid claims. The common image viewer shows `本图已计奖` and that image's reward; it offers no duplicate claim action. Only final claimed/settled/ended status closes participation.
- Settlement uses a compact confirmation modal. Its permission depends on verified platform identity/status, busy state and uncertainty, independently of gallery loading. A browser test keeps `/api/gallery` unresolved while settling exactly once. An uncertain settlement persists across reload and only reads personal records; no AI or money operation is automatically retried. Changing numeric accounts clears the old balance/modal even when both accounts have the same display name.

## Official simulator evidence

`npm run simulator` builds the real SSR application and starts the unmodified official kit, a local-only activity adapter and Wrangler's local D1/R2 bindings. The production API handler validates page/judge tokens signed by the official simulator. AI is an explicit local substitute; remote AI bindings and secret files are absent. The adapter supplies the public activity endpoint the kit does not provide, using trusted local state; it is not bundled into production.

The API smoke runs against a fresh seeded simulator:

1. Six initially visible shared misses include a harmless NSFW-mask example; authenticated image reads return real PNG bytes from private local R2. Like batching stores 300 taps once, enforces the same-player 30-second gate and restores a lost receipt without another write.
2. A 35% image restores before submission with four uploads remaining. Accepting it awards nothing and does not settle or grant full-gallery access.
3. Another numeric player submits identical bytes, consumes their final attempt and receives a duplicate error with zero remaining. Replaying that idempotency key consumes no further attempt and leaks neither original ID nor score. No duplicate inference occurs.
4. A 75% image adds 5.50 simulated LDC; a 91% image adds nothing; a 72% image independently adds 2.80. The account stays open with 8.30 pending. Replaying the first accepted result adds nothing. The signed/private state restores the complete ledger while other players' passing works remain hidden.
5. Explicit `结算` pays 8.30 simulated LDC once. A second settlement is rejected by the platform. Only now does the private gallery grant appear, unlocking all twelve shared records and permitted original images; it cannot be borrowed by another numeric identity. Page JWTs cannot call the judge-only endpoint. Personal history includes image judgments, the replay and final settlement.

The separate browser smoke starts from another fresh simulator. It drives the real file chooser, uploads distinct image bytes through the product handler, opens the shared viewer, accumulates the two rewards, reloads while pending, inspects an older already-awarded image, and confirms one final 8.30 payment. Upload remains closed after a further reload. A different player's new image then appears automatically, bringing the gallery to thirteen records without moving existing columns or the visible reading anchor.

The same run checks first-use guidance, anonymous cards, green/white scores, NSFW single/global preferences, all modal dismissal methods, scroll locking, mobile widths, reduced motion, five optimistic likes persisted in one scheduled batch, and activity-end visibility. The final combined like/gallery refresh observed complete visibility after about 30.7 seconds; that is polling evidence, not an instant push guarantee. Passive visible polling remains 60 seconds.

Local ignored screenshots under `shots/` include `simulator-accumulated-reward.png`, `participant-multi-settle-320.png`, `participant-multi-settle-1440.png` and the official simulator desktop/mobile states. The default kit `--shot` images stop at its identity-consent dialog; consent and all subsequent interactions are covered by the full browser smoke.

## Preserved application boundaries

- Workers AI uses Clef Flash. Route and request-body model names share one constant; new scores record their model. Historic missing model metadata remains Clef Omni without rescoring. Matching and NSFW are separate questions in one inference. Missing/invalid safety scores remain unknown and covered; no generated explanations or accuracy claims are fabricated.
- Uploads atomically reserve at most ten attempts per packet/player, freeze rules, consume one-use nonce and bind idempotency keys to exact file hashes. R2 writing and inference start in parallel. Failure preserves conservative quota accounting and never produces a redeemable fake result.
- Packet-wide SHA-256 deduplication applies across numeric players. Duplicate bytes consume one attempt but do not repeat inference, R2 writing or gallery insertion. Confirmed failure releases only its own hash claim. Re-encoding/cropping changes bytes and is not claimed to be detected.
- Images remain private R2 objects. Gallery/list/image permissions agree; legacy private uploads stay private. The frontend uses authenticated fetches and local blob image URLs, with no token query strings or public bucket requirement. Anonymous gallery DTOs contain no nickname/avatar/numeric user ID.
- Likes remain optimistic and actor-scoped. A fixed first-tap 30-second deadline does not slide with continued clicks; bounded batches share gallery requests, idempotent receipts and an atomic per-player cross-tab gate. Likes do not affect order, scores, rewards or upload quota.
- The player surface is a compact single page, without top navigation, using the existing Modal/Gallery and Motion transitions. Body text and controls stay at least 16px. SSR stores remain request-isolated. Old single-reward flows, private actor switching, late responses and unresolved submissions remain covered.

## Activation and limits

This change needs both an updated Worker and the new `judge/judge.js` published on the hongbao site. GitHub push and Worker deployment do not update that separately stored judge. New judge fingerprint: `32c1e803ba400536736541efeb7a5f8463cf6ffc60d7100a91d434cf1391d75c`.

No new migration is added for multiple rewards. Older services still need existing migrations through `0004_image_dedup.sql`; the normal deploy command includes migrations. The template retains author-owned AI/R2/D1, one ordinary `OWNER_ID` variable, `workers_dev: true` and `preview_urls: false`.

These checks do not measure actual Workers AI scoring quality, latency, Neuron use or Worker CPU, and do not establish a new Cloudflare account's deployment/resource activation or production payment behavior. All funds and scores used here are local simulation data.

## Reproduce

```sh
npm ci
npm run check
npm run simulator:start
# Against a fresh seeded simulator, from another terminal:
node scripts/simulator-api-smoke.mjs
# Restart the simulator to reset state before the next command:
node scripts/simulator-smoke.mjs
# Stateless browser/SSR checks:
node scripts/participant-smoke.mjs
npm run smoke
npm run judge:page -- --shot
```

`npm run simulator` builds before starting; `simulator:start` reuses the latest build. Restart after stateful tests for a fresh player experience. The default URL is `http://127.0.0.1:8860/?layout=multi&players=3&accept=1&open=1`. `SIMULATOR_PORT` changes the kit's host/page ports; 5173/5175 must also be free. Tests use local Chrome; `CHROME_PATH`, `BASE_URL`, `SIMULATOR_URL` and `SERVICE_URL` provide the corresponding overrides. Stateful scripts reject non-local HTTP targets.

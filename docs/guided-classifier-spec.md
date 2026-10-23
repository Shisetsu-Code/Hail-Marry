# Guided classifier

User-authorized implementation in Hail-Marry, 2026-10-23. Copy the tracked Hybrid Cloud Fuzzer source at 045d403e06f8255d92f1e393a755edfeed5da0c3 into an inert upstream directory, reusing its validators, visual matching and game inspection. Existing production Cloudflare bindings and queues are outside this deployment.

## Operator behavior

- Key 1: mark normal Spin; save its reference without spinning.
- Key 2: mark an antebet activator, then execute activator followed by the previously marked normal Spin. Require that Spin first. Revalidate Spin after activating ante; an unresolved intermediate screen remains pending and never triggers a guessed spin.
- Key 3: mark/open a purchase menu. Permit multiple menu controls and nested menus.
- Key 4: mark/execute a direct purchase or purchase option. Preserve the distinction from menu opening.
- Key 5: mark the only Spin and finish that game's capture without executing it. Reject contradictory existing purchase/ante marks rather than erase them.
- Q: mark/execute an initial Continue and capture the next screen.
- Additional explicit roles for subsequent screens: option, confirm, cancel, back, bet and continue. A mark-only checkbox permits collecting multiple controls before acting.
- Bind every mark and action to game, session, immutable screenshot, revision, SHA-256, normalized point, source screen and incoming route. Do not reuse coordinates across games or stale sessions.
- The exported graph includes all marked branches, nested options, confirms, cancels and unknown/pending screens. Never label dispatch as a proven round/purchase completion.
- UI Spanish, keyboard shortcuts for mode selection and keyboard-accessible buttons, pointer placement of coordinates, clear selected mode, visible numbered marks, persistent route/action list, per-game progress, undo/delete only unexecuted marks, export, refresh, finish/next and reopen known screenshots for inspection.
- Other games continue loading independently. Inputs within one game are serialized and idempotent.

## Delivery

Run Chromium and a small Node HTTP server on a GitHub Actions runner. Expose the interface with a temporary Cloudflare Quick Tunnel; protect all data and inputs with a random bearer key whose SHA-256 alone is committed. Do not log the raw key. Save evidence and records to a separate Hail-Marry data branch using the runner's repository token. No Cloudflare production credentials or existing queues are needed. Provide the running URL and the runner's lifetime. Browser session memory is temporary; the saved graph survives and unresolved purchases are never automatically replayed on restart.

## Shared API contract

`GET /api/state` returns `{schemaVersion:1,runId,revision,games:[Game],persistence:{...}}`.
`Game` contains `{id,title,provider,status,busy,error,finished,spinControlId,screen,controls,actions,screens}`; `screen` may be null while loading.
`Screen` contains `{id,gameId,sessionId,revision,imageSha256,imageUrl,width,height,createdAt,parentScreenId,viaControlId,route:[controlId],candidates:[]}`. `screens` is the compact history.
`Control` contains `{id,gameId,screenId,sessionId,mode,role,label,x,y,createdAt,executed}`. `mode` is one of `spin,antebet,menu,buy,spin_only,continue,option,confirm,cancel,back,bet`.
`POST /api/games/:id/mark` accepts `{requestId,screenId,revision,imageSha256,mode,x,y,label?,execute:true|false}`. All screen identity fields required. Returns `{game,control,action?}` (or 202 while processing, UI polls state).
`POST /api/games/:id/action` accepts the same identity plus `{requestId,controlId}` and executes an existing compatible control.
`POST /api/games/:id/refresh` and `/finish` accept `{requestId,screenId,revision,imageSha256}`. Finish never performs input.
`DELETE /api/games/:id/controls/:controlId` accepts `{requestId,screenId,revision,imageSha256}`; only unexecuted, unreferenced marks can be removed.
`GET /api/export` exports the complete versioned graph, including pending branches. `GET /api/images/:filename` serves authenticated immutable JPEGs.
Every API call including images requires `Authorization: Bearer <key>`. UI obtains it from `#key=...`, removes the fragment and stores it in sessionStorage; images use authenticated fetch + object URLs. A key entry form handles a missing key. No hardcoded credentials in UI.

## Browser runner contract

`classifier/runner.mjs` exports `BrowserRunner` with constructor `({browser,targets,initialWaitMs=60000,settleMs=1500,localFixture=false})`.
`open(gameId)` initializes an isolated context and returns `Observation` after the initial wait; independent calls may run concurrently.
`observe(gameId)` returns `Observation={image:Buffer,imageSha256,width,height,sessionId,at,candidates:[],state:{...}}` (JPEG bytes, normalized candidate geometry).
`perform(gameId,{control,reference,scope='scene'})` checks session and viewport, compares the reference image against a fresh screenshot, checks any available DOM hit target, performs one click, waits settleMs, then returns `{before,after,inputDispatched,confirmation:{status,reason},network:[]}`. `reference={imagePath,sessionId,width,height}`; scope target permits only the explicitly linked Spin after ante. Do not claim confirmed effect solely from changed pixels.
`close()` disposes contexts. Module has no server or CLI side effects. No OCR/model dependency on the manual path. Demo URLs must pass the existing demoMode/demoLaunchUrl contract; localhost is allowed only with localFixture.

## Failure cases to prove

Stale hash/revision/session rejects before input; duplicate request IDs never dispatch twice; two games do not share coordinates; 5 finishes without input; 2 requires Spin and revalidates after ante; menu branches remain distinct; Q captures the next state; confirm/cancel routes remain explicit; only authorized demo targets open; unavailable image or persistence errors never masquerade as saved work.

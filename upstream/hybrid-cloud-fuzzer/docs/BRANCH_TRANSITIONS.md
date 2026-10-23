# Reviewed batches and automatic branch transitions

GPT reviews batches of images and identifies menus, purchase options and choices.
The browser executor replays those reviewed paths in fresh DEMO contexts. It does
not need a classifier response for every known intermediate screen.

## Changes

- Reviewed Menu controls are eligible. Settings, autoplay and ordinary spin
  controls remain outside the coordinated exploration policy.
- Explicit loading states are awaited for every provider. A changed control is
  resolved again after cookie/age cleanup, before its click.
- The executor handles a single unambiguous semantic confirmation for a reviewed
  purchase, bonus start, result collection and the return to stable idle. It
  watches active rounds instead of taking the final image after 850 milliseconds.
- The action's network recorder stays open through these transitions. An observed
  request is evidence of a request, never evidence that the round finished.
- Opaque UNKNOWN screens can replay reviewed coordinates when their source has an
  immutable JPEG. The runner verifies its classification revision and image hash,
  then compares both the current scene and the target area. A changed image is
  captured for classification; the unmatched action is not added to replay ancestry.
- Up to eight different games overlap their loading/bonus waits per executor by
  default. Each game retains its own classification barrier and server execution
  ownership. Provider permits and start spacing still apply.
- Concurrent journal writes are serialized. An interrupted action remains
  uncertain; restarting the runner never silently repeats it.
- Provider capacity is checked before claiming an execution. Busy games are
  deferred without a blocked journal entry, and providers are selected fairly so
  a backlog from one provider does not occupy every execution slot.

## Running

Use the existing REVIEW and INGEST credentials in private environment variables:

```sh
node local/round-runner.mjs --manifest=/private/batch.json --out=/private/outbox \
  --watch --limit=32 --concurrency=8 --interval-ms=5000
```

The manifest must contain the actual existing runId and explicitly approved DEMO
game URLs. `--limit` is the number of different games selected per poll;
`--concurrency` controls simultaneously executing games (1–32). Cookie and age
handling remains repeatable per context; `--confirm-adult` uses the operator's
existing authorization.

## Outcomes and limits

`metadata.roundOutcome` distinguishes `completed`, `next_screen`, `needs_review`
and `timeout`. `metadata.transitions` records observed states, waits and automatic
clicks. A terminal branch requires both a witnessed game request and an observed
round/result followed by stable idle. This is branch completion, not proof that
every option in the game has been explored.

Only adapters with an observed semantic phase can automatically follow a running
bonus. Generic HTML controls and the Pragmatic adapter supply these phases where
recognized. An opaque canvas with an unknown choice, ambiguous control or unknown
bonus state returns to GPT's image batch. It is never declared complete merely
because a timeout expired, a click occurred or the queue is empty.

The local default active-round timeout is three minutes; the GitHub continuation
workflow allows ten minutes so long bonuses can drain. Repeated unchanged Continue
prompts are clicked once and returned for review, not hammered. Expired sessions
and HTTP failures are diagnosed separately. The executor never reloads after an
uncertain purchase to buy it again.

## Cloud rollout

Cloudflare is the coordinator; browsers execute on GitHub runners or an explicitly
started collector. Updating this repository does not update an already running
Node process. Hybrid-actions catalogue jobs pin their engine commit and are a
separate capture-only workflow. They must not be described as purchase explorers.
Use an updated branch runner for continuation and verify its exact engine SHA.

## Verification

`npm run check`, `npm test`, and
`INTEGRATION_BROWSER=1 node --test test/browser-fixture.test.js` cover the branch
planner, loading waits, concurrency, immutable replay images, durable ownership,
and a real Chromium fixture exercising purchase confirmation through collection
with exactly one action request. Mocked fixture success does not establish support
for every live provider.

Live evidence and limits: [23 October pilot](LIVE_PILOT_2026_10_23.md).

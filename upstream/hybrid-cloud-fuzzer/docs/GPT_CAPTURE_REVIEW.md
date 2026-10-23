# Asynchronous GPT capture review — same batch

The GitHub-hosted runner visits every selected game once, using its persisted
initial wait time, saves the private image and complete item metadata, then moves
to the next game. It never polls GPT or holds a browser for a later reply.
Pending quality images do not enter the valid classification queue.

GPT can respond hours or days later: MCP capture_reviews lists the backlog,
capture_review_image loads a particular image, and capture_review_action records
wait, normalized cleanup click, or approve against its exact revision/hash.
initialWaitMs optionally changes this game's future launch delay; default 25000.

Approval immediately ingests the saved exact JPEG into the valid queue, even
when no runner is alive. It does not classify controls or execute gameplay.
Repeated approval is idempotent. Existing accepted items are never replaced.

Wait/click instructions remain persisted until the next MANUAL execution of the
same runId. The runner skips games still awaiting GPT, claims each decided
operation once for a fresh browser, replays that game's recorded cleanup path,
executes the next step, saves a new pending image and proceeds to other games.
Reopened click screens are compared against the exact saved game image and
point area (no OCR/model). A mismatch produces a fresh pending image instead of
clicking stale coordinates. The actual verified launch path accompanies it.

A claimed operation is not redelivered after uncertain execution. Its 15-minute
execution lease only protects a running operation; it is NOT a deadline for GPT.
GPT may replace an expired uncertain operation against the still-current source.
No new batch, recurrence, purchases, spins or bets are authorized by this loop.

Storage reuses migration 0006's capture_reviews/capture_timings and private R2.
Image metadata is stored alongside its JPEG. Approval independently checks the
run/provider/game/shot/revision/hash in the ordinary ingestion gate. Legacy OCR
producers remain compatible. No new secrets, bindings or migrations are needed.

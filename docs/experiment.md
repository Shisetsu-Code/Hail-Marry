# Dynamic control experiment

The user approved implementing and testing this prototype on GitHub before moving it to a PC or worker. Hail-Marry was empty. All defaults below are implementation choices within that experiment.

## Intended behavior

One Chromium instance hosts isolated concurrent demo contexts. Each page gets 60 seconds after navigation starts before any input. A bounded intro resolver reads visible DOM text, accessible engine labels and screenshot OCR; Laya classifies this text. It can choose only an explicit continuation prompt already located on the current screen. After input the orchestrator waits 1.5 seconds, observes twice 300 ms apart and records state changes. It does not wait for all animation to stop.

The scanner is read-only. It reports current control geometry, evidence source, visibility, enabled state and input availability separately. Controls which appear/disappear/move/change state between samples are retained as transient evidence. Two samples reduce transient noise; they do not prove continuous persistence, and cannot reveal inaccessible private scene trees. Canvas surfaces themselves are never buttons.

OCR provides text regions, not proof of button availability. Laya is a text decision model, not OCR. Model startup/inference failures are explicit. A click receipt records input dispatch; subsequent state changes are separate evidence and never a claimed wager result.

## Implementation plan

1. Detector and bounded DOM/engine probes, with regression tests for flicker and occlusion.
2. Pinned CPU Laya service and typed client with timeouts, plus real inference smoke test.
3. OCR, finite intro resolver, action/observation loop and concurrent runner with evidence output.
4. Controlled DOM/Canvas fixture with hidden, disabled, blocked and transient controls; verify after-action discovery and OCR introduction handling.
5. GitHub Actions installs Node/Python/Chromium/Tesseract/Laya, runs tests and public demo probes, and uploads screenshots/JSON/timing evidence. Public demo loading failures are reported separately from controlled test failures.

## Checks that decide portability

- Confirm dependencies and model load on a standard CPU GitHub runner.
- Measure Laya inference and observation latency rather than assume milliseconds.
- Confirm initial delay and post-action delay in emitted timestamps.
- Confirm millisecond flicker is not promoted to an available stable control in the controlled test.
- Confirm actual public demo coverage, retaining unknown state when the engine is private.
- Confirm all contexts close on errors/timeouts and no background runner survives.

No production migration is part of this experiment. A GitHub Actions runner can host a browser and local Python model; a Cloudflare edge Worker alone is a different execution environment.

# Hail-Marry

Prototype requested by Nahuel: dynamic game-control detection, tested first on GitHub Actions.

## Accepted experiment

- Let each demo load for 60 seconds before the first observation.
- Extract text through the DOM, with OCR for rendered text, then use Laya to interpret introduction prompts.
- After each permitted action, wait 1–2 seconds and compare two control observations 300 ms apart.
- Keep transient controls separate; an input flag is not proof that a game action succeeded.
- Process independent demo sessions concurrently and save screenshots, timings and structured evidence.
- Run a controlled fixture suite plus public demo probes. Production portability is evaluated from those results.

The implementation and GitHub Actions test results will be added next.

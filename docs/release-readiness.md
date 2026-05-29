# Release-Readiness Checklist — v1.0.0

Complete every item before tagging `v1.0.0` and publishing to npm `latest`.

> **Nightly gate note:** The `publish.yml` workflow enforces the two-consecutive-nights
> check programmatically. However, the gate can be bypassed for the very first publish
> (before nightly history exists) by setting the `SKIP_NIGHTLY_GATE_FIRST_RELEASE`
> repository secret to `'true'`. This escape hatch is for **v1.0.0 only**. Starting
> from v1.0.1 the secret MUST be removed or unset; every subsequent publish must pass
> the nightly gate organically.

---

## Automated checks (run locally before tagging)

- [ ] `npm test` passes — all Node contract tests green.
- [ ] `uv run pytest -q` passes — Python tests green; coverage ≥ 70 %.
- [ ] All `requires_live_key=false` scenarios green locally:

  ```bash
  OPENCODE_MOCK_MODE=1 PYTHONPATH=tests/_mock_openhands_sdk \
    node bin/ad-evals.js run tests/harness-scenarios/packages
  ```

  Expected: 3/3 PASS, exit 0.

- [ ] `npm run lint:md` clean — no markdown lint errors.
- [ ] `npm run bench:spawn-cost` passes — p95 spawn cost within budget
  (baseline from phase 07; ±10 % acceptable).
- [ ] Shell syntax check: `bash -n bin/eval-harness-init.sh` exits 0.
- [ ] Workflow YAML parses:

  ```bash
  node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/publish.yml','utf8'))"
  node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/nightly-scenarios.yml','utf8'))"
  ```

  Both must exit 0.

- [ ] No secrets in committed source:

  ```bash
  git grep -nE 'api_key|API_KEY|sk_live|ak_live' \
    -- ':(exclude)plans/' ':(exclude)spikes/' \
       ':(exclude)*.test.*' ':(exclude)CHANGELOG.md' \
       ':(exclude)docs/migration-v0-to-v1.md'
  ```

  Must return zero matches.

## Human pre-checks

- [ ] `docs/migration-v0-to-v1.md` exists and is current.
- [ ] `CHANGELOG.md` contains a `## [1.0.0]` entry with today's date.
- [ ] `package.json` `version` field matches the intended tag (e.g. `1.0.0`).
- [ ] `package-lock.json` version field matches `package.json`.
- [ ] Nightly workflow (`nightly-scenarios.yml`) has been green for
  **two consecutive nights** on `main`.
  - Check: `gh run list --workflow nightly-scenarios.yml --branch main --limit 5`
  - If this is the very first publish (no nightly history yet), set repository
    secret `SKIP_NIGHTLY_GATE_FIRST_RELEASE=true` and note it here. Remove the
    secret after v1.0.0 is published.
- [ ] No open P0/P1 issues on the `vd-2174` Linear sub-issues.

## After tagging

Push the tag to trigger the publish workflow:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The `publish.yml` workflow will:

1. Run `npm test`, `pytest`, and all mock-mode scenarios.
2. Verify two consecutive nightly-green runs on `main` (or skip if
   `SKIP_NIGHTLY_GATE_FIRST_RELEASE` is set).
3. Publish to npm `latest` with provenance.

Monitor the Actions run at:
`https://github.com/accelerate-data/promptfoo-eval-harness/actions`

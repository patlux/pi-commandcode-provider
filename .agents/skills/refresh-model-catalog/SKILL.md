---
name: refresh-model-catalog
description: Use when adding or removing Command Code models, refreshing the model catalog snapshot (image, reasoning, effort, output-limit metadata), updating display pricing, or refreshing test fixtures in pi-commandcode-provider.
---

# Refresh Model Catalog

Use this skill whenever the Command Code model catalog changes: new or retired models, changed reasoning efforts, output limits, or pricing. All commands run from the repository root and work on Windows and Linux.

## Core rules

- Do not commit, tag, push, or publish unless the user explicitly asks in the current conversation.
- Pricing is manually reviewed: temporary promotions and long-context tiers require explicit review of the official pricing page. Never copy prices blindly from the API.
- Keep the change focused: one refresh per PR, no unrelated refactors.
- Follow [CONTRIBUTING.md](../../../CONTRIBUTING.md) for commit message rules.

## Workflow

### 1. Detect drift

```sh
npm run check:commandcode-catalog
```

This compares the repository snapshot against the latest published `command-code` npm package and reports added/removed models, changed efforts, and version drift. Use the report to scope the work.

### 2. Sync static model metadata

```sh
npm run sync:commandcode-catalog
```

Regenerates `src/commandcode-catalog.ts` and bumps the documented CLI version in `README.md`. Review the diff; the catalog also lists reasoning models without selectable efforts.

Never add efforts to the generated file by hand. Manual effort policy for reasoning models that upstream ships without levels lives in `src/commandcode-catalog-overrides.ts` and is merged at load time. The sync drops an override itself once upstream publishes its own levels. It parses only the `MODEL_EFFORT_OVERRIDES` object literal and preserves neighboring declarations. Keep shared rationale above the declaration; review entry-specific comments after pruning because they may describe removed entries.

### 3. Update display pricing (manual review)

Fetch <https://commandcode.ai/docs/resources/pricing-limits> and compare against `src/pricing.ts`:

- Add entries for new models and remove entries for retired models. Missing models silently display zero cost, so `MODEL_COSTS` must cover the full catalog.
- The pricing page's "Cache Read"/"Cache Write" columns map to `cacheRead`/`cacheWrite`; a "—" column means `0`.
- Update `PRICING_LAST_VERIFIED` to today's date.
- Add or update `TEMPORARY_PRICING` entries for promotions with an end date, so tests fail when they expire.

### 4. Refresh the test fixtures

```sh
node .agents/skills/refresh-model-catalog/scripts/refresh-model-ids.mjs
npx tsx .agents/skills/refresh-model-catalog/scripts/sync-pricing-fixture.ts
```

The first script snapshots the live model-id list into `tests/fixtures/commandcode-model-ids.json`; the second regenerates `tests/fixtures/commandcode-pricing.json` from `MODEL_COSTS`. The pricing test fails until `MODEL_COSTS` matches the catalog snapshot exactly.

### 5. Update test expectations

Adjust the model-specific assertions that the refresh invalidated, typically in:

- `tests/test-pricing.ts`: fixture date assertions, the `freeModels` set, and per-model rate assertions.
- `tests/test-models.ts`: image/reasoning/effort/output-limit assertions and catalog entry counts.

Do not weaken assertions to make them pass; update them to the verified upstream values.

### 6. Validate

```sh
npm run test:models
npm run test:pricing
npm run typecheck
npm run format:check
git diff --check
```

Run the full `npm test` before reporting the work as done when the environment allows it.

### 7. Document

Add entries to the `Unreleased` section of `CHANGELOG.md` covering new/retired models, effort changes, and pricing refreshes.

# oagen-plugins

Language plugins for [oagen](../oagen); generates SDK code from OpenAPI specs.

## Supported languages

| Language        | Emitter       | Extractor       | Smoke Test          |
| --------------- | ------------- | --------------- | ------------------- |
| Node/TypeScript | `nodeEmitter` | `nodeExtractor` | `smoke/sdk-node.ts` |

## Quickstart

```bash
npm install
npm test          # run emitter unit tests
npm run typecheck # verify types
```

## Workflows

### Setting up a new language

```bash
# 1. Extract the live SDK's public API surface
npm run sdk:extract:node

# 2. Generate and integrate
npm run sdk:generate:node

# 3. Verify
npm run sdk:verify:node
```

### Ongoing spec updates

```bash
# 1. Incremental generation from spec changes
npm run sdk:diff:node

# 2. Verify
npm run sdk:verify:node
```

### After manually editing the live SDK

If you rename methods, add exports, or change the live SDK's public API by hand:

```bash
# 1. Re-extract the baseline so the overlay stays in sync
npm run sdk:extract:node

# 2. Regenerate (the overlay will use the updated baseline)
npm run sdk:generate:node
```

## Commands

All SDK commands are in `package.json` under `scripts`. Replace `node` with the target language for other SDKs.

### `npm run sdk:extract:node`

```bash
oagen extract --lang node --sdk-path ../backend/workos-node --output ./sdk-node-surface.json
```

Extracts the live SDK's public API surface (classes, interfaces, type aliases, enums, exports) into `sdk-node-surface.json`. This is **per-language** — each language has its own extractor that understands the language's public surface conventions (TypeScript exports, Ruby public methods, Python `__all__`, etc.).

**When to run:** Before the first generation, and whenever the live SDK's public API changes (hand-written additions, renamed methods, new exports).

### `npm run sdk:generate:node`

```bash
oagen generate --lang node --output ./sdk --namespace workos \
  --spec ../openapi-spec/spec/open-api-spec.yaml \
  --api-surface ./sdk-node-surface.json \
  --target ../backend/workos-node
```

Full generation from the OpenAPI spec. Produces a standalone SDK at `./sdk/` and integrates new interface, serializer, enum, and fixture files into the live SDK at `--target`.

**What gets integrated:** New type definitions (interfaces, serializers, enums, fixtures) that don't already exist in the live SDK. Existing files are never modified.

**What stays standalone:** Resource classes, tests, client, barrel exports, error classes, and common utilities remain in `./sdk/` only. The developer wires up resource classes and client accessors manually.

**When to run:** First-time setup, or when you want a full regeneration (e.g., after a major spec overhaul).

### `npm run sdk:diff:node`

```bash
oagen diff --old ./sdk/spec-snapshot.yaml --new ../openapi-spec/spec/open-api-spec.yaml \
  --lang node --output ./sdk \
  --target ../backend/workos-node \
  --api-surface ./sdk-node-surface.json
```

Incremental generation — compares the previous spec snapshot against the current spec and only regenerates files affected by the changes.

**Requires** a prior `sdk:generate:node` run which creates `./sdk/spec-snapshot.yaml`.

**When to run:** After the OpenAPI spec is updated (new endpoints, changed models, etc.).

### `npm run sdk:verify:node`

```bash
oagen verify --lang node --output ./sdk \
  --spec ../openapi-spec/spec/open-api-spec.yaml \
  --api-surface ./sdk-node-surface.json
```

Runs compat verification (checks that generated types preserve the live SDK's public API surface) and smoke tests (checks wire-level HTTP behavior).

**When to run:** After any generation to verify correctness, or in CI.

## Adding a new language

Use the oagen skills:

```bash
claude --plugin-dir ../oagen
/oagen:generate-sdk <language>
```

This orchestrates: emitter scaffolding → extractor → compat verification → smoke tests → integration.

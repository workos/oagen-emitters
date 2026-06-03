# oagen-emitters

Language emitters, extractors, smoke runners, and documentation snippet emitters for [oagen](../oagen). This package is a **plugin library** -- it provides SDK generation and call-site snippet rendering capabilities but does not own the consumer config. The canonical generation policy lives in the spec-consuming project (e.g. https://github.com/workos/openapi-spec/blob/main/src/policy.ts).

## Plugin export

The primary export for consumers is the `workosEmittersPlugin` bundle:

```ts
import { workosEmittersPlugin } from "@workos/oagen-emitters";

const config: OagenConfig = {
  ...workosEmittersPlugin,
  // consumer-owned spec policy goes here
  docUrl: "https://workos.com/docs",
  operationHints,
  mountRules,
  modelHints,
};
```

The plugin bundle registers all emitters, extractors, and smoke runners provided by this package.

## Snippet emitters

Snippet emitters render one short, runnable call-site sample per resolved SDK operation. They are intentionally a separate runtime from the full SDK emitters: snippet emitters do not generate models, clients, or tests, and they are not invoked by `oagen generate`. Consumers import them directly and write the results wherever they need.

The framework plumbing lives upstream in `@workos/oagen`:

```ts
import {
  parseSpec,
  resolveOperations,
  runSnippetEmitters,
  snippetResultsToFiles,
} from "@workos/oagen";
import {
  operationHints,
  mountRules,
  modelHints,
  schemaNameTransform,
  transformSpec,
  nestjsOperationIdTransform,
} from "@workos/openapi-spec/policy";
import { workosSnippetsPlugin } from "@workos/oagen-emitters";

const spec = await parseSpec("spec/open-api-spec.yaml", {
  operationIdTransform: nestjsOperationIdTransform,
  schemaNameTransform,
  transformSpec,
});
const ctx = {
  namespace: "workos",
  namespacePascal: "WorkOS",
  spec,
  modelHints,
  resolvedOperations: resolveOperations(spec, operationHints, mountRules),
};

const results = runSnippetEmitters(workosSnippetsPlugin.snippets, ctx);
// results[i] = { language, fileExtension, operationId, mountTarget, methodName, content }

// Optional: write `<outputDir>/<language>/<methodName>-request.<ext>` files.
const files = snippetResultsToFiles(results, "snippets");
```

Each snippet emitter reuses its sibling SDK emitter's naming helpers (`src/<lang>/naming.ts`), so generated samples stay in lockstep with the SDK they document. Method names, mount-target casing, parameter names, and reserved-word handling all match what the real SDK exposes.

When adding a snippet emitter for a new language, mirror an existing one (`src/snippets/python.ts` is the smallest reference) and add focused tests in `test/snippets/<lang>.test.ts` using the shared scaffolding in `test/snippets/_helpers.ts`.

## Development

```bash
npm install
npm test          # run emitter unit tests
npm run typecheck # verify types
npm run build     # build dist/ output
```

### Using a local `oagen` checkout

```bash
npm run oagen:use:local     # build and link ../oagen
npm run oagen:build:local   # rebuild ../oagen after changes
npm run oagen:use:published # switch back to published package
npm run git:push -- <args>  # push with published oagen, then restore local link
```

## Emitter development

Each emitter lives in `src/<lang>/` and implements the `Emitter` interface from `@workos/oagen`. Extractors live in `src/compat/extractors/<lang>.ts`. Smoke runners live in `smoke/sdk-<lang>.ts`.

When building or changing an emitter:

1. Implement or update the emitter code in `src/<lang>/`
2. Implement or update the extractor in `src/compat/extractors/` if needed
3. Implement or update the smoke runner in `smoke/` if needed
4. Export the emitter through `src/plugin.ts` and `src/index.ts`
5. Run `npm test` and `npm run typecheck`
6. Switch to the consumer project (e.g. `openapi-spec`) and run the real end-to-end flow

### Adding a new language

Use the oagen skills:

```bash
claude --plugin-dir node_modules/@workos/oagen
/oagen:generate-sdk <language>
```

This orchestrates: emitter scaffolding, extractor, compat verification, smoke tests, and integration.

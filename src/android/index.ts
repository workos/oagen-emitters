import type {
  Emitter,
  EmitterContext,
  FormatCommand,
  GeneratedFile,
  ApiSpec,
  Model,
  Enum,
  Service,
} from '@workos/oagen';
import fs from 'node:fs';
import path from 'node:path';

import { AUTOGEN_NOTICE } from '../shared/file-header.js';
import { enrichModelsFromSpec, getSyntheticEnums } from '../shared/model-utils.js';
import { flattenDiscriminatedUnionFields } from '../shared/union-flatten.js';
import { generateModels } from './models.js';
import { generateEnums } from './enums.js';
import { generateResources } from './resources.js';
import { generateClient } from './client.js';
import { generateTests } from './tests.js';
import { buildOperationsMap } from './manifest.js';

/**
 * Normalize generated files: strip trailing whitespace from every line (ktlint's
 * no-trailing-spaces rule), ensure a trailing newline, and mark every file
 * generator-owned (`overwriteExisting`, the Go/iOS pattern) — this is a fresh,
 * fully-generated SDK, so regeneration must replace stale content rather than
 * merge with it.
 */
function normalize(files: GeneratedFile[]): GeneratedFile[] {
  for (const f of files) {
    // The smoke-plan sidecar manages its own flags; don't clobber them.
    if (f.integrateTarget !== false) f.overwriteExisting = true;
    if (!f.content) continue;
    f.content = f.content.replace(/[ \t]+$/gm, '');
    if (!f.content.endsWith('\n')) {
      f.content += '\n';
    }
  }
  return files;
}

/**
 * Restore fields on discriminated base models that `enrichModelsFromSpec` clears
 * for sum-type-capable languages, then flatten oneOf/allOf variant fields so the
 * emitted flat data classes carry every variant's fields. Mirrors the Go/iOS/
 * Kotlin base-model handling.
 */
function prepareModels(models: Model[], enums: Enum[]): Model[] {
  const enriched = enrichModelsFromSpec(models, enums);
  const originalByName = new Map(models.map((m) => [m.name, m]));
  const restored = enriched.map((m) => {
    if (m.discriminator && m.fields.length === 0) {
      const original = originalByName.get(m.name);
      if (original && original.fields.length > 0) return { ...m, fields: original.fields };
    }
    return m;
  });
  return flattenDiscriminatedUnionFields(restored);
}

/**
 * The Android / Kotlin emitter. Generates the spec-driven surface of an Android
 * library: kotlinx.serialization data classes, forward-compatible sealed-class
 * enums, coroutine (`suspend`) resource methods over OkHttp, and per-mount JUnit 5
 * suites. The HTTP runtime and Gradle files are hand-maintained in the SDK repo.
 * See `docs/sdk-architecture/android.md`.
 */
export const androidEmitter: Emitter = {
  language: 'android',

  generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
    return normalize(generateModels(prepareModels(models, ctx.spec.enums), ctx));
  },

  generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
    // Include synthetic enums minted during model enrichment (inline oneOf sets).
    const syntheticEnums = getSyntheticEnums();
    return normalize(generateEnums([...enums, ...syntheticEnums], ctx));
  },

  generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
    return normalize(generateResources(services, ctx));
  },

  generateClient(_spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
    return normalize(generateClient(ctx));
  },

  generateErrors(): GeneratedFile[] {
    // The exception hierarchy is hand-maintained in the SDK repo (@oagen-ignore-file).
    return [];
  },

  generateTypeSignatures(): GeneratedFile[] {
    // Kotlin uses inline type annotations -- no separate type-signature files.
    return [];
  },

  generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
    // Pass enriched models so fixtures and sample constructions see the same
    // field set the model generator emitted.
    const enrichedModels = prepareModels(spec.models, spec.enums);
    const enrichedSpec: ApiSpec = { ...spec, models: enrichedModels };
    return normalize(generateTests(enrichedSpec, { ...ctx, spec: enrichedSpec }));
  },

  buildOperationsMap(spec: ApiSpec, ctx: EmitterContext) {
    return buildOperationsMap(spec, ctx);
  },

  fileHeader(): string {
    return `// ${AUTOGEN_NOTICE}`;
  },

  formatCommand(targetDir: string): FormatCommand | null {
    // `./gradlew ktlintFormat` fixes whitespace, import ordering, and most
    // wrapping/line-length violations across the whole source set. The file list
    // oagen appends is ignored — Gradle reformats every Kotlin file. oagen's
    // writer already runs the spawned process with `cwd: targetDir`, so we must
    // not `cd` again (a relative `targetDir` would re-resolve against itself).
    if (!fs.existsSync(path.join(targetDir, 'gradlew'))) return null;
    return {
      cmd: 'bash',
      args: ['-c', './gradlew ktlintFormat --quiet >/dev/null 2>&1; true'],
    };
  },
};

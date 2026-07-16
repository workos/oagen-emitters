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

import { AUTOGEN_NOTICE } from '../shared/file-header.js';
import { enrichModelsFromSpec, getSyntheticEnums } from '../shared/model-utils.js';
import { flattenDiscriminatedUnionFields } from '../shared/union-flatten.js';
import { generateModels } from './models.js';
import { generateEnums } from './enums.js';
import { generateResources } from './resources.js';
import { generateClient } from './client.js';
import { generateErrors } from './errors.js';
import { generateTests } from './tests.js';
import { buildOperationsMap } from './manifest.js';

/** Ensure every generated file's content ends with a trailing newline. */
function ensureTrailingNewlines(files: GeneratedFile[]): GeneratedFile[] {
  for (const f of files) {
    if (f.content && !f.content.endsWith('\n')) {
      f.content += '\n';
    }
  }
  return files;
}

/**
 * The iOS / Swift emitter. Generates a self-contained Swift Package with a
 * URLSession-based runtime, Codable models, forward-compatible enums, and
 * `async throws` resource methods. See `docs/sdk-architecture/ios.md`.
 */
export const iosEmitter: Emitter = {
  language: 'ios',

  generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
    // Mirror the Go emitter: flatten oneOf/allOf variant fields so Swift's flat
    // structs carry every variant's fields, and restore fields on discriminated
    // base models that enrichment clears for sum-type-capable languages.
    const enriched = enrichModelsFromSpec(models, ctx.spec.enums);
    const originalByName = new Map(models.map((m) => [m.name, m]));
    const flatModels = enriched.map((m) => {
      if ((m as { discriminator?: unknown }).discriminator && m.fields.length === 0) {
        const original = originalByName.get(m.name);
        if (original && original.fields.length > 0) return { ...m, fields: original.fields };
      }
      return m;
    });
    return ensureTrailingNewlines(generateModels(flattenDiscriminatedUnionFields(flatModels), ctx));
  },

  generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
    // Include synthetic enums minted during model enrichment (inline oneOf sets).
    const syntheticEnums = getSyntheticEnums();
    return ensureTrailingNewlines(generateEnums([...enums, ...syntheticEnums], ctx));
  },

  generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
    return ensureTrailingNewlines(generateResources(services, ctx));
  },

  generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
    return ensureTrailingNewlines(generateClient(spec, ctx));
  },

  generateErrors(ctx: EmitterContext): GeneratedFile[] {
    return ensureTrailingNewlines(generateErrors(ctx));
  },

  generateTypeSignatures(): GeneratedFile[] {
    // Swift uses inline type annotations -- no separate type-signature files.
    return [];
  },

  generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
    return ensureTrailingNewlines(generateTests(spec, ctx));
  },

  buildOperationsMap(spec: ApiSpec, ctx: EmitterContext) {
    return buildOperationsMap(spec, ctx);
  },

  fileHeader(): string {
    return `// ${AUTOGEN_NOTICE}`;
  },

  formatCommand(_targetDir: string): FormatCommand | null {
    // oagen appends every generated file path (including .json) to the format
    // command. Filter to .swift and only run if swift-format is installed, so a
    // missing formatter never fails generation.
    return {
      cmd: 'bash',
      args: [
        '-c',
        'SWIFT_FILES=$(printf "%s\\n" "$@" | grep "\\.swift$"); if [ -n "$SWIFT_FILES" ] && command -v swift-format >/dev/null 2>&1; then echo "$SWIFT_FILES" | xargs swift-format -i; fi',
        '--',
      ],
      batchSize: 999999,
    };
  },
};

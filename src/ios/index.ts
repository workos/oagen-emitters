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
import { generateTests } from './tests.js';
import { buildOperationsMap } from './manifest.js';

/**
 * Normalize generated files: strip trailing whitespace from every line
 * (swift-format's TrailingWhitespace rule), ensure a trailing newline, and
 * mark every file generator-owned (`overwriteExisting`, Go pattern) — this is
 * a fresh, fully-generated SDK, so regeneration must replace stale content
 * rather than merge with it.
 */
function ensureTrailingNewlines(files: GeneratedFile[]): GeneratedFile[] {
  for (const f of files) {
    f.overwriteExisting = true;
    if (!f.content) continue;
    f.content = f.content.replace(/[ \t]+$/gm, '');
    if (!f.content.endsWith('\n')) {
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

  generateClient(_spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
    return ensureTrailingNewlines(generateClient(ctx));
  },

  generateErrors(): GeneratedFile[] {
    // The error hierarchy is hand-maintained in the SDK repo (@oagen-ignore-file).
    return [];
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
    // command. Filter to .swift and prefer the standalone swift-format binary,
    // falling back to the toolchain-bundled `swift format` subcommand (Swift 6+),
    // so a missing formatter never fails generation.
    return {
      cmd: 'bash',
      args: [
        '-c',
        'SWIFT_FILES=$(printf "%s\\n" "$@" | grep "\\.swift$"); if [ -n "$SWIFT_FILES" ]; then if command -v swift-format >/dev/null 2>&1; then echo "$SWIFT_FILES" | xargs swift-format -i; elif command -v swift >/dev/null 2>&1; then echo "$SWIFT_FILES" | xargs swift format -i; fi; fi',
        '--',
      ],
      batchSize: 999999,
    };
  },
};

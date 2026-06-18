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

import { generateModels } from './models.js';
import { generateEnums } from './enums.js';
import { generateResources } from './resources.js';
import { generateClient } from './client.js';
import { generateTests } from './tests.js';
import { buildOperationsMap } from './manifest.js';
import { UnionRegistry } from './type-map.js';
import { enrichModelsFromSpec, getSyntheticEnums } from '../shared/model-utils.js';
import { AUTOGEN_NOTICE } from '../shared/file-header.js';

/**
 * Shared per-emit registry that collects synthesised oneOf-style unions
 * encountered in *any* call (model fields, request bodies, etc.). Rendered
 * once into `src/models/_unions.rs` during the final structural pass so
 * downstream files can reference the synthesised type names uniformly.
 */
const unionRegistry = new UnionRegistry();

function ensureTrailingNewlines(files: GeneratedFile[]): GeneratedFile[] {
  for (const f of files) {
    if (f.content && !f.content.endsWith('\n')) {
      f.content += '\n';
    }
  }
  return files;
}

/**
 * Flatten oneOf / allOf+oneOf variant fields onto each base model and pull
 * in synthetic models / enums for inline variant shapes. Rust emits flat
 * structs (a synthesised enum-union from `UnionRegistry` exists, but the
 * field-on-base pattern is what matches `ConnectApplication` today). A
 * discriminated base whose IR fields the parser stripped gets its original
 * fields restored to avoid losing variant data.
 */
function enrichModelsForRust(models: Model[]): Model[] {
  const enriched = enrichModelsFromSpec(models);
  const originalByName = new Map(models.map((m) => [m.name, m]));
  return enriched.map((m) => {
    if ((m as { discriminator?: unknown }).discriminator && m.fields.length === 0) {
      const original = originalByName.get(m.name);
      if (original && original.fields.length > 0) {
        return { ...m, fields: original.fields };
      }
    }
    return m;
  });
}

export const rustEmitter: Emitter = {
  language: 'rust',

  generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
    unionRegistry.reset();
    return ensureTrailingNewlines(generateModels(enrichModelsForRust(models), ctx, unionRegistry));
  },

  generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
    const syntheticEnums = getSyntheticEnums();
    return ensureTrailingNewlines(generateEnums([...enums, ...syntheticEnums], ctx));
  },

  generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
    return ensureTrailingNewlines(generateResources(services, ctx, unionRegistry));
  },

  generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
    return ensureTrailingNewlines(generateClient(spec, ctx, unionRegistry));
  },

  generateErrors(): GeneratedFile[] {
    // Hand-maintained in the target SDK — `src/error.rs`, `src/client.rs`,
    // `src/lib.rs`, `src/pagination.rs`, and `Cargo.toml` all carry
    // `@oagen-ignore-file` and are not regenerated.
    return [];
  },

  generateTypeSignatures(): GeneratedFile[] {
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
    // oagen appends every generated file path (mixing .rs, Cargo.toml, .json
    // fixtures) to the format command. `rustfmt` errors on non-`.rs` paths,
    // so wrap it in a bash filter that only forwards `.rs` files. Same
    // shape as the Go emitter's gofmt wrapper.
    return {
      cmd: 'bash',
      args: [
        '-c',
        'RS_FILES=$(printf "%s\\n" "$@" | grep "\\.rs$"); [ -n "$RS_FILES" ] && echo "$RS_FILES" | xargs rustfmt --edition 2024 --quiet',
        '--',
      ],
      batchSize: 999999,
    };
  },
};

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
import { generateErrors } from './errors.js';
import { generateTests } from './tests.js';
import { buildOperationsMap } from './manifest.js';
import { enrichModelsFromSpec, getSyntheticEnums } from '../shared/model-utils.js';
import { AUTOGEN_NOTICE } from '../shared/file-header.js';

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
 * Flatten oneOf / allOf+oneOf variant fields onto each base model and pick up
 * the synthetic models/enums `enrichModelsFromSpec` produces for inline variant
 * shapes. Elixir emits flat structs (typespec unions carry the variant info),
 * so a discriminated base whose IR fields were stripped has its original
 * fields restored — mirroring the Ruby emitter's enrichment.
 */
function enrichModelsForElixir(models: Model[], enums: Enum[]): Model[] {
  const enriched = enrichModelsFromSpec(models, enums);
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

export const elixirEmitter: Emitter = {
  language: 'elixir',

  generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
    return ensureTrailingNewlines(generateModels(enrichModelsForElixir(models, ctx.spec.enums), ctx));
  },

  generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
    return ensureTrailingNewlines(generateEnums([...enums, ...getSyntheticEnums()], ctx));
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
    // Elixir typespecs are inline (@spec/@type in each module) — no separate files.
    return [];
  },

  generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
    return ensureTrailingNewlines(generateTests(spec, ctx));
  },

  buildOperationsMap(spec: ApiSpec, ctx: EmitterContext) {
    return buildOperationsMap(spec, ctx);
  },

  fileHeader(): string {
    return `# ${AUTOGEN_NOTICE}`;
  },

  formatCommand(targetDir: string): FormatCommand | null {
    void targetDir;
    // mix format only accepts Elixir sources; filter out fixtures/README/etc.
    // cwd is the target dir, so mix picks up the repo's hand-owned .formatter.exs.
    return {
      cmd: 'bash',
      args: [
        '-c',
        'EX_FILES=$(for f in "$@"; do case "$f" in *.ex|*.exs) echo "$f";; esac; done); ' +
          'if [ -n "$EX_FILES" ]; then printf "%s\\n" "$EX_FILES" | xargs mix format; fi',
        '--',
      ],
      batchSize: 1000,
    };
  },
};

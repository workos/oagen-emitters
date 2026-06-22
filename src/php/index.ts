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
import * as fs from 'node:fs';
import * as path from 'node:path';

import { generateModels } from './models.js';
import { generateEnums } from './enums.js';
import { generateResources } from './resources.js';
import { generateClient } from './client.js';
import { generateTests } from './tests.js';
import { buildOperationsMap } from './manifest.js';
import { initializeEnumDedup } from './naming.js';
import { enrichModelsFromSpec, getSyntheticEnums } from '../shared/model-utils.js';
import { AUTOGEN_NOTICE } from '../shared/file-header.js';

/** Initialize enum deduplication from spec data. */
function ensureNamingInitialized(ctx: EmitterContext): void {
  initializeEnumDedup(ctx.spec.enums);
}

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
 * Flatten oneOf / allOf+oneOf variant fields onto each base model and pull
 * in synthetic models / enums for inline variant shapes. PHP emits flat
 * classes (no sum types), so a discriminated base whose IR fields the
 * parser stripped (post-allOf-aware detection) gets its original fields
 * restored to avoid silently dropping variant data.
 *
 * `enums` is forwarded to seed `enrichModelsFromSpec`'s collision set: an
 * inline oneOf enum whose synthetic name (`Parent_field`) snake-collapses
 * onto an existing IR enum (e.g. `DataIntegrationAccessTokenResponse_error`
 * vs `DataIntegrationAccessTokenResponseError`) must NOT spawn a duplicate
 * synthetic. Otherwise both collapse to the same `lib/Resource/X.php` path
 * and the later writer wins by array order — which differs between a full
 * and a scoped (`--services`) run, producing a non-deterministic case order.
 */
function enrichModelsForPhp(models: Model[], enums: Enum[]): Model[] {
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

export const phpEmitter: Emitter = {
  language: 'php',

  generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
    ensureNamingInitialized(ctx);
    return ensureTrailingNewlines(generateModels(enrichModelsForPhp(models, ctx.spec.enums), ctx));
  },

  generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
    ensureNamingInitialized(ctx);
    const syntheticEnums = getSyntheticEnums();
    return ensureTrailingNewlines(generateEnums([...enums, ...syntheticEnums], ctx));
  },

  generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
    ensureNamingInitialized(ctx);
    return ensureTrailingNewlines(generateResources(services, ctx));
  },

  generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
    ensureNamingInitialized(ctx);
    return ensureTrailingNewlines(generateClient(spec, ctx));
  },

  generateErrors(): GeneratedFile[] {
    return [];
  },

  generateTypeSignatures(_spec: ApiSpec, _ctx: EmitterContext): GeneratedFile[] {
    // PHP uses inline type hints — no separate type signature files needed
    return [];
  },

  generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
    ensureNamingInitialized(ctx);
    return ensureTrailingNewlines(generateTests(spec, ctx));
  },

  buildOperationsMap(spec: ApiSpec, ctx: EmitterContext) {
    ensureNamingInitialized(ctx);
    return buildOperationsMap(spec, ctx);
  },

  fileHeader(): string {
    return `<?php\n\ndeclare(strict_types=1);\n\n// ${AUTOGEN_NOTICE}`;
  },

  formatCommand(targetDir: string): FormatCommand | null {
    const hasPhpCsFixer =
      fs.existsSync(path.join(targetDir, '.php-cs-fixer.dist.php')) ||
      fs.existsSync(path.join(targetDir, '.php-cs-fixer.php'));
    if (hasPhpCsFixer) {
      return {
        cmd: 'bash',
        args: ['-c', 'php vendor/bin/php-cs-fixer fix --using-cache=no --quiet . || true'],
        batchSize: 999999,
      };
    }
    return null;
  },
};

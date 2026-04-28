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

import { generateModels, primeModelAliases, type DiscriminatorContext } from './models.js';
import { enrichModelsFromSpec, getSyntheticEnums } from '../shared/model-utils.js';
import { generateEnums, primeEnumAliases } from './enums.js';
import { generateResources } from './resources.js';
import { generateClient } from './client.js';
import { generateTests } from './tests.js';
import { buildOperationsMap } from './manifest.js';
import { generateWrapperOptionsClasses } from './wrappers.js';
import { groupByMount } from '../shared/resolved-ops.js';
import { discriminatedUnions } from './type-map.js';
import { modelClassName } from './naming.js';

/**
 * Fix the namespace for C#. The CLI passes `--namespace workos` which gives
 * namespacePascal = "Workos", but C# needs "WorkOS" (preserving the brand casing).
 */
function fixNamespace(ctx: EmitterContext): EmitterContext {
  if (ctx.namespace === 'workos' || ctx.namespacePascal === 'Workos') {
    return { ...ctx, namespacePascal: 'WorkOS' };
  }
  return ctx;
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

/** Prefix for source files so they land under the .csproj directory. */
const SRC_PREFIX = 'src/WorkOS.net/';
/** Prefix for test files so they land under the test project directory. */
const TEST_PREFIX = 'test/WorkOSTests/';

/** Prefix generated source file paths to match the .NET project layout. */
function prefixSourcePaths(files: GeneratedFile[]): GeneratedFile[] {
  for (const f of files) {
    f.path = `${SRC_PREFIX}${f.path}`;
  }
  return files;
}

/** Prefix generated test/fixture paths to match the .NET test project layout. */
function prefixTestPaths(files: GeneratedFile[]): GeneratedFile[] {
  for (const f of files) {
    f.path = `${TEST_PREFIX}${f.path}`;
  }
  return files;
}

export const dotnetEmitter: Emitter = {
  language: 'dotnet',

  generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
    const c = fixNamespace(ctx);
    primeEnumAliases(c.spec.enums);
    const enriched = enrichModelsFromSpec(models);
    // Re-prime after enrichment so synthetic enums from oneOf branches are
    // included in the alias map used by mapTypeRef during model emission.
    const synEnumsForModels = getSyntheticEnums();
    if (synEnumsForModels.length > 0) {
      primeEnumAliases([...c.spec.enums, ...synEnumsForModels]);
    }

    // Restore fields on discriminated base models. enrichModelsFromSpec clears
    // fields for dispatcher-capable languages; C# uses inheritance instead:
    // the base class keeps its common fields and variant classes extend it.
    const originalByName = new Map(models.map((m) => [m.name, m]));
    const discriminatorBases = new Set<string>();
    const variantToBase = new Map<string, string>();
    const modelDiscriminators = new Map<string, { property: string; mapping: Record<string, string> }>();

    const dotnetModels = enriched.map((m) => {
      const disc = (m as any).discriminator;
      if (disc && m.fields.length === 0) {
        const original = originalByName.get(m.name);
        if (original && original.fields.length > 0) {
          discriminatorBases.add(m.name);
          modelDiscriminators.set(m.name, disc);
          for (const variantName of Object.values(disc.mapping) as string[]) {
            variantToBase.set(variantName, m.name);
          }
          return { ...m, fields: original.fields };
        }
      }
      return m;
    });

    const discCtx: DiscriminatorContext = { discriminatorBases, variantToBase };
    const files = generateModels(dotnetModels, c, discCtx);

    // Generate discriminator converters for oneOf unions with discriminator
    // (union-type references, e.g. a field typed as oneOf with discriminator)
    if (discriminatedUnions.size > 0) {
      for (const [baseName, disc] of discriminatedUnions) {
        const converterName = `${baseName}DiscriminatorConverter`;
        const lines: string[] = [];
        lines.push(`namespace ${c.namespacePascal}`);
        lines.push('{');
        lines.push('    using System;');
        lines.push('    using Newtonsoft.Json;');
        lines.push('    using Newtonsoft.Json.Linq;');
        lines.push('');
        lines.push(`    /// <summary>`);
        lines.push(`    /// JSON converter that deserializes discriminated union variants`);
        lines.push(`    /// based on the "${disc.property}" property.`);
        lines.push(`    /// </summary>`);
        lines.push(`    public class ${converterName} : Newtonsoft.Json.JsonConverter`);
        lines.push('    {');
        lines.push('        public override bool CanConvert(Type objectType) => objectType == typeof(object);');
        lines.push('');
        lines.push(
          '        public override object ReadJson(Newtonsoft.Json.JsonReader reader, Type objectType, object? existingValue, Newtonsoft.Json.JsonSerializer serializer)',
        );
        lines.push('        {');
        lines.push('            var jObject = JObject.Load(reader);');
        lines.push(`            var discriminatorValue = jObject["${disc.property}"]?.ToString();`);
        lines.push('            switch (discriminatorValue)');
        lines.push('            {');
        for (const [value, modelName] of Object.entries(disc.mapping)) {
          const csName = modelClassName(modelName);
          lines.push(`                case "${value}": return jObject.ToObject<${csName}>(serializer);`);
        }
        lines.push('                default: return jObject.ToObject<object>(serializer);');
        lines.push('            }');
        lines.push('        }');
        lines.push('');
        lines.push(
          '        public override void WriteJson(Newtonsoft.Json.JsonWriter writer, object? value, Newtonsoft.Json.JsonSerializer serializer)',
        );
        lines.push('        {');
        lines.push('            serializer.Serialize(writer, value);');
        lines.push('        }');
        lines.push('    }');
        lines.push('}');

        files.push({
          path: `Client/Utilities/${converterName}.cs`,
          content: lines.join('\n'),
          overwriteExisting: true,
        });
      }
    }

    // Generate converters for discriminated base models (model-level
    // discriminators detected by enrichModelsFromSpec, e.g. EventSchema).
    // Uses Populate to avoid infinite recursion with the [JsonConverter]
    // attribute applied to the base class.
    for (const [baseName, disc] of modelDiscriminators) {
      const baseClass = modelClassName(baseName);
      const converterName = `${baseClass}DiscriminatorConverter`;
      const lines: string[] = [];
      lines.push(`namespace ${c.namespacePascal}`);
      lines.push('{');
      lines.push('    using System;');
      lines.push('    using Newtonsoft.Json;');
      lines.push('    using Newtonsoft.Json.Linq;');
      lines.push('');
      lines.push(`    /// <summary>`);
      lines.push(`    /// JSON converter that deserializes <see cref="${baseClass}"/> into the`);
      lines.push(`    /// correct variant subclass based on the "${disc.property}" property.`);
      lines.push(`    /// </summary>`);
      lines.push(`    public class ${converterName} : Newtonsoft.Json.JsonConverter`);
      lines.push('    {');
      lines.push(
        `        public override bool CanConvert(Type objectType) => typeof(${baseClass}).IsAssignableFrom(objectType);`,
      );
      lines.push('');
      lines.push(
        '        public override object ReadJson(Newtonsoft.Json.JsonReader reader, Type objectType, object? existingValue, Newtonsoft.Json.JsonSerializer serializer)',
      );
      lines.push('        {');
      lines.push('            var jObject = JObject.Load(reader);');
      lines.push(`            var discriminatorValue = jObject["${disc.property}"]?.ToString();`);
      lines.push('');
      lines.push('            object target;');
      lines.push('            switch (discriminatorValue)');
      lines.push('            {');
      for (const [value, variantModelName] of Object.entries(disc.mapping)) {
        const csName = modelClassName(variantModelName);
        lines.push(`                case "${value}": target = new ${csName}(); break;`);
      }
      lines.push(`                default: target = new ${baseClass}(); break;`);
      lines.push('            }');
      lines.push('');
      lines.push('            serializer.Populate(jObject.CreateReader(), target);');
      lines.push('            return target;');
      lines.push('        }');
      lines.push('');
      lines.push(
        '        public override void WriteJson(Newtonsoft.Json.JsonWriter writer, object? value, Newtonsoft.Json.JsonSerializer serializer)',
      );
      lines.push('        {');
      lines.push('            serializer.Serialize(writer, value);');
      lines.push('        }');
      lines.push('    }');
      lines.push('}');

      files.push({
        path: `Client/Utilities/${converterName}.cs`,
        content: lines.join('\n'),
        overwriteExisting: true,
      });
    }

    return prefixSourcePaths(ensureTrailingNewlines(files));
  },

  generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
    const c = fixNamespace(ctx);
    // Ensure synthetic enums are populated regardless of method execution order.
    // enrichModelsFromSpec is idempotent (cached raw spec) and populates the
    // module-level synthetic-enum store consumed by getSyntheticEnums().
    enrichModelsFromSpec(c.spec.models);
    const syntheticEnums = getSyntheticEnums();
    const allEnums = syntheticEnums.length > 0 ? [...enums, ...syntheticEnums] : enums;
    return prefixSourcePaths(ensureTrailingNewlines(generateEnums(allEnums, c)));
  },

  generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
    const c = fixNamespace(ctx);
    const synEnums = getSyntheticEnums();
    primeEnumAliases(synEnums.length > 0 ? [...c.spec.enums, ...synEnums] : c.spec.enums);
    primeModelAliases(enrichModelsFromSpec(c.spec.models));
    const files = generateResources(services, c);

    // Also generate wrapper options classes
    const mountGroups = groupByMount(c);
    for (const [, group] of mountGroups) {
      for (const resolvedOp of group.resolvedOps) {
        if (resolvedOp.wrappers && resolvedOp.wrappers.length > 0) {
          const wrapperOptionsLines = generateWrapperOptionsClasses(resolvedOp, c);
          if (wrapperOptionsLines.length > 0) {
            const mountName = resolvedOp.mountOn;
            const optionsPath = `Services/${mountName}/_interfaces/${mountName}WrapperOptions.cs`;
            const content = [
              `namespace ${c.namespacePascal}`,
              '{',
              '    using System.Collections.Generic;',
              '    using Newtonsoft.Json;',
              '    using STJS = System.Text.Json.Serialization;',
              ...wrapperOptionsLines,
              '}',
            ].join('\n');
            files.push({
              path: optionsPath,
              content,
              overwriteExisting: true,
            });
          }
        }
      }
    }

    return prefixSourcePaths(ensureTrailingNewlines(files));
  },

  generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
    const c = fixNamespace(ctx);
    return prefixSourcePaths(ensureTrailingNewlines(generateClient(spec, c)));
  },

  generateErrors(): GeneratedFile[] {
    return [];
  },

  generateTypeSignatures(): GeneratedFile[] {
    return [];
  },

  generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
    const c = fixNamespace(ctx);
    const synEnumsForTests = getSyntheticEnums();
    primeEnumAliases(synEnumsForTests.length > 0 ? [...spec.enums, ...synEnumsForTests] : spec.enums);
    primeModelAliases(enrichModelsFromSpec(c.spec.models));
    return prefixTestPaths(ensureTrailingNewlines(generateTests(spec, c)));
  },

  buildOperationsMap(spec: ApiSpec, ctx: EmitterContext) {
    return buildOperationsMap(spec, fixNamespace(ctx));
  },

  fileHeader(): string {
    return '// This file is auto-generated by oagen. Do not edit.';
  },

  formatCommand(targetDir: string): FormatCommand | null {
    // `dotnet format` applies both whitespace rules and analyzer code fixes
    // (StyleCop, etc.) to the generated files, matching the target project's
    // conventions. We prefer a .sln/.slnx/.csproj workspace so MSBuild loads
    // the analyzer ruleset correctly.
    const workspace = findDotnetWorkspace(targetDir);
    if (!workspace) return null;

    // `dotnet format` expects `--include` paths relative to the workspace
    // (or absolute). Our harness appends absolute paths, which is fine.
    // Run `--no-restore` so formatting doesn't trigger a package restore on
    // every codegen run.
    return {
      cmd: 'dotnet',
      args: ['format', workspace, '--no-restore', '--include'],
      // Keep batches small enough to stay under argv length limits while
      // still amortizing MSBuild startup across many files.
      batchSize: 500,
    };
  },
};

/** Locate a .sln/.slnx/.csproj file in the target directory for `dotnet format`. */
function findDotnetWorkspace(targetDir: string): string | null {
  if (!fs.existsSync(targetDir)) return null;
  const entries = fs.readdirSync(targetDir);
  const sln = entries.find((e) => e.endsWith('.sln') || e.endsWith('.slnx'));
  if (sln) return path.resolve(targetDir, sln);
  const csproj = entries.find((e) => e.endsWith('.csproj'));
  if (csproj) return path.resolve(targetDir, csproj);
  return null;
}

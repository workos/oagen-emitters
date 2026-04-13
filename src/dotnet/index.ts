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
import { enrichModelsFromSpec } from '../shared/model-utils.js';
import { generateEnums } from './enums.js';
import { generateResources } from './resources.js';
import { generateTests } from './tests.js';
import { generateManifest } from './manifest.js';
import { generateWrapperOptionsClasses } from './wrappers.js';
import { groupByMount } from '../shared/resolved-ops.js';
import { discriminatedUnions } from './type-map.js';

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
    const enriched = enrichModelsFromSpec(models);
    const files = generateModels(enriched, c);

    // Generate discriminator converters for oneOf unions with discriminator
    if (discriminatedUnions.size > 0) {
      for (const [baseName, disc] of discriminatedUnions) {
        const converterName = `${baseName}DiscriminatorConverter`;
        const lines: string[] = [];
        lines.push(`namespace ${c.namespacePascal}`);
        lines.push('{');
        lines.push('    using System;');
        lines.push('    using System.Text.Json;');
        lines.push('    using System.Text.Json.Serialization;');
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
          '        public override object ReadJson(Newtonsoft.Json.JsonReader reader, Type objectType, object existingValue, Newtonsoft.Json.JsonSerializer serializer)',
        );
        lines.push('        {');
        lines.push('            var jObject = JObject.Load(reader);');
        lines.push(`            var discriminatorValue = jObject["${disc.property}"]?.ToString();`);
        lines.push('            switch (discriminatorValue)');
        lines.push('            {');
        for (const [value, modelName] of Object.entries(disc.mapping)) {
          const csName = modelName.replace(/([a-z])([A-Z])/g, '$1$2');
          lines.push(`                case "${value}": return jObject.ToObject<${csName}>(serializer);`);
        }
        lines.push('                default: return jObject.ToObject<object>(serializer);');
        lines.push('            }');
        lines.push('        }');
        lines.push('');
        lines.push(
          '        public override void WriteJson(Newtonsoft.Json.JsonWriter writer, object value, Newtonsoft.Json.JsonSerializer serializer)',
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

    return prefixSourcePaths(ensureTrailingNewlines(files));
  },

  generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
    return prefixSourcePaths(ensureTrailingNewlines(generateEnums(enums, fixNamespace(ctx))));
  },

  generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
    const c = fixNamespace(ctx);
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

  generateClient(): GeneratedFile[] {
    return [];
  },

  generateErrors(): GeneratedFile[] {
    return [];
  },

  generateTypeSignatures(): GeneratedFile[] {
    return [];
  },

  generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
    return prefixTestPaths(ensureTrailingNewlines(generateTests(spec, fixNamespace(ctx))));
  },

  generateManifest(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
    return ensureTrailingNewlines(generateManifest(spec, fixNamespace(ctx)));
  },

  fileHeader(): string {
    return '// This file is auto-generated by oagen. Do not edit.';
  },

  formatCommand(): FormatCommand | null {
    return null;
  },
};

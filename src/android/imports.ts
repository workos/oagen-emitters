import type { EmitterContext } from '@workos/oagen';
import { subPackage, typeName } from './naming.js';
import { getSyntheticEnums } from '../shared/model-utils.js';

/**
 * Kotlin types that are always in scope (stdlib) or resolved by an explicit
 * import the generator adds directly, so they must never be treated as a
 * generated model/enum reference needing a package import.
 */
const BUILT_IN_TYPES = new Set([
  'Any',
  'Boolean',
  'ByteArray',
  'Double',
  'Instant',
  'Int',
  'JsonElement',
  'List',
  'Long',
  'Map',
  'Nothing',
  'Set',
  'String',
  'Unit',
]);

/**
 * Runtime types that live in the SDK's root package (hand-maintained). A
 * generated file in a sub-package must import them explicitly.
 */
const ROOT_PACKAGE_TYPES = new Set(['Configuration', 'ListMetadata', 'Page', 'RequestOptions']);

/** Runtime types that live in the SDK's `internal` package (hand-maintained). */
const INTERNAL_PACKAGE_TYPES = new Set(['JsonBody', 'PathEncoding', 'QueryParam', 'Transport']);

/**
 * Extract candidate Kotlin type identifiers from a type expression.
 * `List<Organization>?` → `['List', 'Organization']`.
 */
export function extractTypeNames(expr: string): string[] {
  return expr.match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? [];
}

/**
 * Resolve the imports required by a set of Kotlin type expressions: generated
 * models and enums resolve to their sub-package, hand-maintained runtime types
 * to the root or `internal` package. Unknown identifiers are skipped rather than
 * guessed, so a bad type never produces a dangling import.
 */
export function resolveTypeImports(ctx: EmitterContext, exprs: Iterable<string>): string[] {
  const modelNames = new Set(ctx.spec.models.map((m) => typeName(m.name)));
  // Synthetic enums (minted from inline oneOf sets during model enrichment) are
  // emitted into the enums package but are absent from `ctx.spec.enums`. Without
  // them here, a model field typed as one would generate no import and the file
  // would not compile. The WorkOS spec currently mints none, so this changes no
  // output today.
  const enumNames = new Set([...ctx.spec.enums, ...getSyntheticEnums()].map((e) => typeName(e.name)));

  const imports = new Set<string>();
  for (const expr of exprs) {
    for (const name of extractTypeNames(expr)) {
      if (BUILT_IN_TYPES.has(name)) continue;
      if (modelNames.has(name)) {
        imports.add(`${subPackage(ctx, 'models')}.${name}`);
      } else if (enumNames.has(name)) {
        imports.add(`${subPackage(ctx, 'enums')}.${name}`);
      } else if (ROOT_PACKAGE_TYPES.has(name)) {
        imports.add(`${subPackage(ctx, '')}.${name}`);
      } else if (INTERNAL_PACKAGE_TYPES.has(name)) {
        imports.add(`${subPackage(ctx, 'internal')}.${name}`);
      }
    }
  }
  return [...imports];
}

/**
 * Render a deterministic, ktlint-compatible import block: lexicographically
 * sorted, de-duplicated, no blank-line grouping. Self-imports (types already in
 * `currentPackage`) are dropped — Kotlin rejects an import from the file's own
 * package as redundant, and ktlint flags it.
 */
export function renderImportBlock(imports: Iterable<string>, currentPackage?: string): string[] {
  const unique = new Set<string>();
  for (const imp of imports) {
    if (currentPackage && imp.startsWith(`${currentPackage}.`)) {
      // Same-package import only if it is a direct child (no further dots).
      const tail = imp.slice(currentPackage.length + 1);
      if (!tail.includes('.')) continue;
    }
    unique.add(imp);
  }
  return [...unique].sort().map((imp) => `import ${imp}`);
}

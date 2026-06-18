import type { Operation, Service, EmitterContext } from '@workos/oagen';
import { toPascalCase, toSnakeCase, deriveMethodName } from '@workos/oagen';
import { stripUrnPrefix } from '../shared/naming-utils.js';

const RUST_KEYWORDS = new Set([
  'as',
  'break',
  'const',
  'continue',
  'crate',
  'else',
  'enum',
  'extern',
  'false',
  'fn',
  'for',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'match',
  'mod',
  'move',
  'mut',
  'pub',
  'ref',
  'return',
  'self',
  'Self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'type',
  'unsafe',
  'use',
  'where',
  'while',
  'async',
  'await',
  'dyn',
  'abstract',
  'become',
  'box',
  'do',
  'final',
  'macro',
  'override',
  'priv',
  'typeof',
  'unsized',
  'virtual',
  'yield',
  'try',
  'union',
]);

/** PascalCase type name (for structs and enums). */
export function typeName(name: string): string {
  return toPascalCase(stripUrnPrefix(name));
}

/** snake_case module/file basename (no extension). */
export function moduleName(name: string): string {
  return escapeKeyword(toSnakeCase(stripUrnPrefix(name)));
}

/** snake_case method name. */
export function methodName(name: string): string {
  return escapeKeyword(toSnakeCase(stripUrnPrefix(name)));
}

/** snake_case struct field. */
export function fieldName(name: string): string {
  return escapeKeyword(toSnakeCase(name));
}

/**
 * snake_case domain field name for a model field, honoring a `domainName`
 * override (set via the `fieldHints` config) so a wire field can surface under
 * a friendlier identifier. The wire name (and thus the `#[serde(rename = ...)]`
 * key) still derives from `field.name`.
 */
export function domainFieldName(field: { name: string; domainName?: string }): string {
  return escapeKeyword(toSnakeCase(field.domainName ?? field.name));
}

/** PascalCase enum variant. */
export function variantName(value: string | number): string {
  const s = String(value);
  // Numbers and values starting with a digit must be prefixed.
  const pascal = toPascalCase(s);
  if (/^[0-9]/.test(pascal)) return `V${pascal}`;
  return pascal || 'Empty';
}

/** Resource handle struct name (e.g., `OrganizationsApi`). Suffix is chosen
 * to avoid collisions with API entity models (`AuthorizationResource`,
 * `Service`, etc.) that may share the singular noun. */
export function resourceStructName(serviceName: string): string {
  const base = typeName(serviceName);
  if (base.endsWith('Api')) return base;
  // Drop a pre-existing `Resource` suffix; the conventional Rust handle name
  // here is `…Api` regardless of the service's spec-side label.
  const trimmed = base.endsWith('Resource') ? base.slice(0, -'Resource'.length) : base;
  return `${trimmed}Api`;
}

/** Client accessor method name on `Client` (snake_case service name). */
export function resourceAccessorName(serviceName: string): string {
  return moduleName(serviceName);
}

/** Rust file path for a resource module. */
export function resourceFileBasename(serviceName: string): string {
  return moduleName(serviceName);
}

/** Resolve the SDK method name for an operation, honoring overlay hints. */
export function resolveMethodName(op: Operation, service: Service, ctx: EmitterContext): string {
  const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
  const overlayName = ctx.overlayLookup?.methodByOperation.get(httpKey)?.methodName;
  if (overlayName) return methodName(overlayName);

  const resolved = ctx.resolvedOperations?.find(
    (r) => r.operation.path === op.path && r.operation.httpMethod === op.httpMethod,
  );
  if (resolved?.methodName) return methodName(resolved.methodName);

  return methodName(deriveMethodName(op, service));
}

/** Suffix any Rust reserved word with `_` so it parses as an identifier. */
function escapeKeyword(s: string): string {
  if (s.length === 0) return '_';
  if (RUST_KEYWORDS.has(s)) return `${s}_`;
  if (/^[0-9]/.test(s)) return `_${s}`;
  return s;
}

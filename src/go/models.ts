import type { Model, EmitterContext, GeneratedFile, TypeRef, Service } from '@workos/oagen';
import { walkTypeRef } from '@workos/oagen';
import { mapTypeRef } from './type-map.js';
import { className, fieldName } from './naming.js';
import { lowerFirstForDoc, fieldDocComment, articleFor } from '../shared/naming-utils.js';

// Import and re-export shared model detection utilities
import {
  isListWrapperModel,
  isListMetadataModel,
  collectNonPaginatedResponseModelNames,
} from '../shared/model-utils.js';
export { isListWrapperModel, isListMetadataModel };

/**
 * Collect names of models that are referenced **only** as a named request body
 * model on an operation, with no other consumers (response types, pagination
 * item types, error types, or fields on other models).
 *
 * The Go emitter synthesizes a `{Service}{Method}Params` struct from those
 * request bodies (see `resources.ts:392`), and the method signature uses the
 * synthesized struct — never the named model. So emitting the named model in
 * `models.go` would leave callers with a duplicate, unused struct (the bug
 * surfaced in workos-go#544 with `CreateUserAPIKey` /
 * `UserManagementCreateAPIKeyParams`).
 *
 * Models in this set are skipped during model emission. Callers parameterize
 * the API surface through `*Params` exclusively, which is the sole consumer
 * of the spec's named request body schema.
 */
function collectRequestBodyOnlyModelNames(services: Service[], models: Model[]): Set<string> {
  const requestBodyNames = new Set<string>();
  const otherReferences = new Set<string>();

  const collect = (ref: TypeRef | undefined, into: Set<string>): void => {
    if (!ref) return;
    walkTypeRef(ref, {
      model: (r) => into.add(r.name),
    });
  };

  for (const service of services) {
    for (const op of service.operations) {
      if (op.requestBody?.kind === 'model') {
        requestBodyNames.add(op.requestBody.name);
      }
      collect(op.response, otherReferences);
      if (op.pagination) collect(op.pagination.itemType, otherReferences);
      for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
        collect(p.type, otherReferences);
      }
      if (op.successResponses) {
        for (const sr of op.successResponses) collect(sr.type, otherReferences);
      }
      for (const err of op.errors) {
        if (err.type) collect(err.type, otherReferences);
      }
    }
  }

  // Field references — a request body model that's also a field type elsewhere
  // is a reusable schema (e.g. consumed by webhook event data), so we keep it.
  for (const model of models) {
    for (const field of model.fields) {
      collect(field.type, otherReferences);
    }
  }

  const result = new Set<string>();
  for (const name of requestBodyNames) {
    if (!otherReferences.has(name)) result.add(name);
  }
  return result;
}

/**
 * Generate Go struct definitions from IR Models.
 * All models go into a single models.go file for the flat package.
 */
export function generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  if (models.length === 0) return [];

  const files: GeneratedFile[] = [];
  const lines: string[] = [];

  lines.push(`package ${ctx.namespace}`);
  lines.push('');

  const requestBodyOnly = collectRequestBodyOnlyModelNames(ctx.spec.services, models);
  // Wrappers referenced as a non-paginated response (e.g. `VersionListResponse`
  // for `GET /vault/v1/kv/{id}/versions`) must still be emitted — the resource
  // code references them by name and the pagination iterator doesn't unwrap them.
  const nonPaginatedRefs = collectNonPaginatedResponseModelNames(ctx.spec.services);
  const skipAsListWrapper = (m: Model): boolean => isListWrapperModel(m) && !nonPaginatedRefs.has(m.name);

  // Build structural hash for deduplication
  const modelHashMap = new Map<string, string>();
  const hashGroups = new Map<string, string[]>();
  for (const model of models) {
    if (skipAsListWrapper(model) || isListMetadataModel(model)) continue;
    if (requestBodyOnly.has(model.name)) continue;
    const hash = structuralHash(model);
    modelHashMap.set(model.name, hash);
    if (!hashGroups.has(hash)) hashGroups.set(hash, []);
    hashGroups.get(hash)!.push(model.name);
  }

  // Pick canonical for each duplicate group.
  // Empty structs (hash '') are now properly populated by oneOf flattening,
  // so we still skip aliasing them to avoid aliasing truly empty structs.
  const aliasOf = new Map<string, string>();
  for (const [hash, names] of hashGroups) {
    if (names.length <= 1) continue;
    if (hash === '') continue;
    const sorted = [...names].sort();
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      aliasOf.set(sorted[i], canonical);
    }
  }

  const batchedAliases = new Set<string>();
  for (const model of models) {
    if (skipAsListWrapper(model) || isListMetadataModel(model)) continue;
    if (requestBodyOnly.has(model.name)) continue;

    const structName = className(model.name);

    // If this model is a dedup alias, emit a type alias.
    // For large alias groups (5+), use a compact batch declaration.
    const canonicalName = aliasOf.get(model.name);
    if (canonicalName) {
      // Check if this alias is part of a batch that was already emitted
      if (batchedAliases.has(model.name)) continue;

      const canonicalStruct = className(canonicalName);
      // Skip when different IR names map to the same Go type (e.g. synthetic
      // models from enrichModelsFromSpec whose underscore names collapse to the
      // same PascalCase as the original model).
      if (structName === canonicalStruct) continue;

      const hash = modelHashMap.get(model.name)!;
      const groupNames = hashGroups.get(hash) ?? [];
      const aliases = groupNames.filter((n) => aliasOf.has(n) && className(n) !== className(aliasOf.get(n)!));

      if (aliases.length >= 5) {
        // Batch emit all aliases for this group at once
        for (const aliasName of aliases) {
          batchedAliases.add(aliasName);
        }
        lines.push(`// The following types are structurally identical to ${canonicalStruct}.`);
        lines.push('type (');
        for (const aliasName of aliases) {
          lines.push(`\t${className(aliasName)} = ${canonicalStruct}`);
        }
        lines.push(')');
        lines.push('');
      } else {
        lines.push(`// ${structName} is an alias for ${canonicalStruct}.`);
        lines.push(`type ${structName} = ${canonicalStruct}`);
        lines.push('');
      }
      continue;
    }

    // Emit struct
    if (model.description) {
      const descLines = model.description.split('\n').filter((l) => l.trim());
      lines.push(`// ${structName} ${lowerFirst(descLines[0])}`);
      for (let i = 1; i < descLines.length; i++) {
        lines.push(`// ${descLines[i].trim()}`);
      }
    } else {
      const humanized = humanize(model.name);
      lines.push(`// ${structName} represents ${articleFor(humanized)} ${humanized}.`);
    }
    lines.push(`type ${structName} struct {`);

    // Deduplicate fields by Go field name
    const seenFieldNames = new Set<string>();
    for (const field of model.fields) {
      const goFieldName = fieldName(field.name);
      if (seenFieldNames.has(goFieldName)) continue;
      seenFieldNames.add(goFieldName);

      const isOptional = !field.required;
      const goType = isOptional ? makeOptional(mapTypeRef(field.type)) : mapTypeRef(field.type);

      const jsonTag = field.required ? `json:"${field.name}"` : `json:"${field.name},omitempty"`;

      if (field.description) {
        const fdLines = field.description.split('\n').filter((l) => l.trim());
        lines.push(`\t// ${fieldDocComment(goFieldName, fdLines[0])}`);
        for (let i = 1; i < fdLines.length; i++) {
          lines.push(`\t// ${fdLines[i].trim()}`);
        }
      }
      if (field.deprecated) {
        if (field.description) lines.push(`\t//`);
        const deprecationReason = extractDeprecationReason(field.description);
        lines.push(`\t// Deprecated: ${deprecationReason}`);
      }
      lines.push(`\t${goFieldName} ${goType} \`${jsonTag}\``);
    }

    lines.push('}');
    lines.push('');
  }

  // Emit shared PaginationParams struct for list operations to embed.
  //
  // The Order field's type is derived from the spec rather than hardcoded:
  // when every paginated `order` query parameter $refs the same top-level
  // enum (typically `PaginationOrder` in the WorkOS spec), we emit the typed
  // enum so callers get compile-time validation. Otherwise we fall back to
  // *string. The fallback handles older specs that don't lift the enum into a
  // named component schema.
  const orderEnumType = detectSharedOrderEnum(ctx.spec.services);
  const orderGoType = orderEnumType ? `*${className(orderEnumType)}` : '*string';
  lines.push('// PaginationParams contains common pagination parameters for list operations.');
  lines.push('type PaginationParams struct {');
  lines.push('\t// Before is a cursor for reverse pagination.');
  lines.push('\tBefore *string `url:"before,omitempty" json:"-"`');
  lines.push('\t// After is a cursor for forward pagination.');
  lines.push('\tAfter *string `url:"after,omitempty" json:"-"`');
  lines.push('\t// Limit is the maximum number of items to return per page.');
  lines.push('\tLimit *int `url:"limit,omitempty" json:"-"`');
  lines.push('\t// Order is the sort order for results.');
  lines.push(`\tOrder ${orderGoType} \`url:"order,omitempty" json:"-"\``);
  lines.push('}');
  lines.push('');

  files.push({
    path: 'models.go',
    content: lines.join('\n'),
    overwriteExisting: true,
  });

  return files;
}

/**
 * Make a Go type optional (pointer) if it isn't already.
 */
function makeOptional(goType: string): string {
  if (goType.startsWith('*') || goType.startsWith('[]') || goType.startsWith('map[')) {
    return goType;
  }
  return `*${goType}`;
}

function structuralHash(model: Model): string {
  const fieldHash = model.fields
    .map((f) => `${f.name}:${JSON.stringify(f.type)}:${f.required}`)
    .sort()
    .join('|');
  // Include entity domain for CRUD-prefixed models to prevent cross-domain
  // aliasing (e.g. UpdateGroup vs UpdateAuthorizationPermission have identical
  // fields but belong to different API domains and should stay separate types).
  const domain = crudEntityDomain(model.name);
  return domain ? `${domain}::${fieldHash}` : fieldHash;
}

const CRUD_PREFIXES = ['Create', 'Update', 'Delete', 'Get', 'List'];

/** Strip CRUD verb prefix to get the entity name, or null if no prefix matches. */
function crudEntityDomain(name: string): string | null {
  for (const prefix of CRUD_PREFIXES) {
    if (name.startsWith(prefix) && name.length > prefix.length) {
      return name.slice(prefix.length);
    }
  }
  return null;
}

/** Known acronyms to preserve as single tokens during humanization. */
const HUMANIZE_ACRONYMS: [RegExp, string][] = [
  [/OAuth/g, 'OAUTH_ACRN'],
  [/URN/g, 'URN_ACRN'],
  [/IETF/g, 'IETF_ACRN'],
  [/API/g, 'API_ACRN'],
  [/SSO/g, 'SSO_ACRN'],
  [/PKCE/g, 'PKCE_ACRN'],
  [/JWT/g, 'JWT_ACRN'],
  [/MFA/g, 'MFA_ACRN'],
  [/TOTP/g, 'TOTP_ACRN'],
  [/SAML/g, 'SAML_ACRN'],
  [/SCIM/g, 'SCIM_ACRN'],
  [/OIDC/g, 'OIDC_ACRN'],
  [/CORS/g, 'CORS_ACRN'],
  [/RBAC/g, 'RBAC_ACRN'],
];

const HUMANIZE_RESTORE: [RegExp, string][] = [
  [/oauth_acrn/g, 'OAuth'],
  [/urn_acrn/g, 'URN'],
  [/ietf_acrn/g, 'IETF'],
  [/api_acrn/g, 'API'],
  [/sso_acrn/g, 'SSO'],
  [/pkce_acrn/g, 'PKCE'],
  [/jwt_acrn/g, 'JWT'],
  [/mfa_acrn/g, 'MFA'],
  [/totp_acrn/g, 'TOTP'],
  [/saml_acrn/g, 'SAML'],
  [/scim_acrn/g, 'SCIM'],
  [/oidc_acrn/g, 'OIDC'],
  [/cors_acrn/g, 'CORS'],
  [/rbac_acrn/g, 'RBAC'],
];

function humanize(name: string): string {
  // Replace known acronyms with placeholders before splitting
  let s = name;
  for (const [pattern, replacement] of HUMANIZE_ACRONYMS) {
    s = s.replace(pattern, replacement);
  }
  // Split camelCase/PascalCase into words
  let result = s.replace(/([a-z])([A-Z])/g, '$1 $2');
  result = result.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  result = result.toLowerCase();
  // Restore acronyms
  for (const [pattern, replacement] of HUMANIZE_RESTORE) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function lowerFirst(s: string): string {
  return lowerFirstForDoc(s);
}

/**
 * If every paginated list operation's `order` query parameter $refs the same
 * top-level enum, return that enum's IR name. Otherwise return null. When
 * the spec is consistent this lifts `PaginationParams.Order` from `*string`
 * to `*PaginationOrder` (or whatever the spec calls it), giving callers
 * compile-time validation.
 *
 * We require strict consistency: if any operation uses a primitive string for
 * `order`, or two operations reference different enums, we conservatively
 * stay on `*string` so the shared struct doesn't lie about its accepted
 * values.
 */
function detectSharedOrderEnum(services: Service[]): string | null {
  let candidate: string | null = null;
  let sawAny = false;
  for (const service of services) {
    for (const op of service.operations) {
      if (!op.pagination) continue;
      const orderParam = op.queryParams.find((p) => p.name === 'order');
      if (!orderParam) continue;
      sawAny = true;
      const enumName = unwrapEnumName(orderParam.type);
      if (!enumName) return null;
      if (candidate === null) candidate = enumName;
      else if (candidate !== enumName) return null;
    }
  }
  return sawAny ? candidate : null;
}

function unwrapEnumName(ref: TypeRef): string | null {
  if (ref.kind === 'enum') return ref.name;
  if (ref.kind === 'nullable') return unwrapEnumName(ref.inner);
  return null;
}

/**
 * Extract a deprecation reason from a field description.
 * Looks for patterns like "Use X instead", "Replaced by Y", etc.
 * Falls back to a generic message if no migration guidance is found.
 */
function extractDeprecationReason(description?: string): string {
  if (!description) return 'this field is deprecated.';

  // Common patterns: "Use X instead", "Replaced by X", "Deprecated in favor of X"
  const patterns = [
    /\b(use\s+\S+(?:\s+\S+){0,3}\s+instead)\b/i,
    /\b(replaced\s+by\s+\S+(?:\s+\S+){0,3})\b/i,
    /\b(deprecated\s+in\s+favor\s+of\s+\S+(?:\s+\S+){0,3})\b/i,
    /\b(prefer\s+\S+(?:\s+\S+){0,3})\b/i,
    /\b(migrate\s+to\s+\S+(?:\s+\S+){0,3})\b/i,
  ];

  for (const pattern of patterns) {
    const match = description.match(pattern);
    if (match) {
      let reason = match[1].trim();
      // Ensure it ends with a period
      if (!reason.endsWith('.')) reason += '.';
      return reason;
    }
  }

  return 'this field is deprecated.';
}

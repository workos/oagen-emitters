import type { Enum, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { walkTypeRef } from '@workos/oagen';
import { className } from './naming.js';
import { isEnumInScope, isScopedRun } from '../shared/resolved-ops.js';
import { reconcileFlatBlocks, readPriorFile, type NamedBlock } from './flat-merge.js';

/**
 * Generate Go typed string enum constants from IR Enum definitions.
 *
 * Each enum becomes a named string type + const block:
 *   type Status string
 *   const (
 *     StatusActive   Status = "active"
 *     StatusInactive Status = "inactive"
 *   )
 */
export function generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
  if (enums.length === 0) return [];

  const aliasOf = collectEnumAliasOf(enums);
  // An in-scope enum alias emits `type Alias = Canonical` against the current
  // spec; the canonical may itself be out of scope and brand-new, which the
  // reconciler would drop, leaving the alias dangling. Force-retain any
  // canonical referenced by an in-scope alias.
  const forcedCanonicals = new Set<string>();
  if (isScopedRun(ctx)) {
    for (const [aliasName, canonical] of aliasOf) {
      if (isEnumInScope(aliasName, ctx)) forcedCanonicals.add(canonical);
    }
  }
  const files: GeneratedFile[] = [];

  // Group all enums into a single file per SDK
  const lines: string[] = [];
  lines.push(`package ${ctx.namespace}`);
  lines.push('');

  // Build one NamedBlock per emitted enum type so a scoped run can reconcile
  // them against the prior enums.go (drop brand-new out-of-scope enums, retain
  // renamed/removed ones still referenced by un-regenerated code). A full run
  // emits every block unchanged.
  const enumBlocks: NamedBlock[] = [];

  for (const enumDef of enums) {
    // If this enum is an alias, emit a simple type alias
    const canonicalName = aliasOf.get(enumDef.name);
    if (canonicalName) {
      const aliasType = className(enumDef.name);
      const canonicalType = className(canonicalName);
      // Skip when different IR names map to the same Go type (e.g. synthetic
      // enums from enrichModelsFromSpec whose underscore names collapse to the
      // same PascalCase as the original enum).
      if (aliasType === canonicalType) continue;
      enumBlocks.push({
        names: [aliasType],
        text: [`// ${aliasType} is an alias for ${canonicalType}.`, `type ${aliasType} = ${canonicalType}`].join('\n'),
        inScope: isEnumInScope(enumDef.name, ctx),
      });
      continue;
    }

    const typeName = className(enumDef.name);

    if (enumDef.values.length === 0) {
      const humanized = humanize(enumDef.name);
      enumBlocks.push({
        names: [typeName],
        text: [`// ${typeName} represents ${humanized} values.`, `type ${typeName} = string`].join('\n'),
        inScope: isEnumInScope(enumDef.name, ctx) || forcedCanonicals.has(enumDef.name),
      });
      continue;
    }

    // Deduplicate values
    const seenValues = new Set<string>();
    const uniqueValues: typeof enumDef.values = [];
    for (const v of enumDef.values) {
      const vs = String(v.value);
      if (!seenValues.has(vs)) {
        seenValues.add(vs);
        uniqueValues.push(v);
      }
    }

    const humanized = humanize(enumDef.name);
    const blockLines: string[] = [];
    blockLines.push(`// ${typeName} represents ${humanized} values.`);
    blockLines.push(`type ${typeName} string`);
    blockLines.push('');
    blockLines.push('const (');

    const usedNames = new Set<string>();
    for (const v of uniqueValues) {
      let constSuffix = className(String(v.value));
      // Avoid collision with the type itself
      if (usedNames.has(`${typeName}${constSuffix}`)) {
        let suffix = 2;
        while (usedNames.has(`${typeName}${constSuffix}${suffix}`)) suffix++;
        constSuffix = `${constSuffix}${suffix}`;
      }
      const constName = `${typeName}${constSuffix}`;
      usedNames.add(constName);
      const valueStr = typeof v.value === 'string' ? `"${v.value}"` : String(v.value);
      if (v.description) {
        blockLines.push(`\t// ${constName} is ${v.description}.`);
      }
      if (v.deprecated) {
        if (v.description) blockLines.push(`\t//`);
        blockLines.push(`\t// Deprecated: this value is deprecated.`);
      }
      blockLines.push(`\t${constName} ${typeName} = ${valueStr}`);
    }
    blockLines.push(')');
    enumBlocks.push({
      names: [typeName],
      text: blockLines.join('\n'),
      inScope: isEnumInScope(enumDef.name, ctx) || forcedCanonicals.has(enumDef.name),
    });
  }

  const reconciled = reconcileFlatBlocks(enumBlocks, 'enums.go', ctx);
  for (const text of reconciled) {
    lines.push(text);
    lines.push('');
  }

  files.push({
    path: 'enums.go',
    content: lines.join('\n'),
    overwriteExisting: true,
  });
  const eventConstantsFile = generateEventConstantsFile(enums, ctx);
  if (eventConstantsFile) files.push(eventConstantsFile);

  return files;
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
  let result = s.replace(/([a-z])([A-Z])/g, '$1 $2');
  result = result.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  result = result.toLowerCase();
  for (const [pattern, replacement] of HUMANIZE_RESTORE) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function collectEnumAliasOf(enums: Enum[]): Map<string, string> {
  const hashGroups = new Map<string, string[]>();
  for (const enumDef of enums) {
    const hash = [...enumDef.values]
      .map((v) => String(v.value))
      .sort()
      .join('|');
    if (!hashGroups.has(hash)) hashGroups.set(hash, []);
    hashGroups.get(hash)!.push(enumDef.name);
  }

  const aliasOf = new Map<string, string>();
  for (const [, names] of hashGroups) {
    if (names.length <= 1) continue;
    const sorted = [...names].sort();
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      aliasOf.set(sorted[i], canonical);
    }
  }
  return aliasOf;
}

const EVENTS_FILE_PATH = 'pkg/events/events.go';

function generateEventConstantsFile(enums: Enum[], ctx: EmitterContext): GeneratedFile | null {
  const enumDef = findWebhookEventEnum(enums);
  if (!enumDef) return null;

  // Scoped-run gate for the flat events file. Unlike models/enums, an event
  // value can't be mapped to a single selected service, so there is no
  // per-event "in scope" signal. The correct Option-B behavior is therefore to
  // keep this aggregate byte-stable in a scoped run: emit only event constants
  // that already existed in the prior events.go (dropping brand-new additions
  // such as `session.reauthenticated` from an out-of-scope service) and never
  // drop a constant that was present before. Equivalent to: in a scoped run,
  // emit exactly the prior file's constant set.
  let priorEventConsts: Set<string> | null = null;
  if (isScopedRun(ctx)) {
    const prior = readPriorFile(EVENTS_FILE_PATH, ctx);
    if (prior !== null) {
      priorEventConsts = collectPriorEventConstNames(prior);
    }
  }

  const lines: string[] = [];
  lines.push('package events');
  lines.push('');
  lines.push('// Event is a WorkOS event type.');
  lines.push('type Event string');
  lines.push('');
  lines.push('const (');

  const seenValues = new Set<string>();
  const usedNames = new Set<string>();
  for (const value of enumDef.values) {
    const valueStr = String(value.value);
    if (seenValues.has(valueStr)) continue;
    seenValues.add(valueStr);

    const constName = uniqueEventConstantName(valueStr, usedNames);

    // Scoped run: skip a constant that wasn't in the prior file (a brand-new,
    // out-of-scope event). When there's no prior file to compare against, fall
    // through and emit everything (first generation / non-target run).
    if (priorEventConsts !== null && !priorEventConsts.has(constName)) {
      continue;
    }
    usedNames.add(constName);

    if (value.description) {
      lines.push(`\t// ${constName} is ${value.description}.`);
    }
    if (value.deprecated) {
      if (value.description) lines.push('\t//');
      lines.push('\t// Deprecated: this value is deprecated.');
    }
    // Keep constants untyped so callers can use them as plain strings,
    // events.Event values, or typed root-package enum values.
    lines.push(`\t${constName} = "${escapeGoString(valueStr)}"`);
  }

  lines.push(')');
  lines.push('');

  return {
    path: EVENTS_FILE_PATH,
    content: lines.join('\n'),
    overwriteExisting: true,
  };
}

/**
 * Collect the constant names declared in a prior `pkg/events/events.go`. Each
 * event constant is emitted as `\tConstName = "wire.value"` inside the single
 * `const (...)` block, so a simple line scan recovers the prior name set used
 * to keep the file byte-stable across scoped runs.
 */
function collectPriorEventConstNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const raw of content.split('\n')) {
    const m = raw.trim().match(/^(\w+)\s*=\s*"/);
    if (m) names.add(m[1]);
  }
  return names;
}

function findWebhookEventEnum(enums: Enum[]): Enum | null {
  return (
    enums.find((enumDef) => enumDef.name === 'CreateWebhookEndpointEvents') ??
    enums.find(
      (enumDef) =>
        isWebhookEventEnumName(enumDef.name) &&
        enumDef.values.length > 0 &&
        enumDef.values.every((value) => typeof value.value === 'string' && value.value.includes('.')),
    ) ??
    null
  );
}

function isWebhookEventEnumName(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.includes('webhook') && normalized.includes('event');
}

function uniqueEventConstantName(value: string, usedNames: Set<string>): string {
  const base = className(value);
  if (!usedNames.has(base)) return base;

  let suffix = 2;
  while (usedNames.has(`${base}${suffix}`)) suffix++;
  return `${base}${suffix}`;
}

function escapeGoString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function assignEnumsToServices(enums: Enum[], services: Service[]): Map<string, string> {
  const enumToService = new Map<string, string>();
  const enumNames = new Set(enums.map((e) => e.name));

  for (const service of services) {
    for (const op of service.operations) {
      const refs = new Set<string>();
      const collect = (ref: any) => {
        walkTypeRef(ref, { enum: (r: any) => refs.add(r.name) });
      };
      if (op.requestBody) collect(op.requestBody);
      collect(op.response);
      for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
        collect(p.type);
      }
      for (const name of refs) {
        if (enumNames.has(name) && !enumToService.has(name)) {
          enumToService.set(name, service.name);
        }
      }
    }
  }

  return enumToService;
}

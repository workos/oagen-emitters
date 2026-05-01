import type { Enum, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import { walkTypeRef } from '@workos/oagen';
import { className } from './naming.js';
import { baselineEnumNamesFrom, buildEnumAliasMap } from '../shared/enum-dedup.js';

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

  const aliasOf = collectEnumAliasOf(enums, ctx);
  const files: GeneratedFile[] = [];

  // Group all enums into a single file per SDK
  const lines: string[] = [];
  lines.push(`package ${ctx.namespace}`);
  lines.push('');

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
      lines.push(`// ${aliasType} is an alias for ${canonicalType}.`);
      lines.push(`type ${aliasType} = ${canonicalType}`);
      lines.push('');
      continue;
    }

    const typeName = className(enumDef.name);

    if (enumDef.values.length === 0) {
      const humanized = humanize(enumDef.name);
      lines.push(`// ${typeName} represents ${humanized} values.`);
      lines.push(`type ${typeName} = string`);
      lines.push('');
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
    lines.push(`// ${typeName} represents ${humanized} values.`);
    lines.push(`type ${typeName} string`);
    lines.push('');
    lines.push('const (');

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
        lines.push(`\t// ${constName} is ${v.description}.`);
      }
      if (v.deprecated) {
        if (v.description) lines.push(`\t//`);
        lines.push(`\t// Deprecated: this value is deprecated.`);
      }
      lines.push(`\t${constName} ${typeName} = ${valueStr}`);
    }
    lines.push(')');
    lines.push('');
  }

  files.push({
    path: 'enums.go',
    content: lines.join('\n'),
    overwriteExisting: true,
  });

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

function collectEnumAliasOf(enums: Enum[], ctx: EmitterContext): Map<string, string> {
  return buildEnumAliasMap(enums, {
    baselineCanonicalNames: baselineEnumNamesFrom(ctx.apiSurface),
    classNameOf: className,
  });
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

import type { Model, TypeRef, Enum } from '@workos/oagen';
import { propertyName } from './naming.js';

/**
 * JSON fixture generation for the generated Swift test suites (mirrors the Go
 * emitter's `fixtures.ts`, but fixtures are embedded as Swift string literals
 * instead of `testdata/` files, so no SPM test-resource wiring is needed).
 *
 * Fixtures must decode into the emitted structs, so callers pass the SAME
 * model set the model generator used (enriched + union-flattened).
 */

/** Prefix mapping for generating realistic ID fixture values. */
const ID_PREFIXES: Record<string, string> = {
  Connection: 'conn_',
  Organization: 'org_',
  OrganizationMembership: 'om_',
  User: 'user_',
  Directory: 'directory_',
  DirectoryGroup: 'dir_grp_',
  DirectoryUser: 'dir_usr_',
  Invitation: 'inv_',
  Session: 'session_',
  AuthenticationFactor: 'auth_factor_',
  EmailVerification: 'email_verification_',
  MagicAuth: 'magic_auth_',
  PasswordReset: 'password_reset_',
};

export function generateModelFixture(
  model: Model,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
  depth = 0,
): Record<string, unknown> {
  const fixture: Record<string, unknown> = {};

  // Dedup by the Swift property name to mirror the emitted struct (flattened
  // discriminated unions can repeat fields).
  const seenProps = new Set<string>();
  for (const field of model.fields) {
    const prop = propertyName(field.domainName ?? field.name);
    if (seenProps.has(prop)) continue;
    seenProps.add(prop);
    fixture[field.name] =
      field.example !== undefined
        ? field.example
        : generateFieldValue(field.type, field.name, model.name, modelMap, enumMap, depth);
  }

  if (model.discriminator) {
    const first = Object.entries(model.discriminator.mapping)[0];
    if (first) {
      const [firstValue, variantName] = first;
      fixture[model.discriminator.property] = firstValue;
      const variantModel = modelMap.get(variantName);
      if (variantModel) {
        for (const field of variantModel.fields) {
          if (!(field.name in fixture)) {
            fixture[field.name] =
              field.example !== undefined
                ? field.example
                : generateFieldValue(field.type, field.name, model.name, modelMap, enumMap, depth);
          }
        }
      }
    }
  }

  return fixture;
}

function generateFieldValue(
  ref: TypeRef,
  fName: string,
  modelName: string,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
  depth: number,
): unknown {
  switch (ref.kind) {
    case 'primitive':
      return generatePrimitiveValue(ref.type, ref.format, fName, modelName);
    case 'literal':
      return ref.value;
    case 'enum': {
      const e = enumMap.get(ref.name);
      return e?.values[0]?.value ?? 'unknown';
    }
    case 'model': {
      // Bound recursion so self-referential models terminate.
      const nested = modelMap.get(ref.name);
      if (nested && depth < 4) return generateModelFixture(nested, modelMap, enumMap, depth + 1);
      return {};
    }
    case 'array': {
      if (ref.items.kind === 'enum') {
        const e = enumMap.get(ref.items.name);
        if (e && e.values.length > 0) return e.values.map((v) => v.value);
      }
      return [generateFieldValue(ref.items, fName, modelName, modelMap, enumMap, depth)];
    }
    case 'nullable':
      return generateFieldValue(ref.inner, fName, modelName, modelMap, enumMap, depth);
    case 'union':
      if (ref.variants.length > 0) {
        return generateFieldValue(ref.variants[0], fName, modelName, modelMap, enumMap, depth);
      }
      return null;
    case 'map':
      return { key: generateFieldValue(ref.valueType, 'value', modelName, modelMap, enumMap, depth) };
  }
}

function generatePrimitiveValue(type: string, format: string | undefined, name: string, modelName: string): unknown {
  switch (type) {
    case 'string':
      if (format === 'date-time') return '2023-01-01T00:00:00.000Z';
      if (format === 'date') return '2023-01-01';
      if (format === 'uuid') return '00000000-0000-0000-0000-000000000000';
      if (format === 'byte' || format === 'binary') return 'dGVzdA==';
      if (name === 'id') return `${ID_PREFIXES[modelName] ?? ''}01234`;
      if (name.includes('id')) return `${name}_01234`;
      if (name.includes('email')) return 'test@example.com';
      if (name.includes('url') || name.includes('uri')) return 'https://example.com';
      if (name.includes('name')) return 'Test';
      return `test_${name}`;
    case 'integer':
      return 1;
    case 'number':
      return 1.5;
    case 'boolean':
      return true;
    case 'unknown':
      return {};
    default:
      return null;
  }
}

/**
 * Embed a JSON string as a Swift raw string literal, using enough `#`
 * delimiters that no content sequence can terminate the literal early
 * (`"` + hashes) or begin an escape sequence (`\` + hashes).
 */
export function swiftRawString(json: string): string {
  let hashes = '#';
  while (json.includes(`"${hashes}`) || json.includes(`\\${hashes}`)) hashes += '#';
  return `${hashes}"${json}"${hashes}`;
}

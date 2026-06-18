import type { Model, EmitterContext, GeneratedFile, TypeRef, Field } from '@workos/oagen';
import { walkTypeRef, assignModelsToServices } from '@workos/oagen';
import { className, domainFieldName, fileName, buildMountDirMap } from './naming.js';
import {
  isListWrapperModel,
  isListMetadataModel,
  collectNonPaginatedResponseModelNames,
} from '../shared/model-utils.js';

/** Folder under lib/workos/ for models not owned by any service. */
export const SHARED_MODEL_DIR = 'shared';

/**
 * Prefix → mount-target-dir map for models that `assignModelsToServices` can't
 * place (mostly webhook event payloads whose types aren't directly returned by
 * any API operation). The prefix is the PascalCase model-name prefix.
 *
 * Order matters: longest prefix wins (checked first). Prefixes not in this map
 * land in `shared/`.
 */
export const EVENT_MODEL_DIR_BY_PREFIX: ReadonlyArray<readonly [string, string]> = [
  // Longer prefixes first — prefix matching is first-hit wins.
  ['ApiKey', 'api_keys'],
  ['OrganizationDomain', 'organization_domains'],
  ['Organization', 'organizations'],
  ['Authentication', 'user_management'],
  ['Invitation', 'user_management'],
  ['MagicAuth', 'user_management'],
  ['Magic', 'user_management'],
  ['Password', 'user_management'],
  ['Email', 'user_management'],
  ['Session', 'user_management'],
  ['Action', 'user_management'],
  ['User', 'user_management'],
  ['Connection', 'sso'],
  ['Dsync', 'directory_sync'],
  ['Directory', 'directory_sync'],
  ['Flag', 'feature_flags'],
  ['Role', 'authorization'],
  ['Permission', 'authorization'],
  // Vault has no generated resource class (service is hand-maintained in the
  // Ruby SDK), but the webhook payload models ship from the spec — group them
  // under vault/ so the folder tree matches the hand-written client.
  ['Vault', 'vault'],
];

/** Pick a subfolder for a model not assigned to any service. */
export function classifyUnassignedModel(modelName: string): string {
  for (const [prefix, dir] of EVENT_MODEL_DIR_BY_PREFIX) {
    if (modelName.startsWith(prefix)) return dir;
  }
  return SHARED_MODEL_DIR;
}

/**
 * Generate Ruby model classes from IR Model definitions.
 *
 * Each model becomes a file at `lib/workos/{snake_name}.rb` containing
 * a class under `WorkOS::` with:
 *   - attr_accessor for all fields
 *   - initialize(json) that parses JSON
 *   - to_json(*) that returns a hash
 */
export function generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  if (models.length === 0) return [];

  // Enum name set — used to detect enum-typed fields (treated as plain strings in Ruby).
  const enumNames = new Set(ctx.spec.enums.map((e) => e.name));
  const modelNames = new Set(models.map((m) => m.name));

  // Model → mount target directory. Each model is assigned to the first service
  // that references it (transitively). Orphans land in `shared/`. Zeitwerk is
  // told to collapse each subfolder (in client.ts) so the namespace stays flat.
  const modelToService = assignModelsToServices(models, ctx.spec.services, ctx.modelHints);
  const mountDirMap = buildMountDirMap(ctx);
  const dirFor = (modelName: string): string => {
    const service = modelToService.get(modelName);
    if (!service) return classifyUnassignedModel(modelName);
    return mountDirMap.get(service) ?? classifyUnassignedModel(modelName);
  };

  const files: GeneratedFile[] = [];

  // Wrappers referenced as a non-paginated response (e.g. `VersionListResponse`
  // for `GET /vault/v1/kv/{id}/versions`) must still be emitted — the resource
  // code references them by name and the pagination iterator doesn't unwrap them.
  const nonPaginatedRefs = collectNonPaginatedResponseModelNames(ctx.spec.services);
  const skipAsListWrapper = (m: Model): boolean => isListWrapperModel(m) && !nonPaginatedRefs.has(m.name);

  // Dedup identical models (by recursive structural hash).
  const recursiveHashes = buildRecursiveHashMap(models, enumNames);
  const hashGroups = new Map<string, string[]>();
  for (const m of models) {
    if (skipAsListWrapper(m) || isListMetadataModel(m)) continue;
    const h = recursiveHashes.get(m.name) ?? '';
    if (!hashGroups.has(h)) hashGroups.set(h, []);
    hashGroups.get(h)!.push(m.name);
  }
  const aliasOf = new Map<string, string>();
  for (const names of hashGroups.values()) {
    if (names.length <= 1) continue;
    const sorted = [...names].sort();
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) aliasOf.set(sorted[i], canonical);
  }

  for (const model of models) {
    if (skipAsListWrapper(model) || isListMetadataModel(model)) continue;

    const cls = className(model.name);
    const file = fileName(model.name);

    // Ruby constant alias for duplicate models. Zeitwerk resolves the
    // canonical on reference; the alias file just assigns the constant.
    const canonical = aliasOf.get(model.name);
    if (canonical) {
      const canonCls = className(canonical);
      const lines: string[] = [];
      lines.push('module WorkOS');
      lines.push(`  ${cls} = ${canonCls}`);
      lines.push('end');
      files.push({
        path: `lib/workos/${dirFor(model.name)}/${file}.rb`,
        content: lines.join('\n'),
        integrateTarget: true,
        overwriteExisting: true,
      });
      continue;
    }

    // Deduplicate field names that collide after snake_case.
    const seenFieldNames = new Set<string>();
    const fields = model.fields.filter((f) => {
      // Dedup on the DOMAIN accessor name (honors fieldHints override).
      const n = domainFieldName(f);
      if (seenFieldNames.has(n)) return false;
      seenFieldNames.add(n);
      return true;
    });

    const lines: string[] = [];
    lines.push('module WorkOS');
    lines.push(`  class ${cls} < WorkOS::Types::BaseModel`);
    lines.push('');

    // Split fields into non-deprecated (attr_accessor) and deprecated (explicit accessors with warn).
    const accessorFields = fields.filter((f) => !f.deprecated);
    const deprecatedFields = fields.filter((f) => f.deprecated);

    // HASH_ATTRS maps wire names (symbols) to Ruby attribute names (symbols).
    // HashProvider uses this for to_h, to_json, and inspect.
    lines.push('    HASH_ATTRS = {');
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      // DOMAIN attr symbol (honors fieldHints); the key below is the WIRE name.
      const fname = domainFieldName(field);
      const sep = i === fields.length - 1 ? '' : ',';
      lines.push(`      ${rubyHashLiteralKey(field.name)} :${fname}${sep}`);
    }
    lines.push('    }.freeze');
    lines.push('');

    // Emit @deprecated YARD tags for any deprecated fields before the accessor block.
    if (deprecatedFields.length > 0) {
      for (const f of deprecatedFields) {
        const desc = f.description ? ` ${f.description.split('\n')[0].trim()}` : '';
        lines.push(`    # @!attribute ${domainFieldName(f)}`);
        lines.push(`    #   @deprecated${desc}`);
      }
      lines.push('');
    }

    if (accessorFields.length > 0) {
      const attrs = accessorFields.map((f) => `:${domainFieldName(f)}`);
      if (attrs.length === 1) {
        lines.push(`    attr_accessor ${attrs[0]}`);
      } else {
        lines.push(`    attr_accessor \\`);
        for (let i = 0; i < attrs.length; i++) {
          const sep = i === attrs.length - 1 ? '' : ',';
          lines.push(`      ${attrs[i]}${sep}`);
        }
      }
      lines.push('');
    }

    // Emit deprecated field accessors with runtime warnings.
    for (const f of deprecatedFields) {
      const fname = domainFieldName(f);
      lines.push(`    def ${fname}`);
      lines.push(
        `      warn "[DEPRECATION] \\\`${fname}\\\` is deprecated and will be removed in a future version.", uplevel: 1`,
      );
      lines.push(`      @${fname}`);
      lines.push('    end');
      lines.push('');
      lines.push(`    def ${fname}=(value)`);
      lines.push(`      @${fname} = value`);
      lines.push('    end');
      lines.push('');
    }

    // initialize(json)
    lines.push('    def initialize(json)');
    lines.push('      hash = self.class.normalize(json)');
    for (const field of fields) {
      // DOMAIN ivar name (honors fieldHints); rawKey is the WIRE key read from the hash.
      const fname = domainFieldName(field);
      const rawKey = field.name;
      lines.push(`      ${deserializeAssignment(fname, rawKey, field.type, field.required, enumNames, modelNames)}`);
    }
    lines.push('    end');

    lines.push('  end');
    lines.push('end');

    files.push({
      path: `lib/workos/${dirFor(model.name)}/${file}.rb`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    });
  }

  return files;
}

/**
 * Produce a Ruby assignment line like `@foo = hash[:foo]` or the appropriate
 * nested-model construction for the field's type.
 */
function deserializeAssignment(
  rubyFieldName: string,
  rawKey: string,
  ref: TypeRef,
  required: boolean,
  enumNames: Set<string>,
  modelNames: Set<string>,
): string {
  const accessor = rubyHashAccessor('hash', rawKey);
  const expr = deserializeExpression(accessor, ref, required, enumNames, modelNames);
  return `@${rubyFieldName} = ${expr}`;
}

/** Build an expression that deserializes a TypeRef from the given accessor. */
function deserializeExpression(
  accessor: string,
  ref: TypeRef,
  required: boolean,
  enumNames: Set<string>,
  modelNames: Set<string>,
): string {
  void enumNames;
  // Unwrap nullable — nullable behaves like optional at the value level.
  if (ref.kind === 'nullable') {
    return deserializeExpression(accessor, ref.inner, false, enumNames, modelNames);
  }

  if (ref.kind === 'array') {
    const inner = ref.items;
    const itemDeser = deserializeExpression('item', inner, true, enumNames, modelNames);
    if (itemDeser === 'item') {
      return `(${accessor} || [])`;
    }
    return `(${accessor} || []).map { |item| ${itemDeser} }`;
  }

  if (ref.kind === 'map') {
    return `${accessor} || {}`;
  }

  if (ref.kind === 'model' && modelNames.has(ref.name)) {
    const cls = `WorkOS::${className(ref.name)}`;
    if (required) {
      return `${accessor} ? ${cls}.new(${accessor}) : nil`;
    }
    return `${accessor} ? ${cls}.new(${accessor}) : nil`;
  }

  if (ref.kind === 'enum' && enumNames.has(ref.name)) {
    return accessor; // enums are plain strings in Ruby (values match server)
  }

  if (ref.kind === 'union') {
    // Discriminated union: dispatch on the discriminator property to construct
    // the matching variant. Unknown values fall back to the raw hash so callers
    // can still introspect (rather than crashing on an unmapped discriminator).
    if (ref.discriminator && ref.discriminator.mapping) {
      const entries = Object.entries(ref.discriminator.mapping).filter(([, name]) => modelNames.has(name));
      if (entries.length > 0) {
        const propAccess = rubyHashAccessor(accessor, ref.discriminator.property);
        const branches = entries
          .map(([value, modelName]) => {
            const cls = `WorkOS::${className(modelName)}`;
            return `when ${JSON.stringify(value)} then ${cls}.new(${accessor})`;
          })
          .join(' ');
        const dispatcher = `(case ${propAccess} ${branches} else ${accessor} end)`;
        return `${accessor} ? ${dispatcher} : nil`;
      }
    }
    // Non-discriminated union of models: pick the first variant as a best-
    // effort typed wrapper. Preserves the pre-discriminator behavior of
    // wrapping inline-variant unions whose owner used to be a single model.
    const firstModelVariant = ref.variants.find((v) => v.kind === 'model' && modelNames.has(v.name));
    if (firstModelVariant && firstModelVariant.kind === 'model') {
      const cls = `WorkOS::${className(firstModelVariant.name)}`;
      return `${accessor} ? ${cls}.new(${accessor}) : nil`;
    }
    return accessor;
  }

  if (ref.kind === 'literal') {
    return accessor;
  }

  // primitive
  return accessor;
}

/** Produce a Ruby accessor expression `hash[:foo]` or `hash[:"weird#name"]` for a raw field name. */
function rubyHashAccessor(accessor: string, name: string): string {
  if (/^[a-z_][a-zA-Z0-9_]*$/.test(name)) {
    return `${accessor}[:${name}]`;
  }
  // Non-simple identifier: quoted symbol literal.
  return `${accessor}[:"${name.replace(/"/g, '\\"')}"]`;
}

/** Produce a Ruby hash key literal (e.g., `foo:` shorthand or `"foo#bar" =>`).
 *  Simple identifiers (including camelCase) use symbol shorthand; names with
 *  special characters fall back to string-key `=>` syntax. */
function rubyHashLiteralKey(name: string): string {
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return `${name}:`;
  }
  return `"${name.replace(/"/g, '\\"')}" =>`;
}

/** Build a recursive structural hash map for model deduplication. */
function buildRecursiveHashMap(models: Model[], enumNames: Set<string>): Map<string, string> {
  const modelByName = new Map(models.map((m) => [m.name, m]));
  const memo = new Map<string, string>();

  const hashTypeRef = (ref: TypeRef, visiting: Set<string>): string => {
    switch (ref.kind) {
      case 'primitive':
        return `P:${ref.type}${ref.format ?? ''}`;
      case 'array':
        return `A[${hashTypeRef(ref.items, visiting)}]`;
      case 'nullable':
        return `N[${hashTypeRef(ref.inner, visiting)}]`;
      case 'map':
        return `M[${hashTypeRef(ref.valueType, visiting)}]`;
      case 'literal':
        return `L:${String(ref.value)}`;
      case 'enum':
        return `E:${ref.name}`;
      case 'model': {
        if (visiting.has(ref.name)) return `R:${ref.name}`; // cycle
        return `Ref[${hashModel(ref.name, visiting)}]`;
      }
      case 'union':
        return `U[${ref.variants.map((v) => hashTypeRef(v, visiting)).join(',')}]`;
    }
    return 'unknown';
  };

  const hashField = (f: Field, visiting: Set<string>): string => {
    return `${f.name}:${f.required ? 'R' : 'O'}:${hashTypeRef(f.type, visiting)}`;
  };

  const hashModel = (name: string, visiting: Set<string>): string => {
    if (memo.has(name)) return memo.get(name)!;
    const m = modelByName.get(name);
    if (!m) return `?:${name}`;
    visiting.add(name);
    const fieldsSorted = [...m.fields].sort((a, b) => a.name.localeCompare(b.name));
    const h = fieldsSorted.map((f) => hashField(f, visiting)).join('|');
    visiting.delete(name);
    memo.set(name, h);
    return h;
  };

  void enumNames;
  void walkTypeRef;
  const out = new Map<string, string>();
  for (const m of models) {
    out.set(m.name, hashModel(m.name, new Set()));
  }
  return out;
}

import type { EmitterContext, TypeRef, Model } from '@workos/oagen';
import { className, fieldName, groupVariantClassName } from './naming.js';
import { mapTypeRefForYard } from './type-map.js';
import { collectBodyFieldTypes, groupByMount, groupTypeBaseName } from '../shared/resolved-ops.js';

/**
 * Sorbet type string for a TypeRef. Mirrors `mapSorbetType` in rbi.ts but
 * lives here so the parameter-groups module is self-contained.
 */
function mapSorbetType(ref: TypeRef): string {
  switch (ref.kind) {
    case 'primitive':
      switch (ref.type) {
        case 'string':
          return 'String';
        case 'integer':
          return 'Integer';
        case 'number':
          return 'Float';
        case 'boolean':
          return 'T::Boolean';
        case 'unknown':
          return 'T.untyped';
      }
      break;
    case 'array':
      return `T::Array[${mapSorbetType(ref.items)}]`;
    case 'model':
      return `WorkOS::${className(ref.name)}`;
    case 'enum':
      return 'String';
    case 'nullable': {
      const inner = mapSorbetType(ref.inner);
      return inner === 'T.untyped' ? inner : `T.nilable(${inner})`;
    }
    case 'literal':
      if (typeof ref.value === 'string') return 'String';
      if (ref.value === null) return 'NilClass';
      if (typeof ref.value === 'number') return Number.isInteger(ref.value) ? 'Integer' : 'Float';
      return 'T::Boolean';
    case 'union': {
      const variants = ref.variants.map((v) => mapSorbetType(v));
      const unique = [...new Set(variants)];
      if (unique.length === 1) return unique[0];
      return `T.any(${unique.join(', ')})`;
    }
    case 'map':
      return `T::Hash[String, ${mapSorbetType(ref.valueType)}]`;
  }
  return 'T.untyped';
}

export interface CollectedVariant {
  className: string;
  groupName: string;
  variantName: string;
  /** PascalCase mount target this variant is scoped under (e.g. "UserManagement"). */
  mountTarget: string;
  /**
   * Variant members in emission order: required first, then optional (members
   * named in the IR's `optionalParameters`). Optional members carry a `nil`
   * default, so they must trail the required ones in the keyword signature.
   */
  parameters: { name: string; type: TypeRef; optional: boolean }[];
}

/**
 * Build a stable groupName -> mountTarget map. Each parameter group is owned
 * by exactly one resource module — Ruby variant classes are inlined into
 * `WorkOS::<MountTarget>::<Variant>` (matching Python's per-resource layout),
 * so a dispatcher in another resource that references the same group still
 * resolves to a single canonical class.
 *
 * Mount targets are visited in alphabetical order so first-wins is
 * deterministic across runs. In the current spec no group is shared across
 * mount targets; if one ever is, the alphabetically-first owner gets the
 * class and other dispatchers reference it by full path.
 */
export function buildGroupOwnerMap(ctx: EmitterContext): Map<string, string> {
  const owner = new Map<string, string>();
  const groups = groupByMount(ctx);
  const sortedTargets = [...groups.keys()].sort();
  for (const target of sortedTargets) {
    const g = groups.get(target);
    if (!g) continue;
    for (const op of g.operations) {
      for (const grp of op.parameterGroups ?? []) {
        if (!owner.has(grp.name)) owner.set(grp.name, target);
      }
    }
  }
  return owner;
}

/**
 * Collect all variant classes a given mount target owns. Variants are
 * inlined into the resource file (and its RBI counterpart) — Zeitwerk's
 * collapse convention means subdirectories under `lib/workos/<service>/`
 * don't add a namespace level, so files there can't define
 * `WorkOS::<Service>::<Variant>`. Inline definitions sidestep that.
 *
 * Variant parameter types are taken from the IR's leaf type. When the IR's
 * leaf is a bare primitive but the request body model has a richer type
 * (array/enum/model/map), we fall back to the body type to recover fidelity
 * the IR drops. Body nullability is stripped — when a parameter group is
 * optional, the body field for the group becomes nullable, but that reflects
 * the group's optionality, not the leaf's.
 *
 * Within a variant a leaf is required unless the IR lists it in the variant's
 * `optionalParameters` — those members may be omitted when the variant is
 * selected, so they are reordered after the required ones and get a `nil`
 * default. When `optionalParameters` is absent or empty the order (and every
 * byte of emitted output) is unchanged.
 */
export function collectVariantsForMountTarget(
  ctx: EmitterContext,
  models: Model[],
  mountTarget: string,
): CollectedVariant[] {
  const owner = buildGroupOwnerMap(ctx);
  const seen = new Set<string>();
  const out: CollectedVariant[] = [];
  const groups = groupByMount(ctx);
  const g = groups.get(mountTarget);
  if (!g) return out;
  for (const op of g.operations) {
    const bodyFieldTypes = collectBodyFieldTypes(op, models);
    for (const group of op.parameterGroups ?? []) {
      if (owner.get(group.name) !== mountTarget) continue;
      for (const variant of group.variants) {
        const cls = groupVariantClassName(groupTypeBaseName(group), variant.name);
        if (seen.has(cls)) continue;
        seen.add(cls);
        // Optional members carry a `nil` default, so they trail the required
        // ones — Ruby rejects a defaulted positional before a required one and
        // a trailing order keeps the keyword signature readable.
        const optionalNames = new Set(variant.optionalParameters ?? []);
        const orderedParams = [
          ...variant.parameters.filter((p) => !optionalNames.has(p.name)),
          ...variant.parameters.filter((p) => optionalNames.has(p.name)),
        ];
        out.push({
          className: cls,
          groupName: group.name,
          variantName: variant.name,
          mountTarget,
          parameters: orderedParams.map((p) => ({
            name: p.name,
            type: pickVariantParamType(p.type, bodyFieldTypes.get(p.name)),
            optional: optionalNames.has(p.name),
          })),
        });
      }
    }
  }
  return out;
}

/**
 * Pick the type for a variant leaf parameter.
 *
 * Prefer the IR's leaf type. Use the body model's type only when the IR is a
 * bare primitive but the body has a structured type — that's the original
 * fidelity-recovery case the body fallback was added for. Strip any outer
 * nullable from the body type, since body nullability reflects the parent
 * group's optionality, not the leaf's required-ness within the variant.
 *
 * Exported so the test emitter can recover the same type the variant class
 * declares — IR primitives for fields like `role_slugs` would otherwise stub
 * as `"stub"` strings instead of the `["stub"]` arrays the class accepts.
 */
export function pickVariantParamType(irType: TypeRef, bodyType: TypeRef | undefined): TypeRef {
  if (!bodyType) return irType;
  const unwrappedBody = bodyType.kind === 'nullable' ? bodyType.inner : bodyType;
  const bodyIsStructured =
    unwrappedBody.kind === 'array' ||
    unwrappedBody.kind === 'enum' ||
    unwrappedBody.kind === 'model' ||
    unwrappedBody.kind === 'map';
  if (irType.kind === 'primitive' && bodyIsStructured) return unwrappedBody;
  return irType;
}

function readableName(name: string): string {
  return name.replace(/_/g, ' ');
}

/**
 * Wrap a variant member's type in `nullable` so the YARD/Sorbet mappers render
 * it as optional (`[String, nil]` / `T.nilable(String)`) with their existing
 * duplicate-nil handling. Already-nullable types pass through untouched.
 */
function nilableTypeRef(ref: TypeRef): TypeRef {
  return ref.kind === 'nullable' ? ref : { kind: 'nullable', inner: ref };
}

/** YARD/Sorbet type for a variant member, nilable when the member is optional. */
function variantMemberType(p: { type: TypeRef; optional: boolean }, map: (ref: TypeRef) => string): string {
  return map(p.optional ? nilableTypeRef(p.type) : p.type);
}

/**
 * Render the inline `Data.define` block for a single variant, indented for
 * inclusion inside a `class <Service>` body. Returns an array of lines with
 * 4-space indent (the resource file's class members are 4-space indented).
 */
export function emitInlineVariantClass(v: CollectedVariant): string[] {
  const lines: string[] = [];
  lines.push(`    # Identifies the ${readableName(v.groupName)} (${readableName(v.variantName)} variant).`);
  lines.push('    #');
  for (const p of v.parameters) {
    const yardType = variantMemberType(p, mapTypeRefForYard);
    lines.push(`    # @!attribute [r] ${fieldName(p.name)}`);
    lines.push(`    #   @return [${yardType}]`);
  }
  if (v.parameters.length === 0) {
    lines.push(`    ${v.className} = Data.define`);
    return lines;
  }
  const fields = v.parameters.map((p) => `:${fieldName(p.name)}`).join(', ');
  if (!v.parameters.some((p) => p.optional)) {
    lines.push(`    ${v.className} = Data.define(${fields})`);
    return lines;
  }
  // `Data` requires every member at construction time, so members the API lets
  // callers omit get a `nil` default via an `initialize` override that forwards
  // to `super` (the idiom from Ruby's own Data docs).
  const kwargs = v.parameters.map((p) => (p.optional ? `${fieldName(p.name)}: nil` : `${fieldName(p.name)}:`));
  lines.push(`    ${v.className} = Data.define(${fields}) do`);
  lines.push(`      def initialize(${kwargs.join(', ')})`);
  lines.push('        super');
  lines.push('      end');
  lines.push('    end');
  return lines;
}

/**
 * Render the inline RBI `class` block for a single variant, indented for
 * inclusion inside a `class <Service>` body in a service .rbi file. Returns
 * lines with 4-space indent.
 */
export function emitInlineVariantRbi(v: CollectedVariant): string[] {
  const lines: string[] = [];
  const fqcn = `WorkOS::${v.mountTarget}::${v.className}`;
  lines.push(`    class ${v.className}`);
  for (const p of v.parameters) {
    lines.push(`      sig { returns(${variantMemberType(p, mapSorbetType)}) }`);
    lines.push(`      def ${fieldName(p.name)}; end`);
    lines.push('');
  }
  if (v.parameters.length === 0) {
    lines.push(`      sig { returns(${fqcn}) }`);
    lines.push(`      def self.new; end`);
  } else {
    lines.push('      sig do');
    lines.push('        params(');
    for (let i = 0; i < v.parameters.length; i++) {
      const p = v.parameters[i];
      const sep = i === v.parameters.length - 1 ? '' : ',';
      lines.push(`          ${fieldName(p.name)}: ${variantMemberType(p, mapSorbetType)}${sep}`);
    }
    lines.push(`        ).returns(${fqcn})`);
    lines.push('      end');
    const kwargs = v.parameters.map((p) => `${fieldName(p.name)}:`).join(', ');
    lines.push(`      def self.new(${kwargs}); end`);
  }
  lines.push('    end');
  return lines;
}

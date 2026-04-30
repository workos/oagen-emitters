import type { Service, EmitterContext, GeneratedFile, Operation, TypeRef, Model } from '@workos/oagen';
import { className, fieldName, groupVariantClassName, groupVariantFileName } from './naming.js';
import { mapTypeRef as mapYardType, mapTypeRefForYard } from './type-map.js';
import { collectBodyFieldTypes } from '../shared/resolved-ops.js';

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
    case 'nullable':
      return `T.nilable(${mapSorbetType(ref.inner)})`;
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

interface CollectedVariant {
  className: string;
  fileName: string;
  groupName: string;
  variantName: string;
  parameters: { name: string; type: TypeRef }[];
}

/**
 * Walk every operation, collect each unique parameter-group variant once.
 * The same group name can appear in multiple operations (e.g. `resource_target`
 * in `check`/`assign_role`/`remove_role`); we dedupe by class name.
 *
 * Variant parameter types are taken from the IR's leaf type. When the IR's
 * leaf is a bare primitive but the request body model has a richer type
 * (array/enum/model/map), we fall back to the body type to recover fidelity
 * the IR drops. Body nullability is stripped — when a parameter group is
 * optional, the body field for the group becomes nullable, but within a
 * variant the leaf is always required (selecting the variant means passing it).
 */
function collectVariants(operations: Operation[], models: Model[]): CollectedVariant[] {
  const seen = new Set<string>();
  const out: CollectedVariant[] = [];
  for (const op of operations) {
    const bodyFieldTypes = collectBodyFieldTypes(op, models);
    for (const group of op.parameterGroups ?? []) {
      for (const variant of group.variants) {
        const cls = groupVariantClassName(group.name, variant.name);
        if (seen.has(cls)) continue;
        seen.add(cls);
        out.push({
          className: cls,
          fileName: groupVariantFileName(group.name, variant.name),
          groupName: group.name,
          variantName: variant.name,
          parameters: variant.parameters.map((p) => ({
            name: p.name,
            type: pickVariantParamType(p.type, bodyFieldTypes.get(p.name)),
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
 */
function pickVariantParamType(irType: TypeRef, bodyType: TypeRef | undefined): TypeRef {
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
 * Generate a `Data.define` class file for each unique parameter-group variant
 * referenced by any service's operations. Files are emitted alongside models
 * under `lib/workos/<variant>.rb` so Zeitwerk autoloads them.
 */
export function generateParameterGroupClasses(services: Service[], _ctx: EmitterContext): GeneratedFile[] {
  const operations = services.flatMap((s) => s.operations);
  const models = (_ctx.spec.models as Model[]) ?? [];
  const variants = collectVariants(operations, models);

  const files: GeneratedFile[] = [];
  for (const v of variants) {
    const lines: string[] = [];
    lines.push('module WorkOS');
    lines.push(`  # Identifies the ${readableName(v.groupName)} (${readableName(v.variantName)} variant).`);
    lines.push('  #');
    for (const p of v.parameters) {
      const yardType = mapTypeRefForYard(p.type);
      lines.push(`  # @!attribute [r] ${fieldName(p.name)}`);
      lines.push(`  #   @return [${yardType}]`);
    }
    if (v.parameters.length === 0) {
      lines.push(`  ${v.className} = Data.define`);
    } else {
      const fields = v.parameters.map((p) => `:${fieldName(p.name)}`).join(', ');
      lines.push(`  ${v.className} = Data.define(${fields})`);
    }
    lines.push('end');
    files.push({
      path: `lib/workos/${v.fileName}.rb`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    });
  }
  return files;
}

/**
 * Generate a Sorbet `.rbi` file for each variant class. Mirrors the shape
 * used by `rbi/workos/types/api_response.rbi`.
 */
export function generateParameterGroupRbi(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  const operations = services.flatMap((s) => s.operations);
  const models = (ctx.spec.models as Model[]) ?? [];
  const variants = collectVariants(operations, models);

  const files: GeneratedFile[] = [];
  for (const v of variants) {
    const lines: string[] = [];
    lines.push('# typed: strong');
    lines.push('');
    lines.push('module WorkOS');
    lines.push(`  class ${v.className}`);
    for (const p of v.parameters) {
      lines.push(`    sig { returns(${mapSorbetType(p.type)}) }`);
      lines.push(`    def ${fieldName(p.name)}; end`);
      lines.push('');
    }
    if (v.parameters.length === 0) {
      lines.push(`    sig { returns(WorkOS::${v.className}) }`);
      lines.push(`    def self.new; end`);
    } else {
      lines.push('    sig do');
      lines.push('      params(');
      for (let i = 0; i < v.parameters.length; i++) {
        const p = v.parameters[i];
        const sep = i === v.parameters.length - 1 ? '' : ',';
        lines.push(`        ${fieldName(p.name)}: ${mapSorbetType(p.type)}${sep}`);
      }
      lines.push(`      ).returns(WorkOS::${v.className})`);
      lines.push('    end');
      const kwargs = v.parameters.map((p) => `${fieldName(p.name)}:`).join(', ');
      lines.push(`    def self.new(${kwargs}); end`);
    }
    lines.push('  end');
    lines.push('end');
    files.push({
      path: `rbi/workos/${v.fileName}.rbi`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    });
  }
  return files;
}

/**
 * Build the YARD type-tag union string for a parameter group's kwarg.
 * E.g., `[WorkOS::PasswordPlaintext, WorkOS::PasswordHashed]`.
 */
export function groupYardUnion(group: { name: string; variants: { name: string }[] }): string {
  void mapYardType;
  return group.variants.map((v) => `WorkOS::${groupVariantClassName(group.name, v.name)}`).join(', ');
}

/**
 * Build the Sorbet `T.any(...)` type for a parameter group's kwarg.
 */
export function groupSorbetUnion(group: { name: string; variants: { name: string }[] }): string {
  const variants = group.variants.map((v) => `WorkOS::${groupVariantClassName(group.name, v.name)}`);
  if (variants.length === 1) return variants[0];
  return `T.any(${variants.join(', ')})`;
}

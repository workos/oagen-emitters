import type { ApiSpec, EmitterContext, GeneratedFile, TypeRef, Model, Service } from '@workos/oagen';
import { mapTypeRef as irMapTypeRef } from '@workos/oagen';
import {
  className,
  fieldName,
  domainFieldName,
  fileName,
  safeParamName,
  scopedGroupVariantClassName,
  resolveMethodName,
  servicePropertyName,
  buildExportedClassNameSet,
  resolveServiceTarget,
} from './naming.js';
import {
  buildResolvedLookup,
  groupByMount,
  getMountTarget,
  isMountInScope,
  isModelInScope,
  lookupResolved,
  buildHiddenParams,
  collectGroupedParamNames,
} from '../shared/resolved-ops.js';
import { isListWrapperModel, isListMetadataModel } from '../shared/model-utils.js';
import { buildGroupOwnerMap, collectVariantsForMountTarget, emitInlineVariantRbi } from './parameter-groups.js';

/**
 * Map an IR TypeRef to a Sorbet type string for RBI files.
 */
function mapSorbetType(ref: TypeRef): string {
  return irMapTypeRef<string>(ref, {
    primitive: (r) => {
      switch (r.type) {
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
    },
    array: (_ref, items) => `T::Array[${items}]`,
    model: (r) => `WorkOS::${className(r.name)}`,
    enum: () => 'String',
    union: (r, variants) => {
      if (r.compositionKind === 'allOf') return variants[0] ?? 'T.untyped';
      const unique = [...new Set(variants)];
      if (unique.length === 1) return unique[0];
      return `T.any(${unique.join(', ')})`;
    },
    nullable: (_ref, inner) => wrapNilable(inner),
    literal: (r) =>
      typeof r.value === 'string'
        ? 'String'
        : r.value === null
          ? 'NilClass'
          : typeof r.value === 'number'
            ? Number.isInteger(r.value)
              ? 'Integer'
              : 'Float'
            : 'T::Boolean',
    map: (_ref, value) => `T::Hash[String, ${value}]`,
  });
}

/**
 * Generate .rbi files for Sorbet type checking.
 */
export function generateRbiFiles(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  const modelNames = new Set(spec.models.map((m) => m.name));
  const _enumNames = new Set(spec.enums.map((e) => e.name));

  // 1. Generate model RBI files
  const models = (spec.models as Model[]).filter((m) => !isListWrapperModel(m) && !isListMetadataModel(m));

  for (const model of models) {
    const cls = className(model.name);
    const lines: string[] = [];
    lines.push('# typed: strong');
    lines.push('');
    lines.push('module WorkOS');
    lines.push(`  class ${cls}`);

    // Constructor
    lines.push('    sig { params(json: T.any(String, T::Hash[Symbol, T.untyped])).void }');
    lines.push('    def initialize(json); end');
    lines.push('');

    // Field accessors
    const seenFieldNames = new Set<string>();
    for (const f of model.fields) {
      // DOMAIN accessor name in the .rbi (honors fieldHints override).
      const fname = domainFieldName(f);
      if (seenFieldNames.has(fname)) continue;
      seenFieldNames.add(fname);
      const sorbetType = f.required ? mapSorbetType(f.type) : wrapNilable(mapSorbetType(f.type));
      lines.push(`    sig { returns(${sorbetType}) }`);
      lines.push(`    def ${fname}; end`);
      lines.push('');
      lines.push(`    sig { params(value: ${sorbetType}).returns(${sorbetType}) }`);
      lines.push(`    def ${fname}=(value); end`);
      lines.push('');
    }

    // to_h and to_json
    lines.push('    sig { returns(T::Hash[Symbol, T.untyped]) }');
    lines.push('    def to_h; end');
    lines.push('');
    lines.push('    sig { params(args: T.untyped).returns(String) }');
    lines.push('    def to_json(*args); end');

    lines.push('  end');
    lines.push('end');

    // FR-1.4: write the per-model .rbi only when in scope. The client.rbi
    // aggregate (section 3) stays on the full set so sigs for out-of-scope
    // services whose .rb/.rbi still exist keep resolving.
    if (isModelInScope(model.name, ctx)) {
      files.push({
        path: `rbi/workos/${fileName(model.name)}.rbi`,
        content: lines.join('\n'),
        integrateTarget: true,
        overwriteExisting: true,
      });
    }
  }

  // 2. Generate service RBI files
  const groups = groupByMount(ctx);
  const lookup = buildResolvedLookup(ctx);
  const modelByName = new Map<string, Model>();
  for (const m of spec.models as Model[]) modelByName.set(m.name, m);
  const listWrapperModels = new Map<string, Model>();
  for (const m of spec.models as Model[]) {
    if (isListWrapperModel(m)) listWrapperModels.set(m.name, m);
  }
  const groupOwners = buildGroupOwnerMap(ctx);
  const exportedClasses = buildExportedClassNameSet(ctx);

  for (const [mountTarget, group] of groups) {
    // Scoped run: emit per-service .rbi only for selected mount targets. The
    // client.rbi aggregate loop below intentionally stays on the FULL `groups`
    // set so it keeps emitting sigs for every service whose .rb still exists.
    if (!isMountInScope(mountTarget, ctx)) continue;
    const resolvedTarget = resolveServiceTarget(mountTarget, exportedClasses);
    const cls = className(resolvedTarget);
    const lines: string[] = [];
    lines.push('# typed: strong');
    lines.push('');
    lines.push('module WorkOS');
    lines.push(`  class ${cls}`);

    // Inline parameter-group variant RBI blocks owned by this mount target.
    // Mirrors the runtime `class ... PasswordPlaintext = Data.define(...) end`
    // layout in lib/workos/<service>.rb.
    const variants = collectVariantsForMountTarget(ctx, spec.models as Model[], mountTarget);
    for (const v of variants) {
      // Rewrite mountTarget to the (possibly pluralized) service class so the
      // RBI's `WorkOS::<Service>::<Variant>` reference matches the runtime.
      v.mountTarget = resolvedTarget;
      for (const line of emitInlineVariantRbi(v)) lines.push(line);
      lines.push('');
    }

    lines.push('    sig { params(client: WorkOS::BaseClient).void }');
    lines.push('    def initialize(client); end');
    lines.push('');

    const emittedMethods = new Set<string>();

    for (const op of group.operations) {
      const ownerService =
        group.resolvedOps.find((r) => r.operation === op)?.service ??
        spec.services.find((s) => s.operations.includes(op)) ??
        spec.services[0];
      const method = resolveMethodName(op, ownerService, ctx);
      if (emittedMethods.has(method)) continue;

      const resolved = lookupResolved(op, lookup);
      if (resolved?.urlBuilder) {
        emittedMethods.add(method);
        continue;
      }
      emittedMethods.add(method);

      const hiddenParams = buildHiddenParams(resolved);
      const groupedParamNames = collectGroupedParamNames(op);
      const queryParams = (op.queryParams ?? []).filter((q) => !groupedParamNames.has(q.name));
      // Drop body fields that collide with a parameter-group name; the group
      // dispatcher kwarg handles them. See ruby/resources.ts for the matching
      // filter on the runtime side.
      const bodyFields = getRequestBodyFieldsFlat(op, hiddenParams, modelByName).filter(
        (f) => !groupedParamNames.has(f.name),
      );
      const parameterGroups = op.parameterGroups ?? [];
      const groupSorbetType = (group: (typeof parameterGroups)[number]): string => {
        const owner = groupOwners.get(group.name);
        if (!owner) {
          throw new Error(`No owner mount target found for parameter group '${group.name}'`);
        }
        const resolvedOwner = resolveServiceTarget(owner, exportedClasses);
        const variants = group.variants.map((v) => scopedGroupVariantClassName(resolvedOwner, group.name, v.name));
        if (variants.length === 1) return variants[0];
        return `T.any(${variants.join(', ')})`;
      };

      // Build parameter list for sig. Order mirrors the runtime emitter:
      // path → required body → required query → required groups → optional
      // body → optional query → optional groups → request_options.
      const sigParams: string[] = [];
      const seen = new Set<string>();

      for (const p of op.pathParams ?? []) {
        const n = safeParamName(p.name);
        if (seen.has(n)) continue;
        seen.add(n);
        sigParams.push(`${n}: ${mapSorbetType(p.type)}`);
      }
      for (const f of bodyFields) {
        if (hiddenParams.has(f.name)) continue;
        if (!f.required) continue;
        const n = fieldName(f.name);
        if (seen.has(n)) continue;
        seen.add(n);
        sigParams.push(`${n}: ${mapSorbetType(f.type)}`);
      }
      for (const q of queryParams) {
        if (hiddenParams.has(q.name)) continue;
        if (!q.required) continue;
        const n = safeParamName(q.name);
        if (seen.has(n)) continue;
        seen.add(n);
        sigParams.push(`${n}: ${mapSorbetType(q.type)}`);
      }
      for (const group of parameterGroups) {
        if (group.optional) continue;
        const n = fieldName(group.name);
        if (seen.has(n)) continue;
        seen.add(n);
        sigParams.push(`${n}: ${groupSorbetType(group)}`);
      }
      for (const f of bodyFields) {
        if (hiddenParams.has(f.name)) continue;
        if (f.required) continue;
        const n = fieldName(f.name);
        if (seen.has(n)) continue;
        seen.add(n);
        sigParams.push(`${n}: ${wrapNilable(mapSorbetType(f.type))}`);
      }
      for (const q of queryParams) {
        if (hiddenParams.has(q.name)) continue;
        if (q.required) continue;
        const n = safeParamName(q.name);
        if (seen.has(n)) continue;
        seen.add(n);
        sigParams.push(`${n}: ${wrapNilable(mapSorbetType(q.type))}`);
      }
      for (const group of parameterGroups) {
        if (!group.optional) continue;
        const n = fieldName(group.name);
        if (seen.has(n)) continue;
        seen.add(n);
        sigParams.push(`${n}: ${wrapNilable(groupSorbetType(group))}`);
      }
      sigParams.push('request_options: T::Hash[Symbol, T.untyped]');

      // Return type
      const retType = mapSorbetReturnType(op.response, listWrapperModels, modelNames);

      lines.push('    sig do');
      lines.push('      params(');
      for (let i = 0; i < sigParams.length; i++) {
        const sep = i === sigParams.length - 1 ? '' : ',';
        lines.push(`        ${sigParams[i]}${sep}`);
      }
      lines.push(`      ).returns(${retType})`);
      lines.push('    end');
      lines.push(`    def ${method}(${sigParams.map((p) => p.split(':')[0].trim() + ':').join(', ')}); end`);
      lines.push('');
    }

    lines.push('  end');
    lines.push('end');

    files.push({
      path: `rbi/workos/${fileName(resolvedTarget)}.rbi`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    });
  }

  // 3. Generate client RBI file
  {
    const lines: string[] = [];
    lines.push('# typed: strong');
    lines.push('');
    lines.push('module WorkOS');
    lines.push('  class Client < BaseClient');

    // Restrict the client.rbi accessor sigs to the emit surface (`spec` is the
    // core's surfaceSpec = selected ∪ on-disk). A present service keeps its sig
    // (its .rbi stays on disk); a service the spec has but this SDK never
    // generated is dropped — otherwise `sig { returns(WorkOS::Agents) }` names a
    // constant with no class file → Sorbet "unable to resolve constant" under
    // `# typed: strong`.
    const surfaceMounts = new Set((spec.services as Service[]).map((s) => getMountTarget(s, ctx)));
    for (const [mountTarget] of groups) {
      if (!surfaceMounts.has(mountTarget)) continue;
      const resolvedTarget = resolveServiceTarget(mountTarget, exportedClasses);
      const cls = className(resolvedTarget);
      const prop = servicePropertyName(mountTarget);
      lines.push(`    sig { returns(WorkOS::${cls}) }`);
      lines.push(`    def ${prop}; end`);
      lines.push('');
    }

    lines.push('  end');
    lines.push('end');

    files.push({
      path: 'rbi/workos/client.rbi',
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    });
  }

  return files;
}

/** Unwrap T.nilable(...) if already wrapped, to avoid double-wrapping. */
function unwrapNilable(type: string): string {
  if (type === 'T.untyped') return type;
  const match = type.match(/^T\.nilable\((.+)\)$/);
  return match ? match[1] : type;
}

/** Wrap a type in T.nilable(), skipping T.untyped (which already includes nil) and avoiding double-wrapping. */
function wrapNilable(type: string): string {
  if (type === 'T.untyped') return type;
  return `T.nilable(${unwrapNilable(type)})`;
}

/** Map a response TypeRef to a Sorbet return type. */
function mapSorbetReturnType(ref: TypeRef, listWrapperModels: Map<string, Model>, modelNames: Set<string>): string {
  if (ref.kind === 'model' && listWrapperModels.has(ref.name)) {
    return 'WorkOS::Types::ListStruct';
  }
  if (ref.kind === 'model' && modelNames.has(ref.name)) {
    return `WorkOS::${className(ref.name)}`;
  }
  if (ref.kind === 'array' && ref.items.kind === 'model' && modelNames.has(ref.items.name)) {
    return `T::Array[WorkOS::${className(ref.items.name)}]`;
  }
  if (ref.kind === 'nullable') {
    return wrapNilable(mapSorbetReturnType(ref.inner, listWrapperModels, modelNames));
  }
  if (ref.kind === 'primitive' && ref.type === 'unknown') {
    return 'NilClass';
  }
  return mapSorbetType(ref);
}

/** Get body fields (flat) for RBI sig generation. */
function getRequestBodyFieldsFlat(
  op: { requestBody?: TypeRef },
  hiddenParams: Set<string>,
  modelByName: Map<string, Model>,
): { name: string; required: boolean; type: TypeRef }[] {
  void hiddenParams;
  const ref = op.requestBody;
  if (!ref) return [];
  if (ref.kind === 'model') {
    const model = modelByName.get(ref.name);
    if (!model) return [];
    return model.fields.map((f) => ({ name: f.name, required: f.required, type: f.type }));
  }
  if (ref.kind === 'nullable') {
    return getRequestBodyFieldsFlat({ requestBody: ref.inner }, hiddenParams, modelByName);
  }
  if (ref.kind === 'union') {
    for (const v of ref.variants) {
      if (v.kind === 'model') {
        const model = modelByName.get(v.name);
        if (model) return model.fields.map((f) => ({ name: f.name, required: f.required, type: f.type }));
      }
    }
  }
  return [];
}

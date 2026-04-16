import type { ApiSpec, EmitterContext, GeneratedFile, TypeRef, Model } from '@workos/oagen';
import { mapTypeRef as irMapTypeRef } from '@workos/oagen';
import { className, fieldName, fileName, safeParamName, resolveMethodName } from './naming.js';
import {
  buildResolvedLookup,
  groupByMount,
  lookupResolved,
  buildHiddenParams,
  collectGroupedParamNames,
} from '../shared/resolved-ops.js';
import { isListWrapperModel, isListMetadataModel } from '../shared/model-utils.js';

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
    nullable: (_ref, inner) => `T.nilable(${inner})`,
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
      const fname = fieldName(f.name);
      if (seenFieldNames.has(fname)) continue;
      seenFieldNames.add(fname);
      const sorbetType = f.required ? mapSorbetType(f.type) : `T.nilable(${unwrapNilable(mapSorbetType(f.type))})`;
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

    files.push({
      path: `rbi/workos/${fileName(model.name)}.rbi`,
      content: lines.join('\n'),
      integrateTarget: true,
      overwriteExisting: true,
    });
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

  for (const [mountTarget, group] of groups) {
    const cls = className(mountTarget);
    const lines: string[] = [];
    lines.push('# typed: strong');
    lines.push('');
    lines.push('module WorkOS');
    lines.push(`  class ${cls}`);

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
      const bodyFields = getRequestBodyFieldsFlat(op, hiddenParams, modelByName);

      // Build parameter list for sig
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
      for (const f of bodyFields) {
        if (hiddenParams.has(f.name)) continue;
        if (f.required) continue;
        const n = fieldName(f.name);
        if (seen.has(n)) continue;
        seen.add(n);
        sigParams.push(`${n}: T.nilable(${unwrapNilable(mapSorbetType(f.type))})`);
      }
      for (const q of queryParams) {
        if (hiddenParams.has(q.name)) continue;
        if (q.required) continue;
        const n = safeParamName(q.name);
        if (seen.has(n)) continue;
        seen.add(n);
        sigParams.push(`${n}: T.nilable(${unwrapNilable(mapSorbetType(q.type))})`);
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
      path: `rbi/workos/${fileName(mountTarget)}.rbi`,
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

    for (const [mountTarget] of groups) {
      const cls = className(mountTarget);
      const prop = mountTarget
        .replace(/-/g, '_')
        .replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`)
        .replace(/^_/, '');
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
  const match = type.match(/^T\.nilable\((.+)\)$/);
  return match ? match[1] : type;
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
    return `T.nilable(${mapSorbetReturnType(ref.inner, listWrapperModels, modelNames)})`;
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

import type { EmitterContext, GeneratedFile, TypeRef } from '@workos/oagen';
import { groupByMount } from '../shared/resolved-ops.js';
import { accessorName, resolveMethodName, typeName, withResolvedOps } from './naming.js';
import { collectMethodParams, orderMethodParams } from './resources.js';

/**
 * Emit `.oagen-android-smoke.json` — an authoritative, transform-aware call plan
 * the Kotlin smoke runner consumes to build driver calls.
 *
 * The smoke runner parses the spec WITHOUT the consumer's schemaNameTransform /
 * operationHints, so it cannot re-derive the generated method names, enum type
 * names, or hidden params. This sidecar is produced with the full emitter
 * context, so every method/service/param/enum-type it lists matches the generated
 * SDK exactly. Split (wrapper) and URL-builder operations are omitted (the runner
 * skips them). Not merged into a live SDK (`integrateTarget: false`).
 */
export function generateSmokePlan(ctx: EmitterContext): GeneratedFile {
  const rctx = withResolvedOps(ctx);
  const operations: Record<string, SmokePlanEntry> = {};

  for (const group of groupByMount(rctx).values()) {
    const service = accessorName(group.name);
    for (const resolved of group.resolvedOps) {
      if (resolved.urlBuilder) continue;
      if (resolved.wrappers && resolved.wrappers.length > 0) continue;
      const op = resolved.operation;
      const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
      const params = orderMethodParams(collectMethodParams(resolved, rctx)).map((p) => ({
        label: stripBackticks(p.name),
        wire: p.wire,
        source: p.kind,
        optional: p.optional,
        serialize: serializeDescriptor(p.ref),
      }));
      operations[httpKey] = {
        service: stripBackticks(service),
        method: stripBackticks(resolveMethodName(op, group.name, rctx)),
        params,
      };
    }
  }

  return {
    path: '.oagen-android-smoke.json',
    content: JSON.stringify({ version: 1, operations }, null, 2) + '\n',
    integrateTarget: false,
    overwriteExisting: true,
    headerPlacement: 'skip',
  };
}

/** The plan records logical selectors; the driver re-escapes if it needs to. */
function stripBackticks(name: string): string {
  return name.split('`').join('');
}

interface SmokePlanEntry {
  service: string;
  method: string;
  params: Array<{
    label: string;
    wire: string;
    source: 'path' | 'query' | 'body' | 'bodyRaw';
    optional: boolean;
    serialize: Serialize;
  }>;
}

type Serialize =
  | { kind: 'string' | 'int' | 'long' | 'double' | 'bool' | 'instant' | 'bytes' | 'json' | 'unsupported' }
  | { kind: 'enum'; enumType: string }
  | { kind: 'array'; element: Serialize }
  | { kind: 'map'; value: Serialize };

/**
 * Describe how to serialize a runtime value to a Kotlin literal for a given IR
 * type. Enum type names are resolved with the emitter's `typeName`, so they match
 * the generated enums (which the smoke runner cannot otherwise compute).
 */
function serializeDescriptor(ref: TypeRef): Serialize {
  const base = ref.kind === 'nullable' ? ref.inner : ref;
  switch (base.kind) {
    case 'enum':
      return { kind: 'enum', enumType: typeName(base.name) };
    case 'primitive':
      if (base.type === 'unknown') return { kind: 'json' };
      if (base.format === 'date-time' || base.format === 'date') return { kind: 'instant' };
      if (base.format === 'binary' || base.format === 'byte') return { kind: 'bytes' };
      if (base.type === 'string') return { kind: 'string' };
      if (base.type === 'integer') return { kind: base.format === 'int32' ? 'int' : 'long' };
      if (base.type === 'number') return { kind: 'double' };
      if (base.type === 'boolean') return { kind: 'bool' };
      return { kind: 'unsupported' };
    case 'array':
      return { kind: 'array', element: serializeDescriptor(base.items) };
    case 'map':
      return { kind: 'map', value: serializeDescriptor(base.valueType) };
    case 'literal':
      if (typeof base.value === 'string') return { kind: 'string' };
      if (typeof base.value === 'number') return Number.isInteger(base.value) ? { kind: 'long' } : { kind: 'double' };
      if (typeof base.value === 'boolean') return { kind: 'bool' };
      return { kind: 'unsupported' };
    default:
      // model / union — cannot construct a value literal in the driver
      return { kind: 'unsupported' };
  }
}

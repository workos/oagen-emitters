import type { Operation, EmitterContext, Service, ResolvedOperation, Model, TypeRef } from '@workos/oagen';
import { toPascalCase } from '@workos/oagen';

/**
 * Fail fast when two distinct paths in the same mount resolve to the same SDK
 * method name. Emitters can sometimes paper over this with per-language
 * deduplication, but manifests and cross-language parity become inconsistent.
 */
export function assertUniqueResolvedMethods(ctx: EmitterContext): void {
  const seen = new Map<string, { path: string; httpMethod: string }>();

  for (const resolved of ctx.resolvedOperations ?? []) {
    const key = `${resolved.mountOn}.${resolved.methodName}`;
    const current = {
      path: resolved.operation.path,
      httpMethod: resolved.operation.httpMethod.toUpperCase(),
    };
    const existing = seen.get(key);

    if (existing && existing.path !== current.path) {
      throw new Error(
        `Resolved operation name collision for ${key}: ` +
          `${existing.httpMethod} ${existing.path} conflicts with ${current.httpMethod} ${current.path}`,
      );
    }

    if (!existing) {
      seen.set(key, current);
    }
  }
}

/**
 * Build a lookup map from "METHOD /path" to ResolvedOperation.
 * Used by emitters to find the resolved method name for any IR operation.
 */
export function buildResolvedLookup(ctx: EmitterContext): Map<string, ResolvedOperation> {
  assertUniqueResolvedMethods(ctx);

  const map = new Map<string, ResolvedOperation>();
  for (const r of ctx.resolvedOperations ?? []) {
    const key = `${r.operation.httpMethod.toUpperCase()} ${r.operation.path}`;
    map.set(key, r);
  }
  return map;
}

/**
 * Look up the resolved method name for an operation.
 * Returns the snake_case resolved name, or undefined if not found.
 */
export function lookupMethodName(op: Operation, lookup: Map<string, ResolvedOperation>): string | undefined {
  const key = `${op.httpMethod.toUpperCase()} ${op.path}`;
  return lookup.get(key)?.methodName;
}

/**
 * Look up the full ResolvedOperation for an IR operation.
 */
export function lookupResolved(op: Operation, lookup: Map<string, ResolvedOperation>): ResolvedOperation | undefined {
  const key = `${op.httpMethod.toUpperCase()} ${op.path}`;
  return lookup.get(key);
}

/**
 * A mount group: a set of resolved operations that all mount on the same target.
 * Serves the same role as a Service in the old architecture, but operations may
 * come from multiple IR services.
 */
export interface MountGroup {
  /** PascalCase mount target name (e.g., "SSO", "UserManagement"). */
  name: string;
  /** All resolved operations in this group. */
  resolvedOps: ResolvedOperation[];
  /** The raw IR operations (convenience — same as resolvedOps[*].operation). */
  operations: Operation[];
}

/**
 * Group resolved operations by their mountOn target.
 * Returns a map from PascalCase mount target to MountGroup.
 */
export function groupByMount(ctx: EmitterContext): Map<string, MountGroup> {
  const groups = new Map<string, MountGroup>();
  for (const r of ctx.resolvedOperations ?? []) {
    let group = groups.get(r.mountOn);
    if (!group) {
      group = { name: r.mountOn, resolvedOps: [], operations: [] };
      groups.set(r.mountOn, group);
    }
    group.resolvedOps.push(r);
    group.operations.push(r.operation);
  }
  return groups;
}

/**
 * Like {@link groupByMount}, but for a scoped (`--services`) run returns ONLY the
 * mount groups the run selected (`ctx.scopedServices`, POST-MOUNT names). When
 * scoping is inactive the full set is returned unchanged.
 *
 * Use this for PER-SERVICE resource/test emission. Do NOT use it for
 * aggregate/barrel files (Rust `mod.rs`, Ruby `client.rbi`, the root client) —
 * those must continue to list every service, so they keep calling
 * {@link groupByMount} over the full set; otherwise a scoped run would drop
 * sibling modules and break the build/type-check.
 */
export function scopedMountGroups(ctx: EmitterContext): Map<string, MountGroup> {
  const groups = groupByMount(ctx);
  const scope = ctx.scopedServices;
  if (!scope || scope.size === 0) return groups;
  return new Map([...groups].filter(([mountName]) => scope.has(mountName)));
}

/**
 * True when a POST-MOUNT service name should be emitted in the current run.
 * Inactive scoping (no `ctx.scopedServices`) ⇒ everything is in scope. Use this
 * for inline per-service gates (e.g. manifest loops keyed by `getMountTarget`).
 */
export function isMountInScope(mountName: string, ctx: EmitterContext): boolean {
  const scope = ctx.scopedServices;
  return !scope || scope.size === 0 || scope.has(mountName);
}

/**
 * True when a MODEL's per-model FILE should be written in the current run (FR-1.4).
 * A scoped run sets `ctx.scopedModelNames` to the models reachable from the
 * selected services; out-of-scope models are left untouched on disk. Inactive
 * scoping ⇒ everything is in scope. NOTE: gate only the per-model FILE write —
 * the model must still appear in barrels/indexes (built from the full set) so the
 * untouched on-disk file stays importable.
 */
export function isModelInScope(modelName: string, ctx: EmitterContext): boolean {
  const scope = ctx.scopedModelNames;
  return !scope || scope.has(modelName);
}

/** Like {@link isModelInScope} but for an ENUM's per-enum file (`ctx.scopedEnumNames`). */
export function isEnumInScope(enumName: string, ctx: EmitterContext): boolean {
  const scope = ctx.scopedEnumNames;
  return !scope || scope.has(enumName);
}

/**
 * Get the mount target for an IR service.
 * Checks the first resolved operation that belongs to this service.
 * Falls back to PascalCase of the service name if no resolved ops exist.
 */
export function getMountTarget(service: Service, ctx: EmitterContext): string {
  for (const r of ctx.resolvedOperations ?? []) {
    if (r.service.name === service.name) return r.mountOn;
  }
  return toPascalCase(service.name);
}

// ---------------------------------------------------------------------------
// Defaults / inferFromClient helpers
//
// For non-split operations with operationHints that specify `defaults` or
// `inferFromClient`, oagen attaches these properties at runtime but they
// are not part of the ResolvedOperation TypeScript interface (they live on
// ResolvedWrapper for split operations). These helpers provide type-safe
// access so individual emitters don't need `as any` casts.
// ---------------------------------------------------------------------------

/** Extract constant defaults from a resolved operation (if any). */
export function getOpDefaults(resolvedOp?: ResolvedOperation): Record<string, string | number | boolean> {
  return ((resolvedOp as any)?.defaults as Record<string, string | number | boolean> | undefined) ?? {};
}

/** Extract inferFromClient fields from a resolved operation (if any). */
export function getOpInferFromClient(resolvedOp?: ResolvedOperation): string[] {
  return ((resolvedOp as any)?.inferFromClient as string[] | undefined) ?? [];
}

/** Build the set of param names hidden from the public API (injected as defaults or inferred from client config). */
export function buildHiddenParams(resolvedOp?: ResolvedOperation): Set<string> {
  const hidden = new Set<string>();
  for (const key of Object.keys(getOpDefaults(resolvedOp))) hidden.add(key);
  for (const key of getOpInferFromClient(resolvedOp)) hidden.add(key);
  return hidden;
}

/** Check whether a resolved operation has any hidden params. */
export function hasHiddenParams(resolvedOp?: ResolvedOperation): boolean {
  return Object.keys(getOpDefaults(resolvedOp)).length > 0 || getOpInferFromClient(resolvedOp).length > 0;
}

// ---------------------------------------------------------------------------
// Parameter group helpers
// ---------------------------------------------------------------------------

/**
 * Collect all parameter names that belong to any mutually-exclusive parameter group.
 * These params are serialized via group-level dispatch (e.g. applyToQuery, isinstance,
 * sealed-class when, etc.) instead of individual struct/class fields.
 */
export function collectGroupedParamNames(op: Operation): Set<string> {
  const names = new Set<string>();
  for (const group of op.parameterGroups ?? []) {
    for (const variant of group.variants) {
      for (const param of variant.parameters) {
        names.add(param.name);
      }
    }
  }
  return names;
}

/**
 * Build a fallback map from request-body wire field name to TypeRef.
 *
 * Some parameter-group variants lose array/object fidelity in the IR and fall
 * back to primitive strings. Cross-referencing the request body model restores
 * the actual field type when the grouped params belong to the body.
 */
export function collectBodyFieldTypes(op: Operation, models: Model[]): Map<string, TypeRef> {
  const fieldTypes = new Map<string, TypeRef>();
  const reqBody = op.requestBody;
  if (reqBody?.kind !== 'model') return fieldTypes;

  const bodyModel = models.find((model) => model.name === reqBody.name);
  if (!bodyModel) return fieldTypes;

  for (const field of bodyModel.fields) {
    fieldTypes.set(field.name, field.type);
  }

  return fieldTypes;
}

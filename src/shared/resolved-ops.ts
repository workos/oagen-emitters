import type { Operation, EmitterContext, Service, ResolvedOperation } from '@workos/oagen';
import { toPascalCase } from '@workos/oagen';

/**
 * Build a lookup map from "METHOD /path" to ResolvedOperation.
 * Used by emitters to find the resolved method name for any IR operation.
 */
export function buildResolvedLookup(ctx: EmitterContext): Map<string, ResolvedOperation> {
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

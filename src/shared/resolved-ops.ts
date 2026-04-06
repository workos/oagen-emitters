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

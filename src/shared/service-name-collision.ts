import type { EmitterContext, Model, Enum } from '@workos/oagen';
import { isListWrapperModel, isListMetadataModel } from './model-utils.js';

/**
 * Suffix applied to an operation-client class name when it collides with an
 * exported model/enum class name in the same SDK namespace. Standardized
 * across emitters so colliding services look the same in every language —
 * e.g. `OrganizationMembershipService` regardless of language.
 *
 * Languages whose operation clients already carry a unique suffix (Go's
 * `…Service`, Rust's `…Api`, .NET's `…Service`) skip this helper entirely.
 */
export const SERVICE_COLLISION_SUFFIX = 'Service';

/**
 * Build the set of model + enum class names that the SDK exports under its
 * top-level namespace. Each emitter passes its own `classNameFn` so the
 * comparison happens on the language-specific class-name form (e.g. Ruby's
 * `RoleList`, Python's `RoleList`).
 *
 * List-wrapper and list-metadata models are excluded — they aren't exposed
 * as user-facing types.
 */
export function buildExportedClassNameSet(ctx: EmitterContext, classNameFn: (name: string) => string): Set<string> {
  const out = new Set<string>();
  for (const model of ctx.spec.models as Model[]) {
    if (isListWrapperModel(model) || isListMetadataModel(model)) continue;
    out.add(classNameFn(model.name));
  }
  for (const enumDef of ctx.spec.enums as Enum[]) {
    out.add(classNameFn(enumDef.name));
  }
  return out;
}

/**
 * Resolve the PascalCase mount-target identifier for an operation client,
 * appending `Service` when the un-suffixed class name would shadow an
 * exported model or enum.
 *
 * Operates on the PascalCase target (the mount-target string the IR carries),
 * so the returned value feeds cleanly into each language's `className` and
 * `fileName` helpers — e.g. `OrganizationMembership` → `OrganizationMembershipService`,
 * then `fileName` → `organization_membership_service` / `organization-membership-service`.
 *
 * The accessor on the client (`client.organization_membership`) is intentionally
 * NOT suffixed — callers should keep using the raw target for `servicePropertyName`
 * so the accessor reads naturally.
 */
export function resolveServiceTarget(
  target: string,
  exportedClasses: Set<string>,
  classNameFn: (name: string) => string,
): string {
  return exportedClasses.has(classNameFn(target)) ? `${target}${SERVICE_COLLISION_SUFFIX}` : target;
}

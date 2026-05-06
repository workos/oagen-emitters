import type { ApiSpec } from '@workos/oagen';
import { walkTypeRef } from '@workos/oagen';

/**
 * Walk every operation across all services and tally, per schema, the set of
 * services that transitively reference it. Schemas referenced by more than one
 * service are "shared" — they should be emitted under common/ rather than
 * the first alphabetical service that happens to use them.
 *
 * Transitive walk for models follows model->model field references to a fixed
 * point; enums are leaves.
 */
export function findSharedSchemas(spec: ApiSpec): { models: Set<string>; enums: Set<string> } {
  const modelsByName = new Map(spec.models.map((m) => [m.name, m]));
  const modelToServices = new Map<string, Set<string>>();
  const enumToServices = new Map<string, Set<string>>();

  const note = (map: Map<string, Set<string>>, name: string, service: string): void => {
    let bucket = map.get(name);
    if (!bucket) {
      bucket = new Set();
      map.set(name, bucket);
    }
    bucket.add(service);
  };

  for (const service of spec.services) {
    const directModels = new Set<string>();
    const directEnums = new Set<string>();
    const collect = (ref: unknown): void => {
      walkTypeRef(ref as never, {
        model: (r) => directModels.add(r.name),
        enum: (r) => directEnums.add(r.name),
      });
    };

    for (const op of service.operations) {
      if (op.requestBody) collect(op.requestBody);
      collect(op.response);
      for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
        collect(p.type);
      }
      if (op.pagination) collect(op.pagination.itemType);
      for (const err of op.errors) {
        if (err.type) collect(err.type);
      }
      for (const sr of op.successResponses ?? []) {
        collect(sr.type);
      }
    }

    // Transitively expand model references via field types.
    const queue = [...directModels];
    while (queue.length > 0) {
      const name = queue.pop()!;
      const model = modelsByName.get(name);
      if (!model) continue;
      for (const field of model.fields) {
        walkTypeRef(field.type as never, {
          model: (r) => {
            if (!directModels.has(r.name)) {
              directModels.add(r.name);
              queue.push(r.name);
            }
          },
          enum: (r) => directEnums.add(r.name),
        });
      }
    }

    for (const name of directModels) note(modelToServices, name, service.name);
    for (const name of directEnums) note(enumToServices, name, service.name);
  }

  const sharedModels = new Set<string>();
  for (const [name, services] of modelToServices) {
    if (services.size >= 2) sharedModels.add(name);
  }
  const sharedEnums = new Set<string>();
  for (const [name, services] of enumToServices) {
    if (services.size >= 2) sharedEnums.add(name);
  }

  return { models: sharedModels, enums: sharedEnums };
}

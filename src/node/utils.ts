import type { Model, Service, TypeRef } from '@workos/oagen';
import { walkTypeRef } from '@workos/oagen';

/**
 * Collect all model names referenced (directly or transitively) by a TypeRef.
 */
export function collectModelRefs(ref: TypeRef): string[] {
  const names: string[] = [];
  walkTypeRef(ref, { model: (r) => names.push(r.name) });
  return names;
}

/**
 * Collect all enum names referenced by a TypeRef.
 */
export function collectEnumRefs(ref: TypeRef): string[] {
  const names: string[] = [];
  walkTypeRef(ref, { enum: (r) => names.push(r.name) });
  return names;
}

/**
 * Assign each model to the service that first references it.
 * Models referenced by multiple services are assigned to the first.
 * Models not referenced by any service are unassigned (returned as undefined).
 */
export function assignModelsToServices(models: Model[], services: Service[]): Map<string, string> {
  const modelToService = new Map<string, string>();
  const modelNames = new Set(models.map((m) => m.name));

  for (const service of services) {
    const referencedModels = new Set<string>();

    // Collect directly referenced models from all operations
    for (const op of service.operations) {
      if (op.requestBody) {
        for (const name of collectModelRefs(op.requestBody)) {
          referencedModels.add(name);
        }
      }
      for (const name of collectModelRefs(op.response)) {
        referencedModels.add(name);
      }
      for (const param of [...op.pathParams, ...op.queryParams, ...op.headerParams]) {
        for (const name of collectModelRefs(param.type)) {
          referencedModels.add(name);
        }
      }
      if (op.pagination) {
        for (const name of collectModelRefs(op.pagination.itemType)) {
          referencedModels.add(name);
        }
      }
    }

    // Transitively collect models referenced by the directly-referenced models
    const toVisit = [...referencedModels];
    while (toVisit.length > 0) {
      const name = toVisit.pop()!;
      const model = models.find((m) => m.name === name);
      if (!model) continue;
      for (const field of model.fields) {
        for (const ref of collectModelRefs(field.type)) {
          if (!referencedModels.has(ref) && modelNames.has(ref)) {
            referencedModels.add(ref);
            toVisit.push(ref);
          }
        }
      }
    }

    // Assign models to this service (first-come)
    for (const name of referencedModels) {
      if (!modelToService.has(name)) {
        modelToService.set(name, service.name);
      }
    }
  }

  return modelToService;
}

/**
 * Collect all TypeRef-referenced model and enum names from a model's fields.
 * Returns { models, enums } sets for generating import statements.
 */
export function collectFieldDependencies(model: Model): {
  models: Set<string>;
  enums: Set<string>;
} {
  const models = new Set<string>();
  const enums = new Set<string>();

  for (const field of model.fields) {
    for (const name of collectModelRefs(field.type)) {
      if (name !== model.name) models.add(name);
    }
    for (const name of collectEnumRefs(field.type)) {
      enums.add(name);
    }
  }

  return { models, enums };
}

/**
 * Compute a relative import path between two files within the generated SDK.
 * Strips .ts extension from the result.
 */
export function relativeImport(fromFile: string, toFile: string): string {
  const fromDir = fromFile.split('/').slice(0, -1);
  const toFileParts = toFile.split('/');
  const toDir = toFileParts.slice(0, -1);
  const toFileName = toFileParts[toFileParts.length - 1];

  let common = 0;
  while (common < fromDir.length && common < toDir.length && fromDir[common] === toDir[common]) {
    common++;
  }

  const ups = fromDir.length - common;
  const downs = toDir.slice(common);
  const parts = [...Array(ups).fill('..'), ...downs, toFileName];
  let result = parts.join('/');
  result = result.replace(/\.ts$/, '');
  if (!result.startsWith('.')) result = './' + result;
  return result;
}

/**
 * Collect all model names referenced as request bodies across all services.
 */
export function collectRequestBodyModels(services: Service[]): Set<string> {
  const result = new Set<string>();
  for (const service of services) {
    for (const op of service.operations) {
      if (op.requestBody) {
        for (const name of collectModelRefs(op.requestBody)) {
          result.add(name);
        }
      }
    }
  }
  return result;
}

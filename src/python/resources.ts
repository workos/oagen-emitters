import type { Service, Operation, EmitterContext, GeneratedFile } from '@workos/oagen';
import { planOperation, toPascalCase, collectModelRefs, collectEnumRefs, assignModelsToServices } from '@workos/oagen';
import { mapTypeRefUnquoted } from './type-map.js';
import {
  className,
  fieldName,
  resolveServiceDir,
  resolveMethodName,
  resolveClassName,
  buildServiceNameMap,
} from './naming.js';

/**
 * Resolve the resource class name for a service.
 */
export function resolveResourceClassName(service: Service, ctx: EmitterContext): string {
  return resolveClassName(service, ctx);
}

/**
 * Generate Python resource class files from IR Service definitions.
 */
export function generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  if (services.length === 0) return [];

  const files: GeneratedFile[] = [];

  for (const service of services) {
    const resolvedName = resolveResourceClassName(service, ctx);
    const dirName = resolveServiceDir(resolvedName);
    const resourceClassName = resolvedName;

    const lines: string[] = [];
    lines.push('from __future__ import annotations');
    lines.push('');
    lines.push('from typing import TYPE_CHECKING, Any, Dict, List, Literal, Optional, Type');
    lines.push('');
    lines.push('if TYPE_CHECKING:');
    lines.push('    from .._client import WorkOS');
    lines.push('');

    // Collect all model and enum imports needed
    const modelImports = new Set<string>();
    const enumImports = new Set<string>();

    // Build a set of list wrapper model names to skip
    const listWrapperNames = new Set<string>();
    for (const m of ctx.spec.models) {
      const dataField = m.fields.find((f) => f.name === 'data');
      const hasListMeta = m.fields.some((f) => f.name === 'list_metadata' || f.name === 'listMetadata');
      if (dataField && hasListMeta && dataField.type.kind === 'array') {
        listWrapperNames.add(m.name);
      }
    }

    for (const op of service.operations) {
      const plan = planOperation(op);
      if (plan.responseModelName && !listWrapperNames.has(plan.responseModelName)) {
        modelImports.add(plan.responseModelName);
      }
      if (op.requestBody?.kind === 'model') {
        const requestBodyRef = op.requestBody;
        modelImports.add(requestBodyRef.name);
        // Also collect types from body model fields (expanded as keyword params)
        const bodyModel = ctx.spec.models.find((m) => m.name === requestBodyRef.name);
        if (bodyModel) {
          for (const f of bodyModel.fields) {
            for (const ref of collectModelRefs(f.type)) modelImports.add(ref);
            for (const ref of collectEnumRefs(f.type)) enumImports.add(ref);
          }
        }
      }
      // Collect from params
      for (const p of [...op.pathParams, ...op.queryParams]) {
        for (const ref of collectEnumRefs(p.type)) {
          enumImports.add(ref);
        }
      }
      if (op.requestBody) {
        for (const ref of collectModelRefs(op.requestBody)) {
          modelImports.add(ref);
        }
        for (const ref of collectEnumRefs(op.requestBody)) {
          enumImports.add(ref);
        }
      }
      if (op.pagination?.itemType.kind === 'model') {
        let paginationItemName = op.pagination.itemType.name;
        // Unwrap list wrapper models to their inner item type for imports
        if (listWrapperNames.has(paginationItemName)) {
          const wrapperModel = ctx.spec.models.find((m) => m.name === paginationItemName);
          const dataField = wrapperModel?.fields.find((f) => f.name === 'data');
          if (dataField && dataField.type.kind === 'array' && dataField.type.items.kind === 'model') {
            paginationItemName = dataField.type.items.name;
          }
        }
        modelImports.add(paginationItemName);
      }
    }

    // Filter enum imports to only those that actually exist in the spec
    const specEnumNames = new Set(ctx.spec.enums.map((e) => e.name));
    for (const name of enumImports) {
      if (!specEnumNames.has(name)) enumImports.delete(name);
    }

    const actualModelImports = [...modelImports];

    // Split imports into same-service and cross-service
    const modelToServiceMap = assignModelsToServices(ctx.spec.models, ctx.spec.services);
    const serviceNameMap = buildServiceNameMap(ctx.spec.services, ctx);
    const resolveModelDir = (modelName: string) => {
      const svc = modelToServiceMap.get(modelName);
      return svc ? resolveServiceDir(serviceNameMap.get(svc) ?? svc) : 'common';
    };

    const localModels: string[] = [];
    const crossServiceModels = new Map<string, string[]>(); // dir -> names

    for (const name of actualModelImports.sort()) {
      const modelDir = resolveModelDir(name);
      if (modelDir === dirName) {
        localModels.push(name);
      } else {
        if (!crossServiceModels.has(modelDir)) crossServiceModels.set(modelDir, []);
        crossServiceModels.get(modelDir)!.push(name);
      }
    }

    if (localModels.length > 0) {
      lines.push(`from .models import ${localModels.join(', ')}`);
    }
    for (const [csDir, names] of [...crossServiceModels].sort()) {
      lines.push(`from ${ctx.namespace}.${csDir}.models import ${names.join(', ')}`);
    }

    // Enum imports — same-service vs cross-service
    const enumToServiceMap = new Map<string, string>();
    for (const e of ctx.spec.enums) {
      // Find which service uses this enum
      for (const svc of ctx.spec.services) {
        for (const op of svc.operations) {
          const refs = new Set<string>();
          const collect = (ref: any) => {
            if (ref?.kind === 'enum') refs.add(ref.name);
          };
          if (op.requestBody) collect(op.requestBody);
          collect(op.response);
          for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams]) {
            collect(p.type);
          }
          if (refs.has(e.name) && !enumToServiceMap.has(e.name)) {
            enumToServiceMap.set(e.name, svc.name);
          }
        }
      }
    }

    const localEnums: string[] = [];
    const crossServiceEnums = new Map<string, string[]>();
    for (const name of [...enumImports].sort()) {
      const enumSvc = enumToServiceMap.get(name);
      const enumDir = enumSvc ? resolveServiceDir(serviceNameMap.get(enumSvc) ?? enumSvc) : 'common';
      if (enumDir === dirName) {
        localEnums.push(name);
      } else {
        if (!crossServiceEnums.has(enumDir)) crossServiceEnums.set(enumDir, []);
        crossServiceEnums.get(enumDir)!.push(name);
      }
    }

    if (localEnums.length > 0) {
      lines.push(`from .models import ${localEnums.join(', ')}`);
    }
    for (const [csDir, names] of [...crossServiceEnums].sort()) {
      lines.push(`from ${ctx.namespace}.${csDir}.models import ${names.join(', ')}`);
    }

    const hasPaginated = service.operations.some((op) => op.pagination);
    if (hasPaginated) {
      lines.push('from .._pagination import SyncPage');
    }
    lines.push('from .._types import RequestOptions');

    lines.push('');
    lines.push('');
    lines.push(`class ${resourceClassName}:`);
    if (service.description) {
      lines.push(`    """${service.description}"""`);
    } else {
      const readable = resourceClassName.replace(/([A-Z])/g, ' $1').trim();
      lines.push(`    """${readable} API resources."""`);
    }
    lines.push('');
    lines.push('    def __init__(self, client: "WorkOS") -> None:');
    lines.push('        self._client = client');

    const emittedMethods = new Set<string>();

    for (const op of service.operations) {
      const plan = planOperation(op);
      const method = resolveMethodName(op, service, ctx);

      // Skip duplicate method names (multiple operations mapping to the same name)
      if (emittedMethods.has(method)) continue;
      emittedMethods.add(method);
      const isDelete = plan.isDelete;
      const isPaginated = plan.isPaginated;

      lines.push('');
      lines.push(`    def ${method}(`);
      lines.push('        self,');

      // Path params as positional args
      for (const param of op.pathParams) {
        const paramName = fieldName(param.name);
        const paramType = mapTypeRefUnquoted(param.type, specEnumNames);
        lines.push(`        ${paramName}: ${paramType},`);
      }

      lines.push('        *,');

      const pathParamNames = new Set(op.pathParams.map((p) => fieldName(p.name)));

      // Request body fields as keyword args (skip fields that clash with path params)
      if (plan.hasBody && op.requestBody) {
        const bodyModel = ctx.spec.models.find(
          (m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name,
        );
        if (bodyModel) {
          const reqFields = bodyModel.fields.filter((f) => f.required && !pathParamNames.has(fieldName(f.name)));
          const optFields = bodyModel.fields.filter((f) => !f.required && !pathParamNames.has(fieldName(f.name)));
          for (const f of reqFields) {
            lines.push(`        ${fieldName(f.name)}: ${mapTypeRefUnquoted(f.type, specEnumNames)},`);
          }
          for (const f of optFields) {
            const innerType =
              f.type.kind === 'nullable'
                ? mapTypeRefUnquoted(f.type.inner, specEnumNames)
                : mapTypeRefUnquoted(f.type, specEnumNames);
            lines.push(`        ${fieldName(f.name)}: Optional[${innerType}] = None,`);
          }
        } else {
          // Non-model body — use generic dict
          lines.push('        body: Optional[Dict[str, Any]] = None,');
        }
      }

      // Query params for non-paginated methods (skip if body already covers them)
      if (plan.hasQueryParams && !isPaginated && !plan.hasBody) {
        for (const param of op.queryParams) {
          const paramName = fieldName(param.name);
          if (pathParamNames.has(paramName)) continue;
          const paramType = mapTypeRefUnquoted(param.type, specEnumNames);
          if (param.required) {
            lines.push(`        ${paramName}: ${paramType},`);
          } else {
            lines.push(`        ${paramName}: Optional[${paramType}] = None,`);
          }
        }
      }

      // Pagination params
      if (isPaginated) {
        lines.push('        limit: Optional[int] = None,');
        lines.push('        before: Optional[str] = None,');
        lines.push('        after: Optional[str] = None,');
        lines.push('        order: Optional[str] = None,');
        // Additional non-pagination query params
        for (const param of op.queryParams) {
          if (['limit', 'before', 'after', 'order'].includes(param.name)) continue;
          const paramName = fieldName(param.name);
          const paramType = mapTypeRefUnquoted(param.type, specEnumNames);
          if (param.required) {
            lines.push(`        ${paramName}: ${paramType},`);
          } else {
            lines.push(`        ${paramName}: Optional[${paramType}] = None,`);
          }
        }
      }

      // Idempotency key for idempotent POSTs
      if (plan.isIdempotentPost) {
        lines.push('        idempotency_key: Optional[str] = None,');
      }

      lines.push('        request_options: Optional[RequestOptions] = None,');

      // Return type
      let returnType: string;
      if (isDelete) {
        returnType = 'None';
      } else if (isPaginated) {
        const resolvedItem = resolvePageItemName(op.pagination!.itemType, listWrapperNames, ctx);
        returnType = `SyncPage[${className(resolvedItem)}]`;
      } else if (plan.responseModelName) {
        returnType = className(plan.responseModelName);
      } else {
        returnType = 'None';
      }

      lines.push(`    ) -> ${returnType}:`);

      // Docstring
      if (op.description) {
        lines.push(`        """${op.description}`);
      } else {
        lines.push(`        """${toPascalCase(method.replace(/_/g, ' '))} operation.`);
      }

      // Args section
      const allParams: { name: string; desc?: string }[] = op.pathParams.map((p) => ({
        name: fieldName(p.name),
        desc: p.description,
      }));

      // Add body model fields to docs
      if (plan.hasBody && op.requestBody) {
        const bodyModel = ctx.spec.models.find(
          (m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name,
        );
        if (bodyModel) {
          for (const f of bodyModel.fields) {
            if (pathParamNames.has(fieldName(f.name))) continue;
            allParams.push({ name: fieldName(f.name), desc: f.description });
          }
        }
      }

      // Add query params for non-paginated methods
      if (plan.hasQueryParams && !isPaginated && !plan.hasBody) {
        for (const param of op.queryParams) {
          if (pathParamNames.has(fieldName(param.name))) continue;
          allParams.push({ name: fieldName(param.name), desc: param.description });
        }
      }

      // Add extra non-standard pagination query params
      if (isPaginated) {
        for (const param of op.queryParams) {
          if (['limit', 'before', 'after', 'order'].includes(param.name)) continue;
          allParams.push({ name: fieldName(param.name), desc: param.description });
        }
      }

      if (allParams.length > 0 || isPaginated) {
        lines.push('');
        lines.push('        Args:');
        for (const p of allParams) {
          lines.push(`            ${p.name}: ${p.desc ?? 'The ' + p.name.replace(/_/g, ' ') + '.'}`);
        }
        if (isPaginated) {
          lines.push('            limit: Maximum number of records to return.');
          lines.push('            before: Pagination cursor for previous page.');
          lines.push('            after: Pagination cursor for next page.');
          lines.push('            order: Sort order.');
        }
        lines.push('            request_options: Per-request options (extra headers, timeout).');
      }

      if (returnType !== 'None') {
        lines.push('');
        lines.push('        Returns:');
        lines.push(`            ${returnType}`);
      }

      lines.push('        """');

      // Method body — build path
      const pathStr = buildPathString(op);
      const httpMethod = op.httpMethod;

      if (isPaginated) {
        const resolvedItemName = resolvePageItemName(op.pagination!.itemType, listWrapperNames, ctx);
        const itemTypeClass = className(resolvedItemName);
        // Build query params dict
        lines.push('        params = {k: v for k, v in {');
        lines.push('            "limit": limit,');
        lines.push('            "before": before,');
        lines.push('            "after": after,');
        lines.push('            "order": order,');
        for (const param of op.queryParams) {
          if (['limit', 'before', 'after', 'order'].includes(param.name)) continue;
          lines.push(`            "${param.name}": ${fieldName(param.name)},`);
        }
        lines.push('        }.items() if v is not None}');
        lines.push(`        return self._client.request_page(`);
        lines.push(`            method="${httpMethod}",`);
        lines.push(`            path=${pathStr},`);
        lines.push(`            model=${itemTypeClass},`);
        lines.push('            params=params,');
        lines.push('            request_options=request_options,');
        lines.push('        )');
      } else if (isDelete) {
        // Build body dict if the DELETE has a request body
        if (plan.hasBody && op.requestBody) {
          const bodyModel = ctx.spec.models.find(
            (m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name,
          );
          if (bodyModel) {
            const bodyFields = bodyModel.fields.filter((f) => !pathParamNames.has(fieldName(f.name)));
            const hasOptionalBodyFields = bodyFields.some((f) => !f.required);
            if (bodyFields.length > 0 && hasOptionalBodyFields) {
              lines.push('        body: Dict[str, Any] = {k: v for k, v in {');
              for (const f of bodyFields) {
                lines.push(
                  `            "${f.name}": ${serializeBodyFieldValue(f.type, fieldName(f.name), f.required)},`,
                );
              }
              lines.push('        }.items() if v is not None}');
            } else if (bodyFields.length > 0) {
              lines.push('        body: Dict[str, Any] = {');
              for (const f of bodyFields) {
                lines.push(
                  `            "${f.name}": ${serializeBodyFieldValue(f.type, fieldName(f.name), f.required)},`,
                );
              }
              lines.push('        }');
            }
          }
        }
        lines.push(`        self._client.request(`);
        lines.push(`            method="${httpMethod}",`);
        lines.push(`            path=${pathStr},`);
        if (plan.hasBody && op.requestBody) {
          lines.push('            body=body,');
        }
        lines.push('            request_options=request_options,');
        lines.push('        )');
      } else if (plan.hasBody && op.requestBody) {
        const responseModel = plan.responseModelName ? className(plan.responseModelName) : 'None';
        // Build body dict
        const bodyModel = ctx.spec.models.find(
          (m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name,
        );
        if (bodyModel) {
          const bodyFields = bodyModel.fields.filter((f) => !pathParamNames.has(fieldName(f.name)));
          const hasOptionalBodyFields = bodyFields.some((f) => !f.required);
          if (bodyFields.length > 0 && hasOptionalBodyFields) {
            lines.push('        body: Dict[str, Any] = {k: v for k, v in {');
            for (const f of bodyFields) {
              lines.push(`            "${f.name}": ${serializeBodyFieldValue(f.type, fieldName(f.name), f.required)},`);
            }
            lines.push('        }.items() if v is not None}');
          } else if (bodyFields.length > 0) {
            lines.push('        body: Dict[str, Any] = {');
            for (const f of bodyFields) {
              lines.push(`            "${f.name}": ${serializeBodyFieldValue(f.type, fieldName(f.name), f.required)},`);
            }
            lines.push('        }');
          } else {
            lines.push('        body: Dict[str, Any] = {}');
          }
        }
        const bodyReturnPrefix = responseModel !== 'None' ? 'return ' : '';
        lines.push(`        ${bodyReturnPrefix}self._client.request(`);
        lines.push(`            method="${httpMethod}",`);
        lines.push(`            path=${pathStr},`);
        lines.push('            body=body,');
        if (responseModel !== 'None') {
          lines.push(`            model=${responseModel},`);
        }
        if (plan.isIdempotentPost) {
          lines.push('            idempotency_key=idempotency_key,');
        }
        lines.push('            request_options=request_options,');
        lines.push('        )');
      } else {
        // GET or similar with query params
        const responseModel = plan.responseModelName ? className(plan.responseModelName) : 'None';
        if (plan.hasQueryParams) {
          const hasOptionalQueryParams = op.queryParams.some((p) => !p.required);
          if (hasOptionalQueryParams) {
            lines.push('        params: Dict[str, Any] = {k: v for k, v in {');
            for (const param of op.queryParams) {
              lines.push(`            "${param.name}": ${fieldName(param.name)},`);
            }
            lines.push('        }.items() if v is not None}');
          } else {
            lines.push('        params: Dict[str, Any] = {');
            for (const param of op.queryParams) {
              lines.push(`            "${param.name}": ${fieldName(param.name)},`);
            }
            lines.push('        }');
          }
        }
        const returnPrefix = responseModel !== 'None' ? 'return ' : '';
        lines.push(`        ${returnPrefix}self._client.request(`);
        lines.push(`            method="${httpMethod}",`);
        lines.push(`            path=${pathStr},`);
        if (plan.hasQueryParams) {
          lines.push('            params=params,');
        }
        if (responseModel !== 'None') {
          lines.push(`            model=${responseModel},`);
        }
        lines.push('            request_options=request_options,');
        lines.push('        )');
      }
    }

    files.push({
      path: `${ctx.namespace}/${dirName}/_resource.py`,
      content: lines.join('\n'),
    });
  }

  return files;
}

/**
 * Serialize a body field value for inclusion in a request body dict.
 * Calls .to_dict() on model fields and [item.to_dict() for item in ...] on arrays of models.
 */
function serializeBodyFieldValue(fieldType: any, varName: string, isRequired: boolean): string {
  const effectiveType = fieldType.kind === 'nullable' ? fieldType.inner : fieldType;
  if (effectiveType.kind === 'model') {
    if (!isRequired) {
      return `${varName}.to_dict() if ${varName} is not None else None`;
    }
    return `${varName}.to_dict()`;
  }
  if (effectiveType.kind === 'array' && effectiveType.items?.kind === 'model') {
    if (!isRequired) {
      return `[item.to_dict() for item in ${varName}] if ${varName} is not None else None`;
    }
    return `[item.to_dict() for item in ${varName}]`;
  }
  return varName;
}

/**
 * Resolve the item type name for a paginated operation, unwrapping list wrappers.
 */
function resolvePageItemName(
  itemType: import('@workos/oagen').TypeRef,
  listWrapperNames: Set<string>,
  ctx: EmitterContext,
): string {
  if (itemType.kind === 'model') {
    if (listWrapperNames.has(itemType.name)) {
      const wrapperModel = ctx.spec.models.find((m) => m.name === itemType.name);
      const dataField = wrapperModel?.fields.find((f) => f.name === 'data');
      if (dataField && dataField.type.kind === 'array' && dataField.type.items.kind === 'model') {
        return dataField.type.items.name;
      }
    }
    return itemType.name;
  }
  return 'dict';
}

/**
 * Build a Python f-string path expression from an operation path.
 * E.g., "/organizations/{id}" -> f"organizations/{id}"
 */
function buildPathString(op: Operation): string {
  // Strip leading slash and convert {param} to Python f-string interpolation
  const path = op.path.replace(/^\//, '');
  if (op.pathParams.length === 0) {
    return `"${path}"`;
  }
  // Convert {paramName} to {fieldName(paramName)}
  let fPath = path;
  for (const param of op.pathParams) {
    fPath = fPath.replace(`{${param.name}}`, `{${fieldName(param.name)}}`);
  }
  return `f"${fPath}"`;
}

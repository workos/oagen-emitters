import type {
  Service,
  Operation,
  OperationPlan,
  EmitterContext,
  GeneratedFile,
  ResolvedOperation,
  Model,
  TypeRef,
} from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import { isListWrapperModel } from './models.js';
import { mapTypeRef, isValueTypeRef, isEnumRef, emitJsonPropertyAttributes, resolveModelName } from './type-map.js';
import {
  appendAsyncSuffix,
  className,
  fieldName,
  methodName,
  resolveClassName,
  resolveMethodName,
  resolveMethodStem,
  serviceTypeName,
  localName,
  csLiteral,
  clientFieldExpression,
  httpMethodCs,
  httpMethodHelperName,
  escapeXml,
  emitXmlDoc,
  deprecationMessage,
  escapeCsAttributeString,
  humanize,
  modelClassName,
} from './naming.js';
import {
  buildResolvedLookup,
  lookupResolved,
  scopedMountGroups,
  getOpDefaults,
  getOpInferFromClient,
  buildHiddenParams,
  hasHiddenParams,
  collectGroupedParamNames,
  collectBodyFieldTypes,
} from '../shared/resolved-ops.js';
import { generateWrapperMethods } from './wrappers.js';

/**
 * Return path params sorted by their first occurrence in the URL template.
 */
export function sortPathParamsByTemplateOrder(op: Operation): typeof op.pathParams {
  return [...op.pathParams].sort((a, b) => {
    const posA = op.path.indexOf(`{${a.name}}`);
    const posB = op.path.indexOf(`{${b.name}}`);
    return posA - posB;
  });
}

/**
 * Resolve the resource class name for a service.
 */
export function resolveResourceClassName(service: Service, ctx: EmitterContext): string {
  return resolveClassName(service, ctx);
}

/**
 * Generate C# service files from IR Service definitions.
 * Each mount group becomes a single Service.cs file.
 */
export function generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  if (services.length === 0) return [];

  const files: GeneratedFile[] = [];
  const mountGroups = scopedMountGroups(ctx);

  const entries: Array<{ name: string; operations: Operation[] }> =
    mountGroups.size > 0 || ctx.scopedServices?.size
      ? [...mountGroups].map(([name, group]) => ({ name, operations: group.operations }))
      : services.map((s) => ({ name: resolveResourceClassName(s, ctx), operations: s.operations }));

  for (const { name: mountName, operations } of entries) {
    if (operations.length === 0) continue;
    const serviceFile = generateServiceFile(mountName, operations, ctx);
    if (serviceFile) files.push(serviceFile);
    const optionsFile = generateOptionsFile(mountName, operations, ctx);
    if (optionsFile) files.push(optionsFile);
  }

  return files;
}

// ---------------------------------------------------------------------------
// Mutually-exclusive parameter group support
// ---------------------------------------------------------------------------

/** Abstract base class name for a parameter group (e.g. UserManagementRole). */
function groupBaseClassName(mountName: string, groupName: string): string {
  return `${className(mountName)}${className(groupName)}`;
}

/** Concrete variant class name (e.g. UserManagementRoleSingle). */
function groupVariantClassName(mountName: string, groupName: string, variantName: string): string {
  return `${className(mountName)}${className(groupName)}${className(variantName)}`;
}

/**
 * Widen a parameter group member's type for a variant that lists it in
 * `optionalParameters`. Optional members may be omitted when the variant is
 * used, which on the C# side means a nullable property and a null guard when
 * serializing.
 */
function optionalMemberType(type: TypeRef): TypeRef {
  return type.kind === 'nullable' ? type : { kind: 'nullable', inner: type };
}

/**
 * Generate C# abstract base class + concrete subtypes for all parameter groups
 * on an operation. Each group becomes an abstract class with concrete subclasses
 * for each variant containing the variant's parameters as properties.
 */
function generateParameterGroupTypes(
  mountName: string,
  op: Operation,
  models: Model[],
  emitted?: Set<string>,
): string[] {
  const lines: string[] = [];
  const bodyFieldTypes = collectBodyFieldTypes(op, models);

  for (const group of op.parameterGroups ?? []) {
    const baseName = groupBaseClassName(mountName, group.name);
    if (emitted?.has(baseName)) continue;
    emitted?.add(baseName);

    lines.push('');
    lines.push(`    public abstract class ${baseName} { }`);

    for (const variant of group.variants) {
      const variantName = groupVariantClassName(mountName, group.name, variant.name);
      lines.push('');
      lines.push(`    public class ${variantName} : ${baseName}`);
      lines.push('    {');
      // Members the variant marks optional are nullable and left unset by
      // default, and trail the required ones so the declaration order matches
      // the other emitters' variant types.
      const optionalNames = new Set(variant.optionalParameters ?? []);
      const orderedParams = [
        ...variant.parameters.filter((p) => !optionalNames.has(p.name)),
        ...variant.parameters.filter((p) => optionalNames.has(p.name)),
      ];
      for (const param of orderedParams) {
        const csField = fieldName(param.name);
        const effectiveType = bodyFieldTypes.get(param.name) ?? param.type;
        if (optionalNames.has(param.name)) {
          lines.push(`        public ${mapTypeRef(optionalMemberType(effectiveType))} ${csField} { get; set; }`);
        } else {
          lines.push(`        public ${mapTypeRef(effectiveType)} ${csField} { get; set; } = default!;`);
        }
        lines.push('');
      }
      lines.push('    }');
    }
  }

  return lines;
}

/**
 * Emit manual serialization for parameter group variants in the service
 * method body. Each group field on the options class is pattern-matched via
 * `is` checks and its variant parameters are added to the appropriate target
 * (query string or request body).
 */
function emitGroupSerialization(
  mountName: string,
  op: Operation,
  indent: string,
  models: Model[],
  target: 'query' | 'body',
): string[] {
  const lines: string[] = [];
  const bodyFieldTypes = collectBodyFieldTypes(op, models);

  for (const group of op.parameterGroups ?? []) {
    const groupField = fieldName(group.name);
    let first = true;

    for (const variant of group.variants) {
      const variantName = groupVariantClassName(mountName, group.name, variant.name);
      // Use a short local variable derived from the variant name
      const localVar = localName(variant.name);
      const keyword = first ? 'if' : 'else if';
      first = false;

      lines.push(`${indent}${keyword} (options?.${groupField} is ${variantName} ${localVar})`);
      lines.push(`${indent}{`);
      let prevWasBlock = false;
      const optionalNames = new Set(variant.optionalParameters ?? []);
      for (const param of variant.parameters) {
        const csField = fieldName(param.name);
        const declaredType = bodyFieldTypes.get(param.name) ?? param.type;
        // Optional members are nullable on the variant class, so serializing
        // them through the nullable form of the type gives them a null guard —
        // an unset member is omitted from the wire format, not sent as null.
        const effectiveType = optionalNames.has(param.name) ? optionalMemberType(declaredType) : declaredType;
        const accessor = `${localVar}.${csField}`;
        const paramLines = emitParamValue(param.name, accessor, effectiveType, indent + '    ', target);
        // SA1513: closing brace must be followed by a blank line before the next statement
        if (prevWasBlock) lines.push('');
        lines.push(...paramLines);
        prevWasBlock = paramLines.length > 1;
      }
      lines.push(`${indent}}`);
    }
  }

  return lines;
}

/**
 * Emit one or more lines to add a param to the query string or request body,
 * adapting to the parameter's IR type: enums use JsonConvert for wire-value
 * serialization, arrays are comma-joined, and reference types (string, List)
 * get a null guard.
 *
 * Reference types always get a null guard because variant classes are shared
 * across operations whose body models may disagree on nullability.
 */
function emitParamValue(
  wireName: string,
  accessor: string,
  typeRef: TypeRef,
  indent: string,
  target: 'query' | 'body',
): string[] {
  const method = target === 'body' ? 'AddBodyParam' : 'AddQueryParam';
  const isNullable = typeRef.kind === 'nullable';
  const inner: TypeRef = isNullable ? (typeRef as { kind: 'nullable'; inner: TypeRef }).inner : typeRef;

  // Reference types (arrays, strings, models) are always guarded for null
  // because the variant class property may be nullable even when the current
  // operation's body model says "required".
  const needsNullGuard = isNullable || !isValueTypeRef(inner);

  if (inner.kind === 'array') {
    // Body params pass the list directly so it serializes as a JSON array;
    // query params comma-join into a single string value.
    const valueExpr = target === 'body' ? accessor : `string.Join(",", ${accessor})`;
    if (needsNullGuard) {
      return [
        `${indent}if (${accessor} != null)`,
        `${indent}{`,
        `${indent}    request.${method}("${wireName}", ${valueExpr});`,
        `${indent}}`,
      ];
    }
    return [`${indent}request.${method}("${wireName}", ${valueExpr});`];
  }

  if (inner.kind === 'enum') {
    const serExpr = `JsonConvert.SerializeObject(${accessor}).Trim('"')`;
    if (isNullable) {
      return [
        `${indent}if (${accessor} != null)`,
        `${indent}{`,
        `${indent}    request.${method}("${wireName}", ${serExpr});`,
        `${indent}}`,
      ];
    }
    return [`${indent}request.${method}("${wireName}", ${serExpr});`];
  }

  if (needsNullGuard) {
    return [
      `${indent}if (${accessor} != null)`,
      `${indent}{`,
      `${indent}    request.${method}("${wireName}", ${accessor});`,
      `${indent}}`,
    ];
  }

  return [`${indent}request.${method}("${wireName}", ${accessor});`];
}

/** Check whether any parameter group variant contains an enum-typed parameter. */
function groupsNeedJsonConvert(operations: Operation[], models: Model[]): boolean {
  for (const op of operations) {
    const bodyFieldTypes = collectBodyFieldTypes(op, models);
    for (const group of op.parameterGroups ?? []) {
      for (const variant of group.variants) {
        for (const param of variant.parameters) {
          const effectiveType = bodyFieldTypes.get(param.name) ?? param.type;
          const inner: TypeRef =
            effectiveType.kind === 'nullable'
              ? (effectiveType as { kind: 'nullable'; inner: TypeRef }).inner
              : effectiveType;
          if (inner.kind === 'enum') return true;
        }
      }
    }
  }
  return false;
}

/**
 * Number of leading value parameters (path params, bearer token, options) the
 * generated signature for `op` carries before the trailing
 * `RequestOptions?`/`CancellationToken` pair. Mirrors the signature
 * construction in generateMethod.
 */
function leadingParamCount(
  op: Operation,
  plan: OperationPlan,
  ctx: EmitterContext,
  resolvedOp?: ResolvedOperation,
): number {
  const hidden = buildHiddenParams(resolvedOp);
  const groupedParams = collectGroupedParamNames(op);
  const hasGroups = (op.parameterGroups?.length ?? 0) > 0;
  const hasVisibleQueryParams =
    op.queryParams.filter((qp) => !hidden.has(qp.name) && !groupedParams.has(qp.name)).length > 0;
  const hasBody = plan.hasBody && op.requestBody;
  let hasVisibleBodyFields = false;
  if (hasBody && op.requestBody?.kind === 'model') {
    const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
    if (bodyModel) hasVisibleBodyFields = bodyModel.fields.some((f) => !hidden.has(f.name));
  } else if (hasBody) {
    hasVisibleBodyFields = true;
  }
  const hasParams = hasVisibleBodyFields || hasVisibleQueryParams || hasGroups;
  const hasBearerOverride = op.security?.some((s: any) => s.schemeName !== 'bearerAuth') ?? false;
  return op.pathParams.length + (hasBearerOverride ? 1 : 0) + (hasParams ? 1 : 0);
}

function generateServiceFile(mountName: string, operations: Operation[], ctx: EmitterContext): GeneratedFile | null {
  const lines: string[] = [];
  const svcTypeName = serviceTypeName(mountName);
  const csFile = `Services/${className(mountName)}/${svcTypeName}.cs`;

  const resolvedLookup = buildResolvedLookup(ctx);

  // A generated method named DeleteAsync with exactly two leading parameters
  // (e.g. two path params) hides Service.DeleteAsync from the 4-argument
  // helper calls the isDelete branch emits: C# discards base-class overloads
  // once any derived candidate is applicable, so `this.DeleteAsync(path,
  // null, requestOptions, ct)` binds to the API method itself — CS8625 on the
  // null literal, or silent recursion. Those call sites must say `base.`, and
  // only those: StyleCop SA1100 (warnings-as-errors in workos-dotnet) rejects
  // `base.` wherever `this.` already resolves to the same helper.
  // The scan mirrors the emission loop's name reservation below: a
  // union-split operation claims its raw method name without emitting it
  // (suppressing any later operation that resolves to the same name) and
  // emits typed wrappers instead, whose signatures are path params plus a
  // required options parameter (see emitWrapperMethod).
  let hasCapturingDeleteAsync = false;
  {
    const seen = new Set<string>();
    for (const op of operations) {
      const method = resolveCsMethodName(op, mountName, ctx);
      if (seen.has(method)) continue;
      seen.add(method);
      const resolvedOp = lookupResolved(op, resolvedLookup);
      const wrappers = resolvedOp?.wrappers ?? [];
      if (wrappers.length === 0) {
        if (method === 'DeleteAsync' && leadingParamCount(op, planOperation(op), ctx, resolvedOp) === 2) {
          hasCapturingDeleteAsync = true;
        }
        continue;
      }
      for (const w of wrappers) {
        const wrapperMethod = appendAsyncSuffix(methodName(w.name));
        seen.add(wrapperMethod);
        if (wrapperMethod === 'DeleteAsync' && op.pathParams.length + 1 === 2) {
          hasCapturingDeleteAsync = true;
        }
      }
    }
  }

  lines.push(`namespace ${ctx.namespacePascal}`);
  lines.push('{');
  lines.push('    using System;');
  lines.push('    using System.Collections.Generic;');
  lines.push('    using System.Net.Http;');
  lines.push('    using System.Threading;');
  lines.push('    using System.Threading.Tasks;');
  if (groupsNeedJsonConvert(operations, ctx.spec.models)) {
    lines.push('    using Newtonsoft.Json;');
  }
  lines.push('');
  lines.push(
    `    /// <summary>Service that exposes the ${humanize(mountName)} API operations on <see cref="WorkOSClient"/>.</summary>`,
  );
  lines.push(`    public class ${svcTypeName} : Service`);
  lines.push('    {');
  lines.push(`        /// <summary>`);
  lines.push(
    `        /// Initializes a new instance of the <see cref="${svcTypeName}"/> class for mocking. The service uses the singleton`,
  );
  lines.push(`        /// client configured via <see cref="WorkOSConfiguration.WorkOSClient"/>.`);
  lines.push(`        /// </summary>`);
  lines.push(`        public ${svcTypeName}() { }`);
  lines.push('');
  lines.push(`        /// <summary>`);
  lines.push(`        /// Initializes a new instance of the <see cref="${svcTypeName}"/> class bound to the`);
  lines.push(`        /// supplied <paramref name="client"/>.`);
  lines.push(`        /// </summary>`);
  lines.push(`        /// <param name="client">The HTTP client used to make API requests.</param>`);
  lines.push(`        public ${svcTypeName}(WorkOSClient client) : base(client) { }`);

  const emittedMethods = new Set<string>();
  for (const op of operations) {
    const plan = planOperation(op);
    const methodStem = resolveCsMethodStem(op, mountName, ctx);
    const method = resolveCsMethodName(op, mountName, ctx);

    if (emittedMethods.has(method)) continue;
    emittedMethods.add(method);

    const resolvedOp = lookupResolved(op, resolvedLookup);
    const isUnionSplit = (resolvedOp?.wrappers?.length ?? 0) > 0;

    // For union-split operations (e.g. POST /user_management/authenticate), do
    // NOT emit the raw method — its options class is empty and any caller will
    // get a 422 from the API. Only emit the typed AuthenticateWith* wrappers.
    if (!isUnionSplit) {
      lines.push('');
      const methodCode = generateMethod(
        svcTypeName,
        mountName,
        method,
        methodStem,
        op,
        plan,
        ctx,
        resolvedOp,
        hasCapturingDeleteAsync,
      );
      lines.push(methodCode);

      if (!(resolvedOp?.urlBuilder ?? false) && method !== methodStem) {
        lines.push('');
        lines.push(generateCompatibilityMethod(mountName, method, methodStem, op, plan, ctx, resolvedOp));
      }

      // Generate auto-pagination method for paginated list operations
      if (plan.isPaginated && op.pagination) {
        lines.push('');
        const autoPagingCode = generateAutoPagingMethod(mountName, method, methodStem, op, plan, ctx, resolvedOp);
        lines.push(autoPagingCode);
      }
    }

    // Generate union split wrapper methods
    if (isUnionSplit) {
      const wrapperLines = generateWrapperMethods(svcTypeName, resolvedOp!, ctx);
      lines.push(...wrapperLines);
      for (const w of resolvedOp!.wrappers!) {
        emittedMethods.add(appendAsyncSuffix(methodName(w.name)));
      }
    }
  }

  lines.push('    }');
  lines.push('}');

  return {
    path: csFile,
    content: lines.join('\n'),
    overwriteExisting: true,
  };
}

function generateOptionsFile(mountName: string, operations: Operation[], ctx: EmitterContext): GeneratedFile | null {
  const resolvedLookup = buildResolvedLookup(ctx);
  const optionsLines: string[] = [];
  let hasOptions = false;

  optionsLines.push(`namespace ${ctx.namespacePascal}`);
  optionsLines.push('{');
  optionsLines.push('    using System;');
  optionsLines.push('    using System.Collections.Generic;');
  optionsLines.push('    using Newtonsoft.Json;');
  optionsLines.push('    using STJS = System.Text.Json.Serialization;');

  const emittedOptions = new Set<string>();
  const emittedGroupTypes = new Set<string>();
  for (const op of operations) {
    const plan = planOperation(op);
    const method = resolveCsMethodName(op, mountName, ctx);
    const resolvedOp = lookupResolved(op, resolvedLookup);
    const hidden = buildHiddenParams(resolvedOp);

    // Union-split operations expose typed wrapper option classes
    // (AuthenticateWith*Options) instead of a generic raw options class.
    // Skip emitting an empty *CreateAuthenticateOptions placeholder.
    if ((resolvedOp?.wrappers?.length ?? 0) > 0) continue;

    const optionsClass = optionsClassName(mountName, method);
    if (emittedOptions.has(optionsClass)) continue;

    const groupedParams = collectGroupedParamNames(op);
    const hasGroups = (op.parameterGroups?.length ?? 0) > 0;
    const hasVisibleQueryParams =
      op.queryParams.filter((qp) => !hidden.has(qp.name) && !groupedParams.has(qp.name)).length > 0;
    const hasBody = plan.hasBody && op.requestBody;
    let hasVisibleBodyFields = false;
    if (hasBody && op.requestBody?.kind === 'model') {
      const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
      if (bodyModel) hasVisibleBodyFields = bodyModel.fields.some((f) => !hidden.has(f.name));
    } else if (hasBody) {
      hasVisibleBodyFields = true;
    }

    if (!hasVisibleQueryParams && !hasVisibleBodyFields && !hasGroups) continue;

    emittedOptions.add(optionsClass);
    hasOptions = true;

    // Determine base class: ListOptions for paginated list operations, BaseOptions otherwise
    const isPaginated = plan.isPaginated;
    const baseClass = isPaginated ? 'ListOptions' : 'BaseOptions';

    optionsLines.push('');
    const opSummary = op.description?.split('\n').find((l) => l.trim()) ?? `${method} on ${mountName}`;
    optionsLines.push(
      `    /// <summary>Request options for <see cref="${className(mountName)}Service.${method}"/>: ${escapeXml(opSummary.trim())}</summary>`,
    );
    optionsLines.push(`    public class ${optionsClass} : ${baseClass}`);
    optionsLines.push('    {');

    const emittedFields = new Set<string>();

    // Body fields
    if (hasBody && op.requestBody?.kind === 'model') {
      const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
      if (bodyModel) {
        for (const field of bodyModel.fields) {
          if (hidden.has(field.name)) continue;
          if (groupedParams.has(field.name)) continue;
          const csField = fieldName(field.name);
          if (emittedFields.has(csField)) continue;
          emittedFields.add(csField);

          const isOptional = !field.required;
          const baseType = mapTypeRef(field.type);
          const isAlreadyNullable = baseType.endsWith('?');
          let csType: string;
          let initializer = '';

          if (isOptional) {
            if (isAlreadyNullable) {
              csType = baseType;
            } else if (isValueTypeRef(field.type)) {
              csType = `${baseType}?`;
            } else {
              csType = `${baseType}?`;
            }
          } else {
            csType = baseType;
            if (!isAlreadyNullable && !isValueTypeRef(field.type)) {
              initializer = ' = default!;';
            }
          }

          const isRequiredEnum = field.required && isEnumRef(field.type);
          optionsLines.push(...emitXmlDoc(field.description, '        '));
          if (field.deprecated) {
            const msg = escapeCsAttributeString(deprecationMessage(field.description, 'field'));
            optionsLines.push(`        [System.Obsolete("${msg}")]`);
          }
          optionsLines.push(...emitJsonPropertyAttributes(field.name, { isRequiredEnum }));
          optionsLines.push(`        public ${csType} ${csField} { get; set; }${initializer}`);
          optionsLines.push('');
        }
      }
    }

    // Query params (skip pagination fields for list options — they're in ListOptions base,
    // and skip grouped params which get their own abstract class hierarchy)
    const PAGINATION_FIELDS = new Set(['before', 'after', 'limit', 'order']);
    for (const param of op.queryParams) {
      if (hidden.has(param.name)) continue;
      if (groupedParams.has(param.name)) continue;
      if (isPaginated && PAGINATION_FIELDS.has(param.name)) continue;
      const csField = fieldName(param.name);
      if (emittedFields.has(csField)) continue;
      emittedFields.add(csField);

      const isOptional = !param.required;
      const baseType = mapTypeRef(param.type);
      const isAlreadyNullable = baseType.endsWith('?');
      let csType: string;
      let initializer = '';

      if (isOptional) {
        if (isAlreadyNullable) {
          csType = baseType;
        } else if (isValueTypeRef(param.type)) {
          csType = `${baseType}?`;
        } else {
          csType = `${baseType}?`;
        }
      } else {
        csType = baseType;
        if (!isAlreadyNullable && !isValueTypeRef(param.type)) {
          initializer = ' = default!;';
        }
      }

      const isRequiredEnum = param.required && isEnumRef(param.type);
      optionsLines.push(...emitXmlDoc(param.description, '        '));
      if (param.deprecated) {
        const msg = escapeCsAttributeString(deprecationMessage(param.description, 'parameter'));
        optionsLines.push(`        [System.Obsolete("${msg}")]`);
      }
      optionsLines.push(...emitJsonPropertyAttributes(param.name, { isRequiredEnum }));
      optionsLines.push(`        public ${csType} ${csField} { get; set; }${initializer}`);
      optionsLines.push('');
    }

    // Hidden fields that need to be set programmatically (e.g., grant_type, client_id)
    const defaults = getOpDefaults(resolvedOp);
    const inferFromClient = getOpInferFromClient(resolvedOp);
    for (const key of Object.keys(defaults)) {
      const csField = fieldName(key);
      if (emittedFields.has(csField)) continue;
      emittedFields.add(csField);
      optionsLines.push(`        internal string ${csField} { get; set; } = default!;`);
      optionsLines.push('');
    }
    for (const key of inferFromClient) {
      const csField = fieldName(key);
      if (emittedFields.has(csField)) continue;
      emittedFields.add(csField);
      optionsLines.push(`        internal string ${csField} { get; set; } = default!;`);
      optionsLines.push('');
    }

    // Parameter group properties (serialized manually in the service method, not by JSON)
    for (const group of op.parameterGroups ?? []) {
      const baseName = groupBaseClassName(mountName, group.name);
      const csField = fieldName(group.name);
      optionsLines.push('        [JsonIgnore]');
      optionsLines.push('        [STJS.JsonIgnore]');
      const initializer = group.optional ? '' : ' = default!;';
      const csType = group.optional ? `${baseName}?` : baseName;
      optionsLines.push(`        public ${csType} ${csField} { get; set; }${initializer}`);
      optionsLines.push('');
    }

    optionsLines.push('    }');

    // Emit parameter group abstract base + concrete variant classes
    if (hasGroups) {
      optionsLines.push(...generateParameterGroupTypes(mountName, op, ctx.spec.models, emittedGroupTypes));
    }
  }

  optionsLines.push('}');

  if (!hasOptions) return null;

  return {
    path: `Services/${className(mountName)}/_interfaces/${className(mountName)}Options.cs`,
    content: optionsLines.join('\n'),
    overwriteExisting: true,
  };
}

function generateMethod(
  _serviceType: string,
  mountName: string,
  method: string,
  methodStem: string,
  op: Operation,
  plan: OperationPlan,
  ctx: EmitterContext,
  resolvedOp?: ResolvedOperation,
  hasCapturingDeleteAsync = false,
): string {
  const lines: string[] = [];
  const isPaginated = plan.isPaginated;
  const isDelete = plan.isDelete;
  const hasBody = plan.hasBody && op.requestBody;
  const hidden = buildHiddenParams(resolvedOp);
  const groupedParams = collectGroupedParamNames(op);
  const hasGroups = (op.parameterGroups?.length ?? 0) > 0;
  const hasVisibleQueryParams =
    op.queryParams.filter((qp) => !hidden.has(qp.name) && !groupedParams.has(qp.name)).length > 0;

  let hasVisibleBodyFields = false;
  if (hasBody && op.requestBody?.kind === 'model') {
    const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
    if (bodyModel) hasVisibleBodyFields = bodyModel.fields.some((f) => !hidden.has(f.name));
  } else if (hasBody) {
    hasVisibleBodyFields = true;
  }

  const hasParams = hasVisibleBodyFields || hasVisibleQueryParams || hasGroups;
  const optionsClass = hasParams ? optionsClassName(mountName, methodStem) : null;
  const hasHidden = hasHiddenParams(resolvedOp);

  // Per-operation Bearer token auth (e.g., SSO GetProfile uses access_token instead of API key)
  const hasBearerOverride = op.security?.some((s: any) => s.schemeName !== 'bearerAuth') ?? false;
  const bearerParamName = hasBearerOverride
    ? op.security!.find((s: any) => s.schemeName !== 'bearerAuth')!.schemeName
    : null;

  // URL-builder operations (e.g., /sso/authorize redirect endpoints) build a URL
  // string for the caller to redirect to instead of issuing an HTTP request.
  const isUrlBuilder = resolvedOp?.urlBuilder ?? false;

  // Return type
  let returnType: string;
  if (isUrlBuilder) {
    returnType = 'string';
  } else if (isPaginated && op.pagination) {
    const itemType = resolveListItemType(op.pagination.itemType, ctx);
    returnType = `Task<WorkOSList<${itemType}>>`;
  } else if (isDelete) {
    returnType = 'Task';
  } else if (plan.responseModelName) {
    const respType = modelClassName(resolveModelName(plan.responseModelName));
    if (!isPaginated && op.response?.kind === 'array') {
      returnType = `Task<List<${respType}>>`;
    } else {
      returnType = `Task<${respType}>`;
    }
  } else {
    returnType = 'Task';
  }

  // XML doc comment (full multi-line description from the spec)
  lines.push(...emitXmlDoc(op.description, '        '));
  for (const p of sortPathParamsByTemplateOrder(op)) {
    const paramDesc = p.description ? escapeXml(p.description) : `The ${humanize(p.name)}.`;
    lines.push(`        /// <param name="${localName(p.name)}">${paramDesc}</param>`);
  }
  if (hasBearerOverride && bearerParamName) {
    lines.push(`        /// <param name="${localName(bearerParamName)}">The bearer token for authentication.</param>`);
  }
  if (optionsClass) {
    lines.push(`        /// <param name="options">Request options.</param>`);
  }
  if (!isUrlBuilder) {
    lines.push(`        /// <param name="requestOptions">Per-request configuration overrides.</param>`);
    lines.push(`        /// <param name="cancellationToken">Cancellation token.</param>`);
  }
  if (isUrlBuilder) {
    lines.push(`        /// <returns>The fully-qualified URL for the caller to redirect to.</returns>`);
  } else if (isPaginated && op.pagination) {
    const itemType = resolveListItemType(op.pagination.itemType, ctx);
    lines.push(`        /// <returns>A page of <see cref="${itemType}"/> results.</returns>`);
  } else if (plan.responseModelName) {
    const respType = modelClassName(resolveModelName(plan.responseModelName));
    lines.push(`        /// <returns>The <see cref="${respType}"/> result.</returns>`);
  }
  if (op.deprecated) {
    const msg = escapeCsAttributeString(deprecationMessage(op.description, 'operation'));
    lines.push(`        [System.Obsolete("${msg}")]`);
  }

  // Method signature
  const params: string[] = [];
  for (const p of sortPathParamsByTemplateOrder(op)) {
    params.push(`string ${localName(p.name)}`);
  }
  if (hasBearerOverride && bearerParamName) {
    params.push(`string ${localName(bearerParamName)}`);
  }
  if (optionsClass) {
    const isRequired = hasVisibleBodyFields && !isPaginated;
    params.push(isRequired ? `${optionsClass} options` : `${optionsClass}? options = null`);
  }
  if (!isUrlBuilder) {
    params.push('RequestOptions? requestOptions = null');
    params.push('CancellationToken cancellationToken = default');
  }

  const asyncKeyword = isUrlBuilder ? '' : 'async ';
  lines.push(`        public virtual ${asyncKeyword}${returnType} ${method}(${params.join(', ')})`);
  lines.push('        {');

  // Inject hidden params
  if (hasHidden && optionsClass) {
    const isOptionalParam = !hasVisibleBodyFields || isPaginated;
    if (isOptionalParam) {
      lines.push(`            options ??= new ${optionsClass}();`);
    }
    const defaults = getOpDefaults(resolvedOp);
    const inferFromClient = getOpInferFromClient(resolvedOp);
    for (const [key, value] of Object.entries(defaults)) {
      lines.push(`            options.${fieldName(key)} = ${csLiteral(value as string | number | boolean)};`);
    }
    for (const field of inferFromClient) {
      if (field === 'client_id') {
        lines.push(`            options.${fieldName(field)} = this.Client.RequireClientId();`);
      } else {
        lines.push(
          `            options.${fieldName(field)} = this.Client.${clientFieldExpression(field)} ?? string.Empty;`,
        );
      }
    }
  }

  // Build path
  const pathExpr = buildPathExpr(op);

  // URL-builders, bearer-override operations, and operations with parameter
  // groups keep the inlined WorkOSRequest form because the Service helpers
  // don't expose BuildRequestUri, AccessToken configuration, or manual
  // query param injection. Everything else uses the helper one-liners.
  const needsInlineRequest = isUrlBuilder || (hasBearerOverride && !!bearerParamName) || hasGroups;
  const optionsArg = optionsClass ? 'options' : 'null';

  if (needsInlineRequest) {
    lines.push('            var request = new WorkOSRequest');
    lines.push('            {');
    lines.push(`                Method = HttpMethod.${httpMethodCs(op.httpMethod)},`);
    lines.push(`                Path = ${pathExpr},`);
    if (optionsClass) {
      lines.push('                Options = options,');
    }
    if (hasBearerOverride && bearerParamName) {
      lines.push(`                AccessToken = ${localName(bearerParamName)},`);
    }
    if (!isUrlBuilder) {
      lines.push(`                RequestOptions = requestOptions,`);
    }
    lines.push('            };');

    // Serialize parameter group variants into query params (GET/DELETE)
    // or body params (POST/PUT/PATCH) so sensitive fields like passwords
    // never leak into the URL.  DELETE is routed to query because the
    // dotnet HTTP client only sends body content for non-GET/DELETE methods.
    if (hasGroups) {
      const groupTarget = hasBody && !isDelete ? 'body' : 'query';
      lines.push('');
      lines.push(...emitGroupSerialization(mountName, op, '            ', ctx.spec.models, groupTarget));
      lines.push('');
    }

    if (isUrlBuilder) {
      lines.push('            return this.Client.BuildRequestUri(request).ToString();');
    } else if (returnType.startsWith('Task<')) {
      const innerType = returnType.slice(5, -1);
      lines.push(`            return await this.Client.MakeAPIRequest<${innerType}>(request, cancellationToken);`);
    } else {
      lines.push('            await this.Client.MakeRawAPIRequest(request, cancellationToken);');
    }
  } else if (isDelete) {
    // See hasCapturingDeleteAsync in generateServiceFile. A null argument is
    // captured by any two-leading-parameter DeleteAsync in the class; a typed
    // options argument only by this method itself (no other DeleteAsync can
    // take this options class, and string parameters don't accept it).
    const captured = optionsClass
      ? method === 'DeleteAsync' && leadingParamCount(op, plan, ctx, resolvedOp) === 2
      : hasCapturingDeleteAsync;
    const receiver = captured ? 'base' : 'this';
    lines.push(
      `            await ${receiver}.DeleteAsync(${pathExpr}, ${optionsArg}, requestOptions, cancellationToken);`,
    );
  } else if (returnType.startsWith('Task<')) {
    const innerType = returnType.slice(5, -1);
    const helper = httpMethodHelperName(op.httpMethod);
    lines.push(
      `            return await this.${helper}<${innerType}>(${pathExpr}, ${optionsArg}, requestOptions, cancellationToken);`,
    );
  } else {
    const helper = httpMethodHelperName(op.httpMethod);
    lines.push(
      `            await this.${helper}<object>(${pathExpr}, ${optionsArg}, requestOptions, cancellationToken);`,
    );
  }

  lines.push('        }');
  return lines.join('\n');
}

function generateAutoPagingMethod(
  mountName: string,
  method: string,
  methodStem: string,
  op: Operation,
  plan: OperationPlan,
  ctx: EmitterContext,
  resolvedOp?: ResolvedOperation,
): string {
  const lines: string[] = [];
  const hidden = buildHiddenParams(resolvedOp);
  const groupedParams = collectGroupedParamNames(op);
  const hasGroups = (op.parameterGroups?.length ?? 0) > 0;
  const hasVisibleQueryParams =
    op.queryParams.filter((qp) => !hidden.has(qp.name) && !groupedParams.has(qp.name)).length > 0;

  let hasVisibleBodyFields = false;
  if (plan.hasBody && op.requestBody?.kind === 'model') {
    const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
    if (bodyModel) hasVisibleBodyFields = bodyModel.fields.some((f) => !hidden.has(f.name));
  }

  const hasParams = hasVisibleBodyFields || hasVisibleQueryParams || hasGroups;
  const optionsClass = hasParams ? optionsClassName(mountName, methodStem) : null;

  const itemType = resolveListItemType(op.pagination!.itemType, ctx);

  // XML doc
  lines.push(
    `        /// <summary>Auto-paging variant of <see cref="${method}"/>. Yields individual items across all pages.</summary>`,
  );
  for (const p of sortPathParamsByTemplateOrder(op)) {
    const paramDesc = p.description ? escapeXml(p.description) : `The ${humanize(p.name)}.`;
    lines.push(`        /// <param name="${localName(p.name)}">${paramDesc}</param>`);
  }
  if (optionsClass) {
    lines.push(`        /// <param name="options">Request options.</param>`);
  }
  lines.push(`        /// <param name="requestOptions">Per-request configuration overrides.</param>`);
  lines.push(`        /// <param name="cancellationToken">Cancellation token.</param>`);
  lines.push(`        /// <returns>An async sequence of <see cref="${itemType}"/> items.</returns>`);

  // Signature
  const params: string[] = [];
  for (const p of sortPathParamsByTemplateOrder(op)) {
    params.push(`string ${localName(p.name)}`);
  }
  if (optionsClass) {
    params.push(`${optionsClass}? options = null`);
  }
  params.push('RequestOptions? requestOptions = null');
  params.push('CancellationToken cancellationToken = default');

  lines.push(`        public virtual IAsyncEnumerable<${itemType}> ${methodStem}AutoPagingAsync(${params.join(', ')})`);
  lines.push('        {');

  const pathExpr = buildPathExpr(op);
  const optionsArg = optionsClass ? 'options' : 'null';
  lines.push(
    `            return this.ListAutoPagingAsync<${itemType}>(${pathExpr}, ${optionsArg}, requestOptions, cancellationToken);`,
  );
  lines.push('        }');

  return lines.join('\n');
}

function resolveCsMethodName(op: Operation, mountName: string, ctx: EmitterContext): string {
  return resolveMethodName(op, { name: mountName, operations: [op] }, ctx);
}

export function resolveCsMethodStem(op: Operation, mountName: string, ctx: EmitterContext): string {
  return resolveMethodStem(op, { name: mountName, operations: [op] }, ctx);
}

export function optionsClassName(mountName: string, method: string): string {
  const methodStem = method.endsWith('Async') ? method.slice(0, -5) : method;
  const prefix = className(mountName);
  if (methodStem.startsWith(prefix)) return `${methodStem}Options`;
  return `${prefix}${methodStem}Options`;
}

function buildPathExpr(op: Operation): string {
  if (op.pathParams.length === 0) {
    return `"${op.path}"`;
  }
  // Build C# string interpolation
  let interpolated = op.path;
  for (const p of sortPathParamsByTemplateOrder(op)) {
    interpolated = interpolated.replace(`{${p.name}}`, `{Uri.EscapeDataString(${localName(p.name)})}`);
  }
  return `$"${interpolated}"`;
}

function resolveListItemType(itemType: import('@workos/oagen').TypeRef, ctx: EmitterContext): string {
  if (itemType.kind === 'model') {
    const model = ctx.spec.models.find((m) => m.name === itemType.name);
    if (model && isListWrapperModel(model)) {
      const dataField = model.fields.find((f) => f.name === 'data');
      if (dataField && dataField.type.kind === 'array' && dataField.type.items.kind === 'model') {
        return modelClassName(resolveModelName(dataField.type.items.name));
      }
    }
    return modelClassName(resolveModelName(itemType.name));
  }
  return mapTypeRef(itemType);
}

function generateCompatibilityMethod(
  mountName: string,
  asyncMethod: string,
  methodStem: string,
  op: Operation,
  plan: OperationPlan,
  ctx: EmitterContext,
  resolvedOp?: ResolvedOperation,
): string {
  const lines: string[] = [];
  const hidden = buildHiddenParams(resolvedOp);
  const groupedParams = collectGroupedParamNames(op);
  const hasGroups = (op.parameterGroups?.length ?? 0) > 0;
  const hasVisibleQueryParams =
    op.queryParams.filter((qp) => !hidden.has(qp.name) && !groupedParams.has(qp.name)).length > 0;

  let hasVisibleBodyFields = false;
  if (plan.hasBody && op.requestBody?.kind === 'model') {
    const bodyModel = ctx.spec.models.find((m) => op.requestBody?.kind === 'model' && m.name === op.requestBody.name);
    if (bodyModel) hasVisibleBodyFields = bodyModel.fields.some((f) => !hidden.has(f.name));
  } else if (plan.hasBody && op.requestBody) {
    hasVisibleBodyFields = true;
  }

  const hasParams = hasVisibleBodyFields || hasVisibleQueryParams || hasGroups;
  const optionsClass = hasParams ? optionsClassName(mountName, methodStem) : null;

  let returnType = 'Task';
  if (plan.isPaginated && op.pagination) {
    const itemType = resolveListItemType(op.pagination.itemType, ctx);
    returnType = `Task<WorkOSList<${itemType}>>`;
  } else if (plan.responseModelName) {
    const respType = modelClassName(resolveModelName(plan.responseModelName));
    returnType = !plan.isPaginated && op.response?.kind === 'array' ? `Task<List<${respType}>>` : `Task<${respType}>`;
  }

  const params: string[] = [];
  const args: string[] = [];
  for (const p of sortPathParamsByTemplateOrder(op)) {
    const name = localName(p.name);
    params.push(`string ${name}`);
    args.push(name);
  }

  const hasBearerOverride = op.security?.some((s: any) => s.schemeName !== 'bearerAuth') ?? false;
  if (hasBearerOverride) {
    const bearerParamName = op.security!.find((s: any) => s.schemeName !== 'bearerAuth')!.schemeName;
    const bearerLocal = localName(bearerParamName);
    params.push(`string ${bearerLocal}`);
    args.push(bearerLocal);
  }

  if (optionsClass) {
    const isRequired = hasVisibleBodyFields && !plan.isPaginated;
    params.push(isRequired ? `${optionsClass} options` : `${optionsClass}? options = null`);
    args.push('options');
  }

  params.push('RequestOptions? requestOptions = null');
  params.push('CancellationToken cancellationToken = default');
  args.push('requestOptions');
  args.push('cancellationToken');

  lines.push(`        /// <summary>Compatibility wrapper for <see cref="${asyncMethod}"/>.</summary>`);
  lines.push(`        public virtual ${returnType} ${methodStem}(${params.join(', ')})`);
  lines.push('        {');
  lines.push(`            return this.${asyncMethod}(${args.join(', ')});`);
  lines.push('        }');

  return lines.join('\n');
}

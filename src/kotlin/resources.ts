import type {
  Service,
  Operation,
  Parameter,
  EmitterContext,
  GeneratedFile,
  ResolvedOperation,
  Model,
  TypeRef,
  Field,
} from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import { mapTypeRef, mapTypeRefOptional, implicitImportsFor } from './type-map.js';
import {
  isListWrapperModel,
  isListMetadataModel,
  collectNonPaginatedResponseModelNames,
  collectReferencedListMetadataModels,
  unwrapListModel,
} from '../shared/model-utils.js';
import { enumCanonicalMap } from './enums.js';
import {
  className,
  propertyName,
  resolveApiClassName,
  packageSegment,
  resolveMethodName,
  ktLiteral,
  clientFieldExpression,
  escapeReserved,
  humanize,
  maybeShortenEnumParamDescription,
  buildExportedClassNameSet,
} from './naming.js';
import {
  buildResolvedLookup,
  lookupResolved,
  scopedMountGroups,
  buildHiddenParams,
  getOpDefaults,
  getOpInferFromClient,
  collectGroupedParamNames,
  collectBodyFieldTypes,
  groupTypeBaseName,
} from '../shared/resolved-ops.js';
import { generateWrapperMethods } from './wrappers.js';
import { resolveWrapperParams } from '../shared/wrapper-utils.js';
import { isHandwrittenOverride } from './overrides.js';
import { buildKotlinPathExpression, KOTLIN_PATH_ENCODE_IMPORT } from './path-expression.js';
import { emitSuspendVariant, SUSPEND_IMPORTS, type SuspendParam } from './suspend.js';

const KOTLIN_SRC_PREFIX = 'src/main/kotlin/';

/**
 * Some specs leave query params / fields typed as plain `string` even though
 * the description (or the field name) makes clear they carry an ISO-8601
 * timestamp. Detecting that here lets us emit `OffsetDateTime` so callers
 * don't have to format the wire string themselves.
 */
const ISO_8601_DESCRIPTION_RE = /\bISO[-_ ]?8601\b/i;

function looksLikeIso8601String(description: string | undefined): boolean {
  if (!description) return false;
  return ISO_8601_DESCRIPTION_RE.test(description);
}

/**
 * Promote a string `TypeRef` to a `format: date-time` primitive when the
 * accompanying description identifies it as an ISO-8601 timestamp. Leaves
 * non-string types untouched.
 */
function promoteIso8601TypeRef(type: TypeRef, description: string | undefined): TypeRef {
  if (!looksLikeIso8601String(description)) return type;
  const promote = (t: TypeRef): TypeRef => {
    if (t.kind === 'primitive' && t.type === 'string' && !t.format) {
      return { kind: 'primitive', type: 'string', format: 'date-time' };
    }
    if (t.kind === 'nullable') return { kind: 'nullable', inner: promote(t.inner) };
    return t;
  };
  return promote(type);
}

function promoteParameterType(p: Parameter): Parameter {
  const promoted = promoteIso8601TypeRef(p.type, p.description);
  return promoted === p.type ? p : { ...p, type: promoted };
}

function promoteFieldType(f: Field): Field {
  const promoted = promoteIso8601TypeRef(f.type, f.description);
  return promoted === f.type ? f : { ...f, type: promoted };
}

/**
 * Generate one API class per mount group. Methods map 1:1 to IR operations.
 * Path params, query params, and body fields are flattened into the method
 * signature so callers never need to construct an intermediate options object.
 */
export function generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  if (services.length === 0) return [];

  const mountGroups = scopedMountGroups(ctx);
  if (mountGroups.size === 0) return [];

  const files: GeneratedFile[] = [];
  const resolvedLookup = buildResolvedLookup(ctx);
  const exportedClasses = buildExportedClassNameSet(ctx);

  for (const [mountName, group] of mountGroups) {
    const classCode = generateApiClass(mountName, group.operations, ctx, resolvedLookup);
    if (!classCode) continue;
    const pkg = packageSegment(mountName);
    files.push({
      path: `${KOTLIN_SRC_PREFIX}com/workos/${pkg}/${resolveApiClassName(mountName, exportedClasses)}.kt`,
      content: classCode,
      overwriteExisting: true,
    });
  }

  return files;
}

function generateApiClass(
  mountName: string,
  operations: Operation[],
  ctx: EmitterContext,
  resolvedLookup: Map<string, ResolvedOperation>,
): string | null {
  if (operations.length === 0) return null;
  const apiClass = resolveApiClassName(mountName, buildExportedClassNameSet(ctx));
  const pkg = `com.workos.${packageSegment(mountName)}`;

  const imports = new Set<string>();
  imports.add('com.workos.WorkOS');
  imports.add('com.workos.common.http.Page');
  imports.add('com.workos.common.http.RequestConfig');
  imports.add('com.workos.common.http.RequestOptions');
  // Every emitted method gains a `suspend` overload that delegates to the
  // blocking version under `withContext(Dispatchers.IO)`.
  for (const imp of SUSPEND_IMPORTS) imports.add(imp);

  const body: string[] = [];
  const seenMethods = new Set<string>();
  const hasAuthenticateHelper = operations.some(
    (op) => op.path === '/user_management/authenticate' && op.httpMethod.toUpperCase() === 'POST',
  );

  if (hasAuthenticateHelper) {
    imports.add('com.workos.common.http.bodyOf');
    imports.add('com.workos.models.AuthenticateResponse');
    body.push(...generateAuthenticateHelper());
  }

  for (const op of operations) {
    if (isHandwrittenOverride(op)) continue;
    const resolvedOp = lookupResolved(op, resolvedLookup);
    if ((resolvedOp?.wrappers?.length ?? 0) > 0) {
      // Emit one method per wrapper instead of the raw union-split operation.
      for (const wrapper of resolvedOp!.wrappers!) {
        if (wrapper.responseModelName) {
          imports.add(`com.workos.models.${className(wrapper.responseModelName)}`);
        }
        // Register imports for wrapper param field types
        const resolvedParams = resolveWrapperParams(wrapper, ctx);
        for (const rp of resolvedParams) {
          if (rp.field) registerTypeImports(rp.field.type, imports, ctx);
        }
      }
      // Wrapper methods use bodyOf() for request body construction.
      imports.add('com.workos.common.http.bodyOf');
      // Wrappers share the operation's path; if it has any {param}, the
      // wrapper emits encodePathSegment(...) and needs the import.
      if (/\{[^{}]+\}/.test(resolvedOp!.operation.path)) {
        imports.add(KOTLIN_PATH_ENCODE_IMPORT);
      }
      const wrapperLines = generateWrapperMethods(resolvedOp!, ctx);
      if (body.length > 0) body.push('');
      for (const line of wrapperLines) body.push(line);
      continue;
    }

    const method = resolveMethodName(op, findService(ctx, op) ?? ({} as Service), ctx);
    if (seenMethods.has(method)) continue;
    seenMethods.add(method);

    const rendered = renderMethod(mountName, method, op, ctx, resolvedOp, imports);
    if (body.length > 0) body.push('');
    body.push(rendered);
  }

  if (body.length === 0) return null;

  // Emit sealed classes for parameter groups before the API class.
  // Parameter-group IR can lose body field type fidelity; prefer the request
  // body model's field type when available.
  const sealedLines: string[] = [];
  const emittedSealedClasses = new Set<string>();
  for (const op of operations) {
    if ((op.parameterGroups?.length ?? 0) > 0) {
      // Resolved per operation, never merged across the file. The map is keyed
      // by wire field name and two operations can type one field differently —
      // `saml_options` is a CreateConnectionSAMLOptions on create and a
      // PatchConnectionSAMLOptions on update — so a file-wide map lets whichever
      // operation happens to be visited last decide the type for all of them.
      const bodyFieldTypes = collectBodyFieldTypes(op, ctx.spec.models);
      for (const group of op.parameterGroups ?? []) {
        // Register imports for types used in parameter group sealed classes.
        // The body field type override may introduce enum/model types that
        // the original IR parameter didn't reference.
        for (const variant of group.variants) {
          for (const p of variant.parameters) {
            const effectiveType = bodyFieldTypes.get(p.name) ?? p.type;
            registerTypeImports(effectiveType, imports, ctx);
          }
        }
        // Keyed on the type base name: where two operations' declarations of a
        // group diverge oagen gives them distinct base names, and both sealed
        // classes have to be emitted rather than the first one winning.
        const sealedKey = groupTypeBaseName(group);
        if (emittedSealedClasses.has(sealedKey)) continue;
        emittedSealedClasses.add(sealedKey);
        for (const line of generateSealedClass(group, bodyFieldTypes)) sealedLines.push(line);
      }
    }
  }

  // Drop unused imports by peeking at the body text and sealed class text.
  const allText = body.join('\n') + '\n' + sealedLines.join('\n');
  const filteredImports = [...imports].filter((imp) => {
    const simple = imp.slice(imp.lastIndexOf('.') + 1);
    // Skip the import if the class body never references the simple name.
    if (simple === 'WorkOS' || simple === 'RequestOptions') return true;
    return new RegExp(`\\b${simple}\\b`).test(allText);
  });

  const lines: string[] = [];
  lines.push(`package ${pkg}`);
  lines.push('');
  for (const imp of filteredImports.sort()) lines.push(`import ${imp}`);
  lines.push('');
  for (const line of sealedLines) lines.push(line);

  const serviceDescription = resolveServiceDescription(ctx, mountName, operations);
  // Every blocking method on this class also has a `suspend` overload — the
  // suspend variant delegates to the blocking one via
  // `withContext(Dispatchers.IO)` and is safe to call from any coroutine
  // dispatcher. The service-level KDoc surfaces this so callers don't have to
  // discover it per-method.
  const suspendNote =
    'Every operation on this class is available in two flavors: a blocking variant ' +
    '(`<methodName>`) and a coroutine-aware variant (`<methodName>Suspend`). ' +
    'The `Suspend` variants delegate to the blocking ones under `withContext(Dispatchers.IO)`, ' +
    'so they are safe to call from any coroutine dispatcher (including `Dispatchers.Main`).';
  if (serviceDescription) {
    const docLines = serviceDescription.trim().split('\n');
    lines.push('/**');
    for (const l of docLines) lines.push(l ? ` * ${escapeKdoc(l)}` : ' *');
    lines.push(' *');
    lines.push(` * ${escapeKdoc(suspendNote)}`);
    lines.push(' */');
  } else {
    lines.push('/**');
    lines.push(` * API accessor for ${mountName}.`);
    lines.push(' *');
    lines.push(` * ${escapeKdoc(suspendNote)}`);
    lines.push(' */');
  }
  // ktlint requires constructor-property parameters on their own line.
  // The property is `internal` so hand-maintained extension files in the
  // same module can reach the underlying [WorkOS] client (e.g. to build
  // URLs that are not HTTP calls).
  lines.push(`class ${apiClass}(`);
  lines.push('  internal val workos: WorkOS');
  lines.push(`) {`);
  for (const line of body) lines.push(line);
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function findService(ctx: EmitterContext, op: Operation): Service | undefined {
  for (const service of ctx.spec.services) {
    if (service.operations.includes(op)) return service;
  }
  return undefined;
}

/**
 * Resolve a human-friendly description for a generated API class. Walks the
 * operations in the mount group, picks the first service whose description
 * is populated, and falls back to `null` when nothing meaningful is
 * available (the caller uses a generic fallback).
 */
function resolveServiceDescription(ctx: EmitterContext, _mountName: string, operations: Operation[]): string | null {
  for (const op of operations) {
    const svc = findService(ctx, op);
    if (svc?.description?.trim()) return svc.description;
  }
  return null;
}

/**
 * Render a single SDK method for an operation.
 */
function renderMethod(
  _mountName: string,
  method: string,
  op: Operation,
  ctx: EmitterContext,
  resolvedOp: ResolvedOperation | undefined,
  imports: Set<string>,
): string {
  const plan = planOperation(op);
  const hidden = buildHiddenParams(resolvedOp);
  const defaults = getOpDefaults(resolvedOp);
  const inferFromClient = getOpInferFromClient(resolvedOp);

  const httpMethod = op.httpMethod.toUpperCase();
  const pathParams = sortPathParamsByTemplateOrder(op);
  const groupedParamNames = collectGroupedParamNames(op);
  const hasGroups = (op.parameterGroups?.length ?? 0) > 0;
  const queryParams = op.queryParams
    .filter((p) => !hidden.has(p.name) && !groupedParamNames.has(p.name))
    .map(promoteParameterType);
  const bodyModel = resolveBodyModel(op, ctx);
  const bodyFields = bodyModel
    ? bodyModel.fields.filter((f) => !hidden.has(f.name) && !groupedParamNames.has(f.name)).map(promoteFieldType)
    : [];

  // Track imports we need
  for (const p of [...pathParams, ...queryParams]) registerTypeImports(p.type, imports, ctx);
  for (const f of bodyFields) registerTypeImports(f.type, imports, ctx);
  const paginatedItemName = resolvePaginatedItemName(plan.paginatedItemModelName, ctx);
  if (plan.responseModelName && !plan.isPaginated) {
    imports.add(`com.workos.models.${className(plan.responseModelName)}`);
  }
  if (paginatedItemName) {
    imports.add(`com.workos.models.${className(paginatedItemName)}`);
    imports.add('com.fasterxml.jackson.core.type.TypeReference');
  }

  // Deduplicate: path params take precedence; query params second; body last.
  // If a body field collides with a path/query param, rename the body field's
  // Kotlin parameter (e.g. `slug` → `bodySlug`) so callers can pass both
  // values. The wire name on the body map still uses the original field name.
  const paramNames = new Set<string>();
  for (const pp of pathParams) paramNames.add(propertyName(pp.name));
  const uniqueQuery = queryParams.filter((qp) => !paramNames.has(propertyName(qp.name)));
  for (const qp of uniqueQuery) paramNames.add(propertyName(qp.name));

  const sharedQueryBodyParams = new Set(
    uniqueQuery
      .filter((qp) => bodyFields.some((bf) => bf.name === qp.name && mapTypeRef(qp.type) === mapTypeRef(bf.type)))
      .map((qp) => qp.name),
  );

  // Map body field wire name → Kotlin parameter name. When the natural name
  // collides with a path/query, prefix with `body` (e.g. slug → bodySlug).
  const bodyParamNames = new Map<string, string>();
  for (const bf of bodyFields) {
    const natural = propertyName(bf.name);
    if (sharedQueryBodyParams.has(bf.name)) {
      bodyParamNames.set(bf.name, natural);
      continue;
    }
    if (paramNames.has(natural)) {
      const renamed = `body${natural.charAt(0).toUpperCase()}${natural.slice(1)}`;
      bodyParamNames.set(bf.name, renamed);
      paramNames.add(renamed);
    } else {
      bodyParamNames.set(bf.name, natural);
      paramNames.add(natural);
    }
  }

  const groupParamNames = assignGroupParameterNames(op, paramNames);

  const params: string[] = [];
  // Mirrors `params` but tracks the bare Kotlin parameter name so the suspend
  // overload (emitted alongside the blocking version) can forward arguments.
  const suspendParams: SuspendParam[] = [];
  const pushParam = (decl: string, name: string) => {
    params.push(decl);
    suspendParams.push({ decl, name });
  };
  for (const pp of pathParams) pushParam(`    ${propertyName(pp.name)}: String`, propertyName(pp.name));

  const sortedQuery = [...uniqueQuery].sort((a, b) => (a.required === b.required ? 0 : a.required ? -1 : 1));
  for (const qp of sortedQuery) {
    pushParam(
      renderParam(qp.name, qp.type, qp.required, method.startsWith('list') && qp.name === 'limit'),
      propertyName(qp.name),
    );
  }

  // Parameter group params (sealed class types)
  for (const group of op.parameterGroups ?? []) {
    const sealedName = sealedGroupName(group);
    const prop = groupParamNames.get(group.name)!;
    if (group.optional) {
      pushParam(`    ${prop}: ${sealedName}? = null`, prop);
    } else {
      pushParam(`    ${prop}: ${sealedName}`, prop);
    }
  }

  // PATCH operations use PatchField<T> for optional body fields so callers
  // can distinguish "omit" (Absent) from "clear" (Present(null)).
  const isPatch = httpMethod === 'PATCH';

  const sortedBodyFields = [...bodyFields].sort((a, b) => (a.required === b.required ? 0 : a.required ? -1 : 1));
  for (const bf of sortedBodyFields) {
    if (sharedQueryBodyParams.has(bf.name)) continue;
    if (isPatch && !bf.required) {
      const baseType = mapTypeRef(bf.type);
      imports.add('com.workos.common.http.PatchField');
      pushParam(
        `    ${bodyParamNames.get(bf.name)!}: PatchField<${baseType}> = PatchField.Absent`,
        bodyParamNames.get(bf.name)!,
      );
    } else {
      pushParam(renderParamNamed(bodyParamNames.get(bf.name)!, bf.type, bf.required), bodyParamNames.get(bf.name)!);
    }
  }

  // Per-request options trailer (always optional)
  pushParam('    requestOptions: RequestOptions? = null', 'requestOptions');

  const returnType = resolveReturnType(plan, imports, ctx);
  const isPaginated = plan.isPaginated && paginatedItemName !== null;

  const lines: string[] = [];
  const kdocLines = buildMethodKdoc(op, pathParams, sortedQuery, sortedBodyFields, bodyParamNames, plan);
  for (const ln of kdocLines) lines.push(ln);
  if (op.deprecated) lines.push('  @Deprecated("Deprecated operation")');
  lines.push('  @JvmOverloads');
  // Omit explicit `: Unit` to keep ktlint happy.
  const returnClause = returnType === 'Unit' ? '' : `: ${returnType}`;
  if (params.length === 1) {
    // Single param fits on one line; ktlint enforces inline form.
    const singleParam = params[0].replace(/^\s+/, '');
    lines.push(`  fun ${escapeReserved(method)}(${singleParam})${returnClause} {`);
  } else {
    lines.push(`  fun ${escapeReserved(method)}(`);
    for (let i = 0; i < params.length; i++) {
      const suffix = i === params.length - 1 ? '' : ',';
      lines.push(`${params[i]}${suffix}`);
    }
    lines.push(`  )${returnClause} {`);
  }

  // Build body / query config
  //
  // POST/PUT/PATCH always need a request body — OkHttp rejects them otherwise.
  // DELETE and GET only emit a body when the spec explicitly declares one
  // (OpenAPI allows DELETE-with-body; GET-with-body is uncommon but legal).
  // GET never carries defaults/inferFromClient in the body — those fall back
  // to the query string for GET.
  const methodAlwaysHasBody = ['POST', 'PUT', 'PATCH'].includes(httpMethod);
  const specDeclaresBody = op.requestBody !== undefined;
  const hasBody =
    methodAlwaysHasBody ||
    (specDeclaresBody && httpMethod !== 'GET') ||
    ((httpMethod === 'PUT' || httpMethod === 'PATCH' || httpMethod === 'POST' || httpMethod === 'DELETE') &&
      (Object.keys(defaults).length > 0 || inferFromClient.length > 0) &&
      specDeclaresBody);
  const appendDefaultsAsQuery = !hasBody && (Object.keys(defaults).length > 0 || inferFromClient.length > 0);
  const pathBuilt = buildKotlinPathExpression(op.path);
  const pathExpr = pathBuilt.expression;
  if (pathBuilt.requiresEncodeImport) imports.add(KOTLIN_PATH_ENCODE_IMPORT);

  if (
    op.path === '/user_management/authenticate' &&
    httpMethod === 'POST' &&
    plan.responseModelName === 'AuthenticateResponse'
  ) {
    imports.add('com.workos.models.AuthenticateResponse');
    const grantType = defaults.grant_type ?? 'authorization_code';
    const entryLines = sortedBodyFields
      .filter((bf) => bf.name !== 'grant_type' && bf.name !== 'client_id' && bf.name !== 'client_secret')
      .map((bf) => `      ${ktLiteral(bf.name)} to ${bodyParamNames.get(bf.name)!}`);
    lines.push(`    return authenticate(`);
    lines.push(`      grantType = ${ktLiteral(grantType)},`);
    lines.push(`      requestOptions = requestOptions,`);
    for (let i = 0; i < entryLines.length; i++) {
      const suffix = i === entryLines.length - 1 ? '' : ',';
      lines.push(`${entryLines[i]}${suffix}`);
    }
    lines.push(`    )`);
    lines.push('  }');
    appendSuspendVariantLines(lines, method, suspendParams, returnType, op.deprecated);
    return lines.join('\n');
  }

  if (isPaginated) {
    // Nested helper function + requestPage call; 'after' is owned by the
    // cursor logic so we skip it in the generic query loop.
    // 'after' and 'before' are owned by the cursor logic. 'before' is only
    // included on the first page — re-sending it on follow-up pages (where
    // afterCursor is set by the pagination engine) is nonsensical and can
    // cause empty or looping results from the server.
    imports.add('com.workos.common.http.addIfNotNull');
    imports.add('com.workos.common.http.addJoinedIfNotNull');
    imports.add('com.workos.common.http.addEach');
    const itemClass = className(paginatedItemName!);
    lines.push(`    val itemType = object : TypeReference<${itemClass}>() {}`);
    lines.push(`    return workos.baseClient.requestPage(`);
    lines.push(`      method = ${ktLiteral(httpMethod)},`);
    lines.push(`      path = ${pathExpr},`);
    lines.push(`      itemType = itemType,`);
    lines.push(`      requestOptions = requestOptions,`);
    lines.push(`      before = ${pickNamedQueryParam(sortedQuery, 'before')},`);
    lines.push(`      after = ${pickNamedQueryParam(sortedQuery, 'after')}`);
    lines.push(`    ) {`);
    for (const qp of sortedQuery.filter((p) => p.name !== 'after' && p.name !== 'before')) {
      for (const ln of emitQueryParam(qp, '      ', true)) lines.push(ln);
    }
    for (const group of op.parameterGroups ?? []) {
      for (const ln of emitGroupQueryDispatch(group, groupParamNames.get(group.name)!, '      ', true)) {
        lines.push(ln);
      }
    }
    lines.push(`    }`);
  } else {
    // Only emit the `params` local when the method actually contributes
    // query parameters (spec-declared query, or defaults/inferFromClient
    // for GET/DELETE without a body). `RequestConfig.queryParams` defaults
    // to `emptyList()` when omitted, so we avoid dead local declarations.
    // Groups go to the body for POST/PUT/PATCH (hasBody), query otherwise.
    const groupsGoToQuery = hasGroups && !hasBody;
    const emitsQueryParams = sortedQuery.length > 0 || appendDefaultsAsQuery || groupsGoToQuery;
    if (emitsQueryParams) {
      imports.add('com.workos.common.http.addIfNotNull');
      imports.add('com.workos.common.http.addJoinedIfNotNull');
      imports.add('com.workos.common.http.addEach');
      lines.push(`    val params = mutableListOf<Pair<String, String>>()`);
      for (const qp of sortedQuery) for (const ln of emitQueryParam(qp, '    ')) lines.push(ln);
      if (groupsGoToQuery) {
        for (const group of op.parameterGroups ?? []) {
          for (const ln of emitGroupQueryDispatch(group, groupParamNames.get(group.name)!, '    ')) lines.push(ln);
        }
      }
      if (appendDefaultsAsQuery) {
        for (const [k, v] of Object.entries(defaults)) lines.push(`    params += ${ktLiteral(k)} to ${ktLiteral(v)}`);
        // Client-inferred fields may be nullable (e.g. clientId). Skip when
        // null rather than serializing "null" into the URL.
        for (const k of inferFromClient) {
          lines.push(`    workos.${clientFieldExpression(k)}?.let { params += ${ktLiteral(k)} to it }`);
        }
      }
    }

    if (hasBody) {
      // Use bodyOf() / patchBodyOf() helpers to build the request body in a
      // single expression. This drops null optional values automatically
      // instead of repeating `if (x != null) body["x"] = x` per field.
      const helperFn = isPatch ? 'patchBodyOf' : 'bodyOf';
      imports.add(`com.workos.common.http.${helperFn}`);
      const bodyEntries: string[] = [];
      for (const bf of sortedBodyFields) {
        const prop = bodyParamNames.get(bf.name)!;
        bodyEntries.push(`      ${ktLiteral(bf.name)} to ${prop}`);
      }
      for (const [k, v] of Object.entries(defaults)) {
        bodyEntries.push(`      ${ktLiteral(k)} to ${ktLiteral(v)}`);
      }
      for (const k of inferFromClient) {
        bodyEntries.push(`      ${ktLiteral(k)} to workos.${clientFieldExpression(k)}`);
      }
      if (bodyEntries.length > 0) {
        // ktlint: "A multiline expression should start on a new line"
        lines.push(`    val body =`);
        lines.push(`      ${helperFn}(`);
        for (let i = 0; i < bodyEntries.length; i++) {
          const sep = i === bodyEntries.length - 1 ? '' : ',';
          lines.push(`  ${bodyEntries[i]}${sep}`);
        }
        lines.push(`      )`);
      } else {
        // Empty body (POST/PUT/PATCH still require one for OkHttp).
        lines.push(`    val body = linkedMapOf<String, Any?>()`);
      }
      // Parameter group values go into the body for POST/PUT/PATCH so
      // sensitive fields (passwords, role slugs) never leak into the URL.
      if (hasGroups) {
        for (const group of op.parameterGroups ?? []) {
          for (const ln of emitGroupBodyDispatch(group, groupParamNames.get(group.name)!, '    ')) {
            lines.push(ln);
          }
        }
      }
      lines.push(`    val config =`);
      lines.push(`      RequestConfig(`);
      lines.push(`        method = ${ktLiteral(httpMethod)},`);
      lines.push(`        path = ${pathExpr},`);
      if (emitsQueryParams) lines.push(`        queryParams = params,`);
      lines.push(`        body = body,`);
      lines.push(`        requestOptions = requestOptions`);
      lines.push(`      )`);
    } else {
      lines.push(`    val config =`);
      lines.push(`      RequestConfig(`);
      lines.push(`        method = ${ktLiteral(httpMethod)},`);
      lines.push(`        path = ${pathExpr},`);
      if (emitsQueryParams) lines.push(`        queryParams = params,`);
      lines.push(`        requestOptions = requestOptions`);
      lines.push(`      )`);
    }

    if (plan.responseModelName && plan.isArrayResponse) {
      // `type: array` response — deserialize as List<T> via TypeReference.
      const itemClass = className(plan.responseModelName);
      imports.add('com.fasterxml.jackson.core.type.TypeReference');
      lines.push(`    val responseType = object : TypeReference<List<${itemClass}>>() {}`);
      lines.push(`    return workos.baseClient.request(config, responseType)`);
    } else if (plan.responseModelName) {
      const responseClass = className(plan.responseModelName);
      lines.push(`    return workos.baseClient.request(config, ${responseClass}::class.java)`);
    } else if (plan.isDelete || !plan.isModelResponse) {
      lines.push(`    workos.baseClient.requestVoid(config)`);
    } else {
      lines.push(`    workos.baseClient.requestVoid(config)`);
    }
  }

  lines.push('  }');
  appendSuspendVariantLines(lines, method, suspendParams, returnType, op.deprecated);

  // Java-friendly overloads: for each variant of every sealed-class parameter
  // group, emit an additional overload that accepts the variant's flat fields
  // directly (no `new ResourceTarget.ById(...)` boilerplate from Java).
  appendJavaFriendlyVariantOverloads(lines, {
    method,
    op,
    canonicalParams: suspendParams,
    groupParamNames,
    returnType,
    deprecated: op.deprecated,
  });

  return lines.join('\n');
}

interface JavaOverloadCtx {
  method: string;
  op: Operation;
  /**
   * The exact parameter declarations of the canonical method, in order. The
   * Java-friendly overload reuses these verbatim for non-variant params so
   * type/nullability/default exactly match the canonical method (avoiding
   * subtle drift like `Long?` vs `Int?` or `String?` vs `String`).
   */
  canonicalParams: SuspendParam[];
  groupParamNames: Map<string, string>;
  returnType: string;
  deprecated: boolean | undefined;
}

/**
 * For each variant of every sealed-class parameter group on `op`, append a
 * Java-discoverable overload that takes the variant's flat fields directly
 * and forwards to the canonical (sealed-class) method.
 *
 * Implementation scope: when an operation has multiple parameter groups, we
 * emit overloads for each variant of each group while keeping the *other*
 * groups' sealed-class params unchanged. This avoids combinatorial explosion
 * for ops with several groups while still flattening the common case.
 *
 * Method-name derivation handles the most common variant shapes (`ById`,
 * `ByExternalId`, etc.). Other shapes (e.g. `Plaintext`, `Imported`) are
 * skipped with a comment so unusual unions don't compile-fail the SDK; if
 * one becomes important we can add an explicit case here.
 */
function appendJavaFriendlyVariantOverloads(lines: string[], ctx: JavaOverloadCtx): void {
  const groups = ctx.op.parameterGroups ?? [];
  if (groups.length === 0) return;

  for (const group of groups) {
    for (const variant of group.variants) {
      const overloadMethodName = deriveOverloadMethodName(ctx.method, variant.name);
      if (overloadMethodName === null) {
        // Variant shape doesn't fit a clean Java-friendly method name; skip.
        // TODO: extend deriveOverloadMethodName for less-common shapes
        // (e.g. password variants) once we have a need for them.
        continue;
      }
      emitOneJavaOverload(lines, ctx, group, variant, overloadMethodName);
    }
  }
}

function deriveOverloadMethodName(baseMethod: string, variantName: string): string | null {
  const v = className(variantName);
  if (v === 'ById') return baseMethod;
  if (/^By[A-Z]/.test(v)) {
    // Don't double-stack a By-suffix: if the operation method already ends
    // with the variant suffix (case-insensitive), reuse it as-is. This keeps
    // names like `updateResourceByExternalId` from becoming
    // `updateResourceByExternalIdByExternalId`.
    if (baseMethod.toLowerCase().endsWith(v.toLowerCase())) {
      return baseMethod;
    }
    return `${baseMethod}${v}`;
  }
  return null;
}

function emitOneJavaOverload(
  lines: string[],
  ctx: JavaOverloadCtx,
  group: import('@workos/oagen').ParameterGroup,
  variant: import('@workos/oagen').ParameterGroup['variants'][number],
  overloadMethodName: string,
): void {
  const sealedName = sealedGroupName(group);
  const variantClass = className(variant.name);
  const targetGroupProp = ctx.groupParamNames.get(group.name)!;

  // Reuse the canonical method's exact parameter decls. We swap out only the
  // target group's slot (replacing the sealed param with variant fields) and
  // leave path/query/body params untouched so types/nullability/defaults
  // line up exactly with what the canonical method accepts.
  type ParamSpec = { decl: string; name: string };
  const decls: ParamSpec[] = [];

  // Track names already in use so variant field names that collide with
  // existing op params can be deterministically disambiguated.
  const existingNames = new Set<string>();
  for (const cp of ctx.canonicalParams) {
    if (cp.name !== targetGroupProp) existingNames.add(cp.name);
  }

  // Compute variant field decls (with collision-aware names). For a colliding
  // field, prefix it with the group's property name (e.g. `externalId` →
  // `parentResourceExternalId`) so the overload signature is unambiguous and
  // doesn't shadow the operation's own path/query/body params.
  const variantFieldDecls: ParamSpec[] = [];
  const variantArgPairs: { sealedField: string; localName: string }[] = [];
  const { parameters: variantParams, optionalNames } = orderedVariantParameters(variant);
  for (const p of variantParams) {
    const sealedField = deriveShortPropertyName(p.name, group.name);
    let localName = sealedField;
    if (existingNames.has(localName)) {
      const groupPrefix = propertyName(group.name);
      const camel = `${groupPrefix}${localName.charAt(0).toUpperCase()}${localName.slice(1)}`;
      localName = camel;
    }
    existingNames.add(localName);
    // A variant field is required unless the spec lists it in the variant's
    // `optionalParameters` — the sealed-class data class declares it
    // non-nullable in the former case and nullable-with-a-null-default in the
    // latter (see [generateSealedClass]). Mirror that here so the overload's
    // flat parameter types match the variant-constructor argument types
    // exactly.
    // Also: prefer the body model's field type via [bodyFieldTypes] when the
    // parameter-group IR has lost type fidelity. Inside this scope we don't
    // have bodyFieldTypes; the canonical method's type rendering for variant
    // fields hasn't been needed elsewhere, so fall back to p.type — which is
    // correct for non-body groups (path/query) and for body groups whose
    // types weren't degraded.
    const decl = renderParamNamed(localName, p.type, !optionalNames.has(p.name));
    variantFieldDecls.push({ decl, name: localName });
    variantArgPairs.push({ sealedField, localName });
  }

  // Walk canonical params; substitute the target group slot with the variant's
  // flat fields, copy everything else unchanged.
  for (const cp of ctx.canonicalParams) {
    if (cp.name === targetGroupProp) {
      for (const v of variantFieldDecls) decls.push(v);
    } else {
      decls.push({ decl: cp.decl, name: cp.name });
    }
  }

  const returnClause = ctx.returnType === 'Unit' ? '' : `: ${ctx.returnType}`;
  const variantArgs = variantArgPairs.map((p) => `${p.sealedField} = ${p.localName}`).join(', ');
  const sealedConstruct = `${sealedName}.${variantClass}(${variantArgs})`;

  // Build the call to the canonical method by walking canonical params again:
  // the target group slot is set to the inline-constructed variant; everything
  // else passes through by its canonical name.
  const forwardArgs: string[] = [];
  for (const cp of ctx.canonicalParams) {
    if (cp.name === targetGroupProp) {
      forwardArgs.push(`${cp.name} = ${sealedConstruct}`);
    } else {
      forwardArgs.push(`${cp.name} = ${cp.name}`);
    }
  }

  // KDoc.
  lines.push('');
  lines.push('  /**');
  lines.push(`   * Java-friendly overload — equivalent to`);
  lines.push(`   * \`${ctx.method}(${sealedName}.${variantClass}(...))\` from Kotlin.`);
  lines.push(`   *`);
  lines.push(`   * Accepts the discriminating fields directly so Java callers don't`);
  lines.push(`   * need to construct \`${sealedName}.${variantClass}\` explicitly.`);
  lines.push('   */');
  if (ctx.deprecated) lines.push('  @Deprecated("Deprecated operation")');
  // Note: no `@JvmOverloads` here. The synthetic Java overloads `@JvmOverloads`
  // generates (one per trailing optional, with the optional dropped) collide
  // with the canonical method's `@JvmOverloads` permutations whenever the
  // overload reuses the canonical method name (e.g. `ById` variants).
  // Java callers pay a small ergonomic cost — they must pass `null` for
  // optional trailing params (typically just `requestOptions`) — but the
  // overload's main purpose (no sealed-class construction) still applies.

  // Emit the function signature.
  if (decls.length === 1) {
    const single = decls[0].decl.replace(/^\s+/, '');
    lines.push(`  fun ${escapeReserved(overloadMethodName)}(${single})${returnClause} = ${ctx.method}(`);
  } else {
    lines.push(`  fun ${escapeReserved(overloadMethodName)}(`);
    for (let i = 0; i < decls.length; i++) {
      const sep = i === decls.length - 1 ? '' : ',';
      lines.push(`${decls[i].decl}${sep}`);
    }
    lines.push(`  )${returnClause} = ${ctx.method}(`);
  }
  for (let i = 0; i < forwardArgs.length; i++) {
    const sep = i === forwardArgs.length - 1 ? '' : ',';
    lines.push(`    ${forwardArgs[i]}${sep}`);
  }
  lines.push('  )');

  // Emit a coroutine-friendly suspend variant of the overload too.
  appendSuspendVariantLines(
    lines,
    overloadMethodName,
    decls.map((d) => ({ decl: d.decl, name: d.name })),
    ctx.returnType,
    ctx.deprecated,
  );
}

function appendSuspendVariantLines(
  lines: string[],
  method: string,
  suspendParams: SuspendParam[],
  returnType: string,
  deprecated: boolean | undefined,
): void {
  lines.push('');
  for (const ln of emitSuspendVariant({ methodName: method, params: suspendParams, returnType, deprecated })) {
    lines.push(ln);
  }
}

function resolveReturnType(plan: ReturnType<typeof planOperation>, imports: Set<string>, ctx?: EmitterContext): string {
  const itemName = plan.isPaginated
    ? (resolvePaginatedItemName(plan.paginatedItemModelName, ctx) ?? plan.paginatedItemModelName)
    : null;
  if (plan.isPaginated && itemName) {
    const item = className(itemName);
    imports.add(`com.workos.models.${item}`);
    return `Page<${item}>`;
  }
  if (plan.responseModelName && plan.isArrayResponse) {
    const cls = className(plan.responseModelName);
    imports.add(`com.workos.models.${cls}`);
    return `List<${cls}>`;
  }
  if (plan.responseModelName) {
    const cls = className(plan.responseModelName);
    imports.add(`com.workos.models.${cls}`);
    return cls;
  }
  return 'Unit';
}

/**
 * If [paginatedItemModelName] points to a list wrapper (`{ data, list_metadata }`),
 * unwrap it and return the actual item model name. Otherwise return as-is.
 * Delegates to the shared `unwrapListModel` so a model with a `data` array but
 * no `list_metadata` is not mistaken for a pagination envelope.
 */
function resolvePaginatedItemName(name: string | null, ctx?: EmitterContext): string | null {
  if (!name || !ctx) return name;
  const model = ctx.spec.models.find((m) => m.name === name);
  if (!model) return name;
  const modelMap = new Map(ctx.spec.models.map((m) => [m.name, m]));
  return unwrapListModel(model, modelMap)?.name ?? name;
}

function renderParam(name: string, type: TypeRef, required: boolean, forceInt = false): string {
  return renderParamNamed(propertyName(name), type, required, forceInt);
}

function renderParamNamed(kotlinName: string, type: TypeRef, required: boolean, forceInt = false): string {
  const mapped = forceInt ? (required ? 'Int' : 'Int?') : required ? mapTypeRef(type) : mapTypeRefOptional(type);
  return required ? `    ${kotlinName}: ${mapped}` : `    ${kotlinName}: ${mapped} = null`;
}

/**
 * Build the KDoc block preceding an SDK method.  Combines the operation's
 * summary/description with `@param` docs for every parameter that has a
 * description in the spec, `@return` when a response model is known, and
 * `@throws` for the standard error types.
 */
function buildMethodKdoc(
  op: Operation,
  pathParams: Parameter[],
  queryParams: Parameter[],
  bodyFields: Field[],
  bodyParamNames: Map<string, string>,
  plan: ReturnType<typeof planOperation>,
): string[] {
  // Use the operation's description as the KDoc body, split by newline.
  // Escape `*/` sequences to keep KDoc valid.
  const descriptionRaw = (op.description ?? '').trim();
  const textLines: string[] = [];
  if (descriptionRaw) {
    for (const l of descriptionRaw.split('\n')) textLines.push(escapeKdoc(l));
  }

  // @param lines. Use the Kotlin-visible parameter name (body collisions get
  // renamed, e.g. slug → bodySlug). Every parameter gets an `@param` line —
  // Dokka does not flag missing `@param` blocks (only fully undocumented
  // declarations), so we have to enforce coverage at emit time. Spec-provided
  // descriptions are preferred; missing descriptions get a templated fallback
  // derived from the parameter name. The fallback is intentionally a little
  // ugly — it nudges callers to add real descriptions to the spec.
  const paramDocs: string[] = [];
  const seenParamDocs = new Set<string>();
  const pushParamDoc = (
    name: string,
    sourceName: string,
    description: string | undefined,
    deprecated?: boolean,
    type?: TypeRef,
  ) => {
    if (seenParamDocs.has(name)) return;
    seenParamDocs.add(name);
    paramDocs.push(formatParamDoc(name, description, deprecated, sourceName, type));
  };
  for (const pp of pathParams) {
    pushParamDoc(propertyName(pp.name), pp.name, pp.description, pp.deprecated, pp.type);
  }
  for (const qp of queryParams) {
    pushParamDoc(propertyName(qp.name), qp.name, qp.description, qp.deprecated, qp.type);
  }
  for (const bf of bodyFields) {
    pushParamDoc(bodyParamNames.get(bf.name)!, bf.name, bf.description, bf.deprecated, bf.type);
  }
  // Always document the trailing `requestOptions` parameter with a stable,
  // canned phrasing so generated SDKs are consistent and Dokka's coverage
  // reporting has nothing to flag.
  pushParamDoc('requestOptions', 'request_options', REQUEST_OPTIONS_PARAM_DESCRIPTION);

  const returnDoc = plan.isPaginated
    ? '@return a [com.workos.common.http.Page] of results'
    : plan.responseModelName
      ? `@return the ${plan.isArrayResponse ? `list of ${className(plan.responseModelName)}` : className(plan.responseModelName)}`
      : null;

  const hasAnyContent = textLines.length > 0 || paramDocs.length > 0 || returnDoc !== null;
  if (!hasAnyContent) return [];

  const out: string[] = ['  /**'];
  for (const l of textLines) out.push(l ? `   * ${l}` : '   *');
  const hasBodyText = textLines.length > 0;
  const needsSpacer = hasBodyText && (paramDocs.length > 0 || returnDoc !== null);
  if (needsSpacer) out.push('   *');
  for (const p of paramDocs) out.push(`   * ${p}`);
  if (returnDoc) {
    if (paramDocs.length > 0) out.push('   *');
    out.push(`   * ${returnDoc}`);
  }
  out.push('   */');
  return out;
}

/**
 * Stable, canned description for the trailing `requestOptions` parameter that
 * every generated method exposes. Kept as a constant so the same phrasing
 * appears across resource methods, wrapper methods, and union-split helpers.
 */
const REQUEST_OPTIONS_PARAM_DESCRIPTION = 'per-request overrides (idempotency key, API key, headers, timeout)';

function formatParamDoc(
  kotlinName: string,
  description: string | undefined,
  deprecated?: boolean,
  sourceName?: string,
  type?: TypeRef,
): string {
  const firstLine = description?.split('\n').find((l) => l.trim()) ?? '';
  const specText = firstLine.trim();
  const deprecationNote = deprecated ? '**Deprecated.**' : '';
  // Fall back to a templated description derived from the parameter name when
  // the spec didn't provide one. Dokka has no `-Xdoclint:missing` analogue,
  // so emitting a placeholder is the only way to guarantee `@param` coverage.
  const fallback = `the ${humanize(sourceName ?? kotlinName)} of the request.`;
  let text = specText || fallback;
  // For long enum-typed parameter descriptions (notably PaginationOrder),
  // replace the verbose per-method copy with a short summary that defers to
  // the enum's own KDoc — see [maybeShortenEnumParamDescription].
  const shortened = maybeShortenEnumParamDescription(type, text);
  if (shortened) text = shortened.description;
  const parts = [deprecationNote, text].filter(Boolean).join(' ');
  return `@param ${kotlinName} ${escapeKdoc(parts)}`;
}

/**
 * Unwrap a possibly-nullable type to check if the inner type is an array,
 * and return the array's item type for downstream serialization decisions.
 */
function unwrapArray(t: TypeRef): TypeRef | null {
  if (t.kind === 'array') return t.items;
  if (t.kind === 'nullable' && t.inner.kind === 'array') return t.inner.items;
  return null;
}

/**
 * Serialize a single value expression for a query parameter.  For enums we
 * use `.value` so the wire name is used; for strings the value is already
 * the right type; for everything else `.toString()`.
 */
function valueExprForQuery(type: TypeRef): string {
  const inner = type.kind === 'nullable' ? type.inner : type;
  if (inner.kind === 'enum') return 'it.value';
  if (inner.kind === 'primitive' && inner.type === 'string') {
    return inner.format === 'date-time' ? 'it.toString()' : 'it';
  }
  return 'it.toString()';
}

function emitQueryParam(p: Parameter, indent: string, receiverMode = false): string[] {
  const prop = propertyName(p.name);
  const rendered = queryParamToString(p.type, prop);
  const inner = p.type.kind === 'nullable' ? p.type.inner : p.type;
  const arrayItem = unwrapArray(p.type);
  // In receiver-lambda mode (`requestPage { ... }`) the surrounding closure is
  // an extension on `MutableList<Pair<String, String>>`, so we elide the
  // explicit `params.` qualifier (extension functions resolve via implicit
  // receiver) and route `+=` through `add(pair)` to keep ktlint happy.
  const callPrefix = receiverMode ? '' : 'params.';
  const addPair = (pair: string) => (receiverMode ? `add(${pair})` : `params += ${pair}`);
  if (arrayItem) {
    // Honor `style: form, explode: false` → comma-joined. Default (explode:true
    // or unspecified for form) → repeated keys.  `p.explode ?? true` matches
    // the OpenAPI default for query parameters when `style` is form.
    const explode = p.explode ?? true;
    const itemExpr = valueExprForQuery(arrayItem);
    // `it` is the loop variable in the trivial mapping case — `xs.map { it }`
    // is the identity function, so emit the collection directly when the per-
    // item expression doesn't transform the value.
    const isIdentity = itemExpr === 'it';
    if (!explode) {
      if (p.required) {
        const arg = isIdentity ? prop : `${prop}.map { ${itemExpr} }`;
        return [`${indent}${callPrefix}addJoinedIfNotNull(${ktLiteral(p.name)}, ${arg})`];
      }
      const arg = isIdentity ? prop : `${prop}?.map { ${itemExpr} }`;
      return [`${indent}${callPrefix}addJoinedIfNotNull(${ktLiteral(p.name)}, ${arg})`];
    }
    if (p.required) {
      const arg = isIdentity ? prop : `${prop}.map { ${itemExpr} }`;
      return [`${indent}${callPrefix}addEach(${ktLiteral(p.name)}, ${arg})`];
    }
    if (isIdentity) {
      return [`${indent}${prop}?.let { ${callPrefix}addEach(${ktLiteral(p.name)}, it) }`];
    }
    return [`${indent}${prop}?.let { ${callPrefix}addEach(${ktLiteral(p.name)}, it.map { ${itemExpr} }) }`];
  }
  if (p.required) return [`${indent}${addPair(`${ktLiteral(p.name)} to ${rendered}`)}`];
  if (inner.kind === 'primitive' && inner.type === 'string' && inner.format !== 'date-time') {
    return [`${indent}${callPrefix}addIfNotNull(${ktLiteral(p.name)}, ${prop})`];
  }
  return [`${indent}${prop}?.let { ${addPair(`${ktLiteral(p.name)} to ${queryParamToString(inner, 'it')}`)} }`];
}

function queryParamToString(type: TypeRef, varName: string): string {
  if (type.kind === 'enum') return `${varName}.value`;
  if (type.kind === 'nullable') return queryParamToString(type.inner, varName);
  // Plain `string` is already the wire type. ISO-8601 strings get promoted to
  // `OffsetDateTime`, so we need an explicit `.toString()` to serialize them
  // as the spec-required ISO-8601 representation.
  if (type.kind === 'primitive' && type.type === 'string') {
    return type.format === 'date-time' ? `${varName}.toString()` : varName;
  }
  return `${varName}.toString()`;
}

function _emitBodyField(field: Field, kotlinParamName: string, isPatch: boolean): string[] {
  const prop = kotlinParamName;
  if (field.required) return [`    body[${ktLiteral(field.name)}] = ${prop}`];
  // PATCH: PatchField<T> — serialize Present(value) including explicit null;
  // skip Absent entirely so the server preserves the field's current value.
  if (isPatch) {
    return [`    if (${prop} is PatchField.Present) body[${ktLiteral(field.name)}] = ${prop}.value`];
  }
  return [`    if (${prop} != null) body[${ktLiteral(field.name)}] = ${prop}`];
}

function pickNamedQueryParam(sorted: Parameter[], name: string): string {
  const match = sorted.find((p) => p.name === name);
  return match ? propertyName(match.name) : 'null';
}

function generateAuthenticateHelper(): string[] {
  return [
    '  private fun authenticate(',
    '    grantType: String,',
    '    requestOptions: RequestOptions?,',
    '    vararg entries: Pair<String, Any?>',
    '  ): AuthenticateResponse {',
    '    val body =',
    '      bodyOf(',
    '        *entries,',
    '        "grant_type" to grantType,',
    '        "client_id" to workos.clientId,',
    '        "client_secret" to workos.apiKey',
    '      )',
    '    val config =',
    '      RequestConfig(',
    '        method = "POST",',
    '        path = "/user_management/authenticate",',
    '        body = body,',
    '        requestOptions = requestOptions',
    '      )',
    '    return workos.baseClient.request(config, AuthenticateResponse::class.java)',
    '  }',
  ];
}

function resolveBodyModel(op: Operation, ctx: EmitterContext): Model | null {
  const body = op.requestBody;
  if (!body) return null;
  if (body.kind !== 'model') return null;
  return ctx.spec.models.find((m) => m.name === body.name) ?? null;
}

function registerTypeImports(ref: TypeRef, imports: Set<string>, ctx: EmitterContext): void {
  const mapped = mapTypeRef(ref);
  for (const imp of implicitImportsFor(mapped)) imports.add(imp);

  // Match the model-emission gate: a `ListMetadata`-shape model that survives
  // emission (because a non-paginated wrapper still references it) needs its
  // import here too.
  const nonPaginatedRefs = collectNonPaginatedResponseModelNames(ctx.spec.services);
  const listMetadataNeeded = collectReferencedListMetadataModels(ctx.spec.models, nonPaginatedRefs);

  walk(ref, (r) => {
    if (r.kind === 'enum') {
      // When an enum is aliased, import the canonical class instead of the alias.
      const canonicalName = enumCanonicalMap.get(r.name) ?? r.name;
      imports.add(`com.workos.types.${className(canonicalName)}`);
    }
    if (r.kind === 'model') {
      const referenced = ctx.spec.models.find((m) => m.name === r.name);
      if (referenced) {
        const skipWrapper = isListWrapperModel(referenced) && !nonPaginatedRefs.has(referenced.name);
        const skipMetadata = isListMetadataModel(referenced) && !listMetadataNeeded.has(referenced.name);
        if (skipWrapper || skipMetadata) return;
      }
      imports.add(`com.workos.models.${className(r.name)}`);
    }
  });
}

function walk(ref: TypeRef, fn: (r: TypeRef) => void): void {
  fn(ref);
  if (ref.kind === 'array') walk(ref.items, fn);
  else if (ref.kind === 'map') walk(ref.valueType, fn);
  else if (ref.kind === 'nullable') walk(ref.inner, fn);
  else if (ref.kind === 'union') for (const v of ref.variants) walk(v, fn);
}

/** Sort operation path parameters by their first appearance in the URL template. */
export function sortPathParamsByTemplateOrder(op: Operation): Parameter[] {
  return [...op.pathParams].sort((a, b) => {
    const posA = op.path.indexOf(`{${a.name}}`);
    const posB = op.path.indexOf(`{${b.name}}`);
    return posA - posB;
  });
}

function escapeKdoc(s: string): string {
  return s.replace(/\*\//g, '*\u200b/');
}

// ---------------------------------------------------------------------------
// Mutually-exclusive parameter group support
// ---------------------------------------------------------------------------

/**
 * Derive a short Kotlin property name for a parameter within a variant,
 * stripping the group name prefix to avoid stuttering.
 */
function deriveShortPropertyName(paramName: string, groupName: string): string {
  const prefix = groupName + '_';
  const stripped = paramName.startsWith(prefix) ? paramName.slice(prefix.length) : paramName;
  return propertyName(stripped);
}

/**
 * A variant's parameters in constructor order — required members first, then
 * the ones named in `optionalParameters` — plus the optional name set.
 *
 * Optional members are emitted as nullable properties with a `= null` default,
 * so they have to trail the non-defaulted ones: Kotlin permits the reverse, but
 * it makes the positional Java constructor (and the flat Java overloads) unusable
 * without naming every argument. When `optionalParameters` is absent or empty
 * both filters preserve IR order, so output is unchanged for variants whose
 * members are all required.
 */
export function orderedVariantParameters(variant: import('@workos/oagen').ParameterGroupVariant): {
  parameters: Parameter[];
  optionalNames: Set<string>;
} {
  const optionalNames = new Set(variant.optionalParameters ?? []);
  return {
    parameters: [
      ...variant.parameters.filter((p) => !optionalNames.has(p.name)),
      ...variant.parameters.filter((p) => optionalNames.has(p.name)),
    ],
    optionalNames,
  };
}

/**
 * Generate sealed class definitions for all parameter groups in an operation.
 *
 * [bodyFieldTypes] is a fallback map from wire field name → TypeRef built from
 * the body model. When the oagen core resolves parameter group variants it
 * sometimes loses array/object types, falling back to a primitive string.
 * Cross-referencing the body model corrects that.
 */
function generateSealedClass(
  group: import('@workos/oagen').ParameterGroup,
  bodyFieldTypes?: Map<string, TypeRef>,
): string[] {
  const lines: string[] = [];
  const sealedName = sealedGroupName(group);

  // KDoc with Kotlin + Java construction examples. Pick the first variant as
  // a worked example so callers see the variant constructor in both languages
  // without us having to enumerate every shape.
  const example = group.variants[0];
  if (example) {
    const exampleVariant = className(example.name);
    const exampleParams = orderedVariantParameters(example).parameters;
    const exampleArgs = exampleParams.map((p) => `${deriveShortPropertyName(p.name, group.name)} = "..."`).join(', ');
    lines.push('/**');
    lines.push(` * Mutually exclusive ${humanize(group.name)} parameter variants.`);
    lines.push(' *');
    lines.push(' * Usage from Kotlin:');
    lines.push(' * ```kotlin');
    lines.push(` * val target: ${sealedName} = ${sealedName}.${exampleVariant}(${exampleArgs})`);
    lines.push(' * ```');
    lines.push(' *');
    lines.push(' * Usage from Java:');
    lines.push(' * ```java');
    lines.push(
      ` * ${sealedName} target = new ${sealedName}.${exampleVariant}(${exampleParams.map(() => '"..."').join(', ')});`,
    );
    lines.push(' * ```');
    lines.push(' *');
    lines.push(
      ` * Java callers may also use the per-variant overloads on the surrounding API class to skip variant construction entirely.`,
    );
    lines.push(' */');
  } else {
    lines.push(`/** Mutually exclusive ${humanize(group.name)} parameter variants. */`);
  }
  lines.push(`sealed class ${sealedName} {`);
  for (let vi = 0; vi < group.variants.length; vi++) {
    const variant = group.variants[vi];
    const variantName = className(variant.name);
    const { parameters, optionalNames } = orderedVariantParameters(variant);
    const fields = parameters.map((p) => {
      const prop = deriveShortPropertyName(p.name, group.name);
      // Prefer the body model's field type when available — the IR parameter
      // group may have lost array/object type info for body fields.
      const effectiveType = bodyFieldTypes?.get(p.name) ?? p.type;
      // Members the spec marks optional for this variant may be omitted by the
      // caller, so they are nullable with a null default.
      const decl = optionalNames.has(p.name)
        ? `val ${prop}: ${mapTypeRefOptional(effectiveType)} = null`
        : `val ${prop}: ${mapTypeRef(effectiveType)}`;
      return { decl, name: p.name };
    });
    // ktlint requires blank line before each declaration inside a sealed class
    if (vi > 0) lines.push('');
    // ktlint class-signature rule requires multi-line constructors
    lines.push(`  /** Variant: ${humanize(variant.name)}. */`);
    lines.push(`  data class ${variantName}(`);
    for (let i = 0; i < fields.length; i++) {
      const comma = i < fields.length - 1 ? ',' : '';
      lines.push(`    /** The ${humanize(fields[i].name)}. */`);
      lines.push(`    ${fields[i].decl}${comma}`);
    }
    lines.push(`  ) : ${sealedName}()`);
  }
  lines.push('}');
  lines.push('');
  return lines;
}

/** Emit `when` dispatch that serializes a parameter group into query params. */
function emitGroupQueryDispatch(
  group: import('@workos/oagen').ParameterGroup,
  prop: string,
  indent: string,
  receiverMode = false,
): string[] {
  const sealedName = sealedGroupName(group);
  const lines: string[] = [];

  if (group.optional) {
    lines.push(`${indent}if (${prop} != null) {`);
    emitWhenBlock(lines, group, sealedName, prop, `${indent}  `, receiverMode);
    lines.push(`${indent}}`);
  } else {
    emitWhenBlock(lines, group, sealedName, prop, indent, receiverMode);
  }
  return lines;
}

function assignGroupParameterNames(op: Operation, occupiedNames: Set<string>): Map<string, string> {
  const names = new Map<string, string>();
  for (const group of op.parameterGroups ?? []) {
    const natural = propertyName(sealedGroupName(group));
    const assigned = reserveUniqueGroupParameterName(natural, occupiedNames);
    names.set(group.name, assigned);
  }
  return names;
}

function reserveUniqueGroupParameterName(base: string, occupiedNames: Set<string>): string {
  if (!occupiedNames.has(base)) {
    occupiedNames.add(base);
    return base;
  }

  const capitalized = `${base.charAt(0).toUpperCase()}${base.slice(1)}`;
  const prefixed = `group${capitalized}`;
  if (!occupiedNames.has(prefixed)) {
    occupiedNames.add(prefixed);
    return prefixed;
  }

  let index = 2;
  while (occupiedNames.has(`${prefixed}${index}`)) index += 1;
  const fallback = `${prefixed}${index}`;
  occupiedNames.add(fallback);
  return fallback;
}

function emitWhenBlock(
  lines: string[],
  group: import('@workos/oagen').ParameterGroup,
  sealedName: string,
  prop: string,
  indent: string,
  receiverMode = false,
): void {
  lines.push(`${indent}when (${prop}) {`);
  for (const variant of group.variants) {
    const variantName = className(variant.name);
    const { parameters, optionalNames } = orderedVariantParameters(variant);
    const entries = parameters.map((p) => {
      const fieldProp = deriveShortPropertyName(p.name, group.name);
      if (optionalNames.has(p.name)) {
        // Optional members drop out of the query string when unset rather than
        // serializing as the literal "null".
        const guarded = `${ktLiteral(p.name)} to it`;
        const add = receiverMode ? `add(${guarded})` : `params += ${guarded}`;
        return `${prop}.${fieldProp}?.let { ${add} }`;
      }
      const pair = `${ktLiteral(p.name)} to ${prop}.${fieldProp}`;
      return receiverMode ? `add(${pair})` : `params += ${pair}`;
    });
    if (entries.length === 1) {
      lines.push(`${indent}  is ${sealedName}.${variantName} -> ${entries[0]}`);
    } else {
      lines.push(`${indent}  is ${sealedName}.${variantName} -> {`);
      for (const e of entries) lines.push(`${indent}    ${e}`);
      lines.push(`${indent}  }`);
    }
  }
  lines.push(`${indent}}`);
}

/** Emit `when` dispatch that serializes a parameter group into the request body map. */
function emitGroupBodyDispatch(group: import('@workos/oagen').ParameterGroup, prop: string, indent: string): string[] {
  const sealedName = sealedGroupName(group);
  const lines: string[] = [];

  if (group.optional) {
    lines.push(`${indent}if (${prop} != null) {`);
    emitBodyWhenBlock(lines, group, sealedName, prop, `${indent}  `);
    lines.push(`${indent}}`);
  } else {
    emitBodyWhenBlock(lines, group, sealedName, prop, indent);
  }
  return lines;
}

function sealedGroupName(group: import('@workos/oagen').ParameterGroup): string {
  // groupTypeBaseName, not group.name: where two operations' declarations of one
  // group diverge, oagen qualifies the base name so each gets its own sealed
  // type instead of both collapsing onto one that fits only one of them.
  const resolved = className(groupTypeBaseName(group));
  if (resolved === 'Password') return 'CreateUserPassword';
  if (resolved === 'Role') return 'CreateUserRole';
  return resolved;
}

function emitBodyWhenBlock(
  lines: string[],
  group: import('@workos/oagen').ParameterGroup,
  sealedName: string,
  prop: string,
  indent: string,
): void {
  lines.push(`${indent}when (${prop}) {`);
  for (const variant of group.variants) {
    const variantName = className(variant.name);
    const { parameters, optionalNames } = orderedVariantParameters(variant);
    const entries = parameters.map((p) => {
      const fieldProp = deriveShortPropertyName(p.name, group.name);
      // Optional members are omitted from the body when unset — `bodyOf` only
      // drops nulls for the fields it builds, not for these later writes.
      if (optionalNames.has(p.name)) {
        return `${prop}.${fieldProp}?.let { body[${ktLiteral(p.name)}] = it }`;
      }
      return `body[${ktLiteral(p.name)}] = ${prop}.${fieldProp}`;
    });
    if (entries.length === 1) {
      lines.push(`${indent}  is ${sealedName}.${variantName} -> ${entries[0]}`);
    } else {
      lines.push(`${indent}  is ${sealedName}.${variantName} -> {`);
      for (const e of entries) lines.push(`${indent}    ${e}`);
      lines.push(`${indent}  }`);
    }
  }
  lines.push(`${indent}}`);
}

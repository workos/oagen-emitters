import type { ApiSpec, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import {
  fileName,
  serviceDirName,
  servicePropertyName,
  resolveInterfaceName,
  resolveServiceName,
  buildServiceNameMap,
  wireInterfaceName,
} from './naming.js';
import { assignModelsToServices, docComment } from './utils.js';

export function generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  files.push(generateWorkOSClient(spec, ctx));
  files.push(generateBarrel(spec, ctx));
  files.push(generatePackageJson(ctx));
  files.push(generateTsConfig());

  return files;
}

function generateWorkOSClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile {
  const lines: string[] = [];

  // Service imports
  for (const service of spec.services) {
    const resolvedName = resolveServiceName(service, ctx);
    const serviceDir = serviceDirName(resolvedName);
    lines.push(`import { ${resolvedName} } from './${serviceDir}/${fileName(resolvedName)}';`);
  }

  lines.push("import type { WorkOSOptions } from './common/interfaces/workos-options.interface';");
  lines.push("import type { PostOptions } from './common/interfaces/post-options.interface';");
  lines.push("import type { GetOptions } from './common/interfaces/get-options.interface';");
  lines.push("import { NoApiKeyProvidedException } from './common/exceptions/no-api-key-provided.exception';");
  lines.push("import { UnauthorizedException } from './common/exceptions/unauthorized.exception';");
  lines.push("import { NotFoundException } from './common/exceptions/not-found.exception';");
  lines.push("import { ConflictException } from './common/exceptions/conflict.exception';");
  lines.push("import { UnprocessableEntityException } from './common/exceptions/unprocessable-entity.exception';");
  lines.push("import { RateLimitExceededException } from './common/exceptions/rate-limit-exceeded.exception';");
  lines.push("import { GenericServerException } from './common/exceptions/generic-server.exception';");
  lines.push("import { BadRequestException } from './common/exceptions/bad-request.exception';");

  lines.push('');
  if (spec.description) {
    lines.push(...docComment(spec.description));
  }
  lines.push('export class WorkOS {');
  lines.push('  readonly baseURL: string;');
  lines.push('  readonly key: string;');
  lines.push('  private readonly options: WorkOSOptions;');
  lines.push('');

  // Resource accessors
  for (const service of spec.services) {
    const resolvedName = resolveServiceName(service, ctx);
    const propName = servicePropertyName(resolvedName);
    lines.push(`  readonly ${propName} = new ${resolvedName}(this);`);
  }

  lines.push('');
  lines.push('  constructor(keyOrOptions?: string | WorkOSOptions, maybeOptions?: WorkOSOptions) {');
  lines.push("    if (typeof keyOrOptions === 'object') {");
  lines.push("      this.key = keyOrOptions.apiKey ?? '';");
  lines.push('      this.options = keyOrOptions;');
  lines.push('    } else {');
  lines.push("      this.key = keyOrOptions ?? '';");
  lines.push('      this.options = maybeOptions ?? {};');
  lines.push('    }');
  lines.push('');
  lines.push('    if (!this.key) {');
  lines.push("      const envKey = typeof process !== 'undefined' ? process.env?.WORKOS_API_KEY : undefined;");
  lines.push('      if (envKey) this.key = envKey;');
  lines.push('    }');
  lines.push('');
  lines.push("    const protocol = this.options.https === false ? 'http' : 'https';");
  lines.push("    const hostname = this.options.apiHostname ?? 'api.workos.com';");
  lines.push("    const port = this.options.port ? `:${this.options.port}` : '';");
  lines.push('    this.baseURL = `${protocol}://${hostname}${port}`;');
  lines.push('  }');

  // HTTP methods
  lines.push('');
  lines.push('  async get<Result = any>(path: string, options: GetOptions = {}): Promise<{ data: Result }> {');
  lines.push('    this.ensureApiKey(options);');
  lines.push('    const url = this.buildUrl(path, options.query);');
  lines.push('    const response = await fetch(url, {');
  lines.push("      method: 'GET',");
  lines.push('      headers: this.buildHeaders(options),');
  lines.push('    });');
  lines.push('    await this.handleHttpError(response, path);');
  lines.push('    const data = await response.json() as Result;');
  lines.push('    return { data };');
  lines.push('  }');

  lines.push('');
  lines.push(
    '  async post<Result = any, Entity = any>(path: string, entity: Entity, options: PostOptions = {}): Promise<{ data: Result }> {',
  );
  lines.push('    this.ensureApiKey(options);');
  lines.push('    const url = this.buildUrl(path, options.query);');
  lines.push('    const response = await fetch(url, {');
  lines.push("      method: 'POST',");
  lines.push('      headers: this.buildHeaders(options),');
  lines.push('      body: JSON.stringify(entity),');
  lines.push('    });');
  lines.push('    await this.handleHttpError(response, path);');
  lines.push('    const data = await response.json() as Result;');
  lines.push('    return { data };');
  lines.push('  }');

  lines.push('');
  lines.push(
    '  async put<Result = any, Entity = any>(path: string, entity: Entity, options: PostOptions = {}): Promise<{ data: Result }> {',
  );
  lines.push('    this.ensureApiKey(options);');
  lines.push('    const url = this.buildUrl(path, options.query);');
  lines.push('    const response = await fetch(url, {');
  lines.push("      method: 'PUT',");
  lines.push('      headers: this.buildHeaders(options),');
  lines.push('      body: JSON.stringify(entity),');
  lines.push('    });');
  lines.push('    await this.handleHttpError(response, path);');
  lines.push('    const data = await response.json() as Result;');
  lines.push('    return { data };');
  lines.push('  }');

  lines.push('');
  lines.push(
    '  async patch<Result = any, Entity = any>(path: string, entity: Entity, options: PostOptions = {}): Promise<{ data: Result }> {',
  );
  lines.push('    this.ensureApiKey(options);');
  lines.push('    const url = this.buildUrl(path, options.query);');
  lines.push('    const response = await fetch(url, {');
  lines.push("      method: 'PATCH',");
  lines.push('      headers: this.buildHeaders(options),');
  lines.push('      body: JSON.stringify(entity),');
  lines.push('    });');
  lines.push('    await this.handleHttpError(response, path);');
  lines.push('    const data = await response.json() as Result;');
  lines.push('    return { data };');
  lines.push('  }');

  lines.push('');
  lines.push('  async delete(path: string, options: GetOptions = {}): Promise<void> {');
  lines.push('    this.ensureApiKey(options);');
  lines.push('    const url = this.buildUrl(path);');
  lines.push('    const response = await fetch(url, {');
  lines.push("      method: 'DELETE',");
  lines.push('      headers: this.buildHeaders(options),');
  lines.push('    });');
  lines.push('    await this.handleHttpError(response, path);');
  lines.push('  }');

  // Private helpers
  lines.push('');
  lines.push('  private buildUrl(path: string, query?: Record<string, any>): string {');
  lines.push('    const url = new URL(path, this.baseURL);');
  lines.push('    if (query) {');
  lines.push('      for (const [key, value] of Object.entries(query)) {');
  lines.push("        if (value !== null && value !== undefined && value !== '') {");
  lines.push('          url.searchParams.set(key, String(value));');
  lines.push('        }');
  lines.push('      }');
  lines.push('    }');
  lines.push('    return url.toString();');
  lines.push('  }');

  lines.push('');
  lines.push('  private buildHeaders(options: any = {}): Record<string, string> {');
  lines.push('    const headers: Record<string, string> = {');
  lines.push("      'Content-Type': 'application/json',");
  lines.push(`      Authorization: \`Bearer \${this.key}\`,`);
  lines.push('    };');
  lines.push("    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;");
  lines.push("    if (options.warrantToken) headers['Warrant-Token'] = options.warrantToken;");
  lines.push('    return headers;');
  lines.push('  }');

  lines.push('');
  lines.push('  private ensureApiKey(options: any = {}): void {');
  lines.push('    if (!this.key && !options.skipApiKeyCheck) {');
  lines.push('      throw new NoApiKeyProvidedException();');
  lines.push('    }');
  lines.push('  }');

  lines.push('');
  lines.push('  private async handleHttpError(response: Response, path: string): Promise<void> {');
  lines.push('    if (response.ok) return;');
  lines.push('');
  lines.push("    const requestID = response.headers.get('x-request-id') ?? '';");
  lines.push('    let data: any = {};');
  lines.push('    try { data = await response.json(); } catch {}');
  lines.push('    const { message, code, errors } = data;');
  lines.push('');
  lines.push('    switch (response.status) {');
  lines.push('      case 400: throw new BadRequestException({ code, message, requestID });');
  lines.push('      case 401: throw new UnauthorizedException(requestID);');
  lines.push('      case 404: throw new NotFoundException({ code, message, path, requestID });');
  lines.push('      case 409: throw new ConflictException({ message, requestID });');
  lines.push('      case 422: throw new UnprocessableEntityException({ code, errors, message, requestID });');
  lines.push('      case 429: {');
  lines.push("        const retryAfter = Number(response.headers.get('retry-after')) || undefined;");
  lines.push("        throw new RateLimitExceededException(message ?? 'Too many requests', requestID, retryAfter);");
  lines.push('      }');
  lines.push("      default: throw new GenericServerException(response.status, message ?? 'Server error', requestID);");
  lines.push('    }');
  lines.push('  }');

  lines.push('}');

  return { path: 'src/workos.ts', content: lines.join('\n'), skipIfExists: true, integrateTarget: false };
}

// Names exported from common utilities that must not be re-exported from model interfaces
const RESERVED_BARREL_NAMES = new Set(['List', 'ListResponse', 'ListMetadata', 'AutoPaginatable', 'PaginationOptions']);

function generateBarrel(spec: ApiSpec, ctx: EmitterContext): GeneratedFile {
  const lines: string[] = [];
  const modelToService = assignModelsToServices(spec.models, spec.services);
  const serviceNameMap = buildServiceNameMap(spec.services, ctx);
  const resolveDir = (irService: string | undefined) =>
    irService ? serviceDirName(serviceNameMap.get(irService) ?? irService) : 'common';

  // Common exports
  lines.push("export * from './common/exceptions';");
  lines.push("export { AutoPaginatable } from './common/utils/pagination';");
  lines.push("export type { List, ListMetadata, ListResponse } from './common/utils/pagination';");
  lines.push("export type { PaginationOptions } from './common/interfaces/pagination-options.interface';");
  lines.push("export type { WorkOSOptions } from './common/interfaces/workos-options.interface';");
  lines.push("export type { PostOptions } from './common/interfaces/post-options.interface';");
  lines.push("export type { GetOptions } from './common/interfaces/get-options.interface';");
  lines.push('');

  // Per-service exports: interfaces + resource class
  for (const service of spec.services) {
    const resolvedName = resolveServiceName(service, ctx);
    const serviceDir = serviceDirName(resolvedName);

    // Collect models that belong to this service, skipping reserved names
    const serviceModels = spec.models.filter((m) => modelToService.get(m.name) === service.name);
    for (const model of serviceModels) {
      const name = resolveInterfaceName(model.name, ctx);
      const wireName = wireInterfaceName(name);
      if (RESERVED_BARREL_NAMES.has(name) || RESERVED_BARREL_NAMES.has(wireName)) continue;
      lines.push(
        `export type { ${name}, ${wireName} } from './${serviceDir}/interfaces/${fileName(model.name)}.interface';`,
      );
    }

    // Resource class
    lines.push(`export { ${resolvedName} } from './${serviceDir}/${fileName(resolvedName)}';`);
    lines.push('');
  }

  // Unassigned models (common), skipping reserved names
  const unassignedModels = spec.models.filter((m) => !modelToService.has(m.name));
  for (const model of unassignedModels) {
    const name = resolveInterfaceName(model.name, ctx);
    const wireName = wireInterfaceName(name);
    if (RESERVED_BARREL_NAMES.has(name) || RESERVED_BARREL_NAMES.has(wireName)) continue;
    lines.push(`export type { ${name}, ${wireName} } from './common/interfaces/${fileName(model.name)}.interface';`);
  }

  // Enum exports
  for (const enumDef of spec.enums) {
    // Find which service directory the enum landed in
    const enumService = findEnumService(enumDef.name, spec.services);
    const dir = resolveDir(enumService);
    lines.push(`export type { ${enumDef.name} } from './${dir}/interfaces/${fileName(enumDef.name)}.interface';`);
  }

  lines.push('');
  lines.push("export { WorkOS } from './workos';");

  return { path: 'src/index.ts', content: lines.join('\n'), skipIfExists: true };
}

function findEnumService(enumName: string, services: Service[]): string | undefined {
  for (const service of services) {
    for (const op of service.operations) {
      const refs: string[] = [];
      const collect = (ref: any) => {
        if (ref?.kind === 'enum' && ref.name === enumName) refs.push(ref.name);
        if (ref?.items) collect(ref.items);
        if (ref?.inner) collect(ref.inner);
        if (ref?.variants) ref.variants.forEach(collect);
        if (ref?.valueType) collect(ref.valueType);
      };
      if (op.requestBody) collect(op.requestBody);
      collect(op.response);
      for (const p of [...op.pathParams, ...op.queryParams]) {
        collect(p.type);
      }
      if (refs.length > 0) return service.name;
    }
  }
  return undefined;
}

function generatePackageJson(ctx: EmitterContext): GeneratedFile {
  const pkg = {
    name: `@${ctx.namespace}/sdk`,
    version: '0.0.0',
    type: 'module',
    main: 'src/index.ts',
    types: 'src/index.ts',
    exports: {
      '.': './src/index.ts',
    },
    scripts: {
      test: 'jest',
      build: 'tsc',
    },
    devDependencies: {
      typescript: '^5.0.0',
      jest: '^29.0.0',
      'jest-fetch-mock': '^3.0.0',
      '@types/jest': '^29.0.0',
      'ts-jest': '^29.0.0',
    },
  };

  return {
    path: 'package.json',
    content: JSON.stringify(pkg, null, 2),
    skipIfExists: true,
    integrateTarget: false,
  };
}

function generateTsConfig(): GeneratedFile {
  const config = {
    compilerOptions: {
      target: 'ES2020',
      module: 'CommonJS',
      lib: ['ES2020'],
      declaration: true,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      outDir: './lib',
      rootDir: './src',
    },
    include: ['src/**/*'],
    exclude: ['node_modules', 'lib', '**/*.spec.ts'],
  };

  return {
    path: 'tsconfig.json',
    content: JSON.stringify(config, null, 2),
    skipIfExists: true,
    integrateTarget: false,
  };
}

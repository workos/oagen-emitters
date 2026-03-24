import type { ApiSpec, AuthScheme, EmitterContext, GeneratedFile, Service } from '@workos/oagen';
import {
  fileName,
  serviceDirName,
  servicePropertyName,
  resolveInterfaceName,
  resolveServiceName,
  wireInterfaceName,
} from './naming.js';
import { docComment, createServiceDirResolver } from './utils.js';

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

  // Only import WorkOSBase for fresh generation (no existing WorkOS class).
  // When integrating into an existing SDK, the existing WorkOS already has its
  // own base class and the WorkOSBase file may not exist.
  const hasExistingWorkOS = !!ctx.apiSurface?.classes?.['WorkOS'];
  if (!hasExistingWorkOS) {
    lines.push("import { WorkOSBase } from './common/workos-base';");
  }

  // Service imports
  for (const service of spec.services) {
    const resolvedName = resolveServiceName(service, ctx);
    const serviceDir = serviceDirName(resolvedName);
    lines.push(`import { ${resolvedName} } from './${serviceDir}/${fileName(resolvedName)}';`);
  }

  lines.push('');
  if (spec.description) {
    lines.push(...docComment(spec.description));
  }
  const extendsClause = hasExistingWorkOS ? '' : ' extends WorkOSBase';
  lines.push(`export class WorkOS${extendsClause} {`);

  // Server URL constants from spec.servers
  if (spec.servers && spec.servers.length > 0) {
    for (const server of spec.servers) {
      const constName = serverConstName(server.description ?? server.url);
      if (server.description) {
        lines.push(...docComment(server.description, 2));
      }
      lines.push(`  static readonly ${constName} = '${server.url}';`);
    }
    lines.push('');
  }

  // Resource accessors — skip services whose property already exists
  // in the baseline WorkOS class (e.g., `portal` covers AdminPortal,
  // `mfa` covers MultiFactorAuth).
  const existingProps = new Set<string>();
  const baselineWorkOS = ctx.apiSurface?.classes?.['WorkOS'] ?? ctx.apiSurface?.classes?.['WorkOSNode'];
  if (baselineWorkOS?.properties) {
    for (const name of Object.keys(baselineWorkOS.properties)) {
      existingProps.add(name);
    }
  }
  for (const service of spec.services) {
    const resolvedName = resolveServiceName(service, ctx);
    const propName = servicePropertyName(resolvedName);
    if (existingProps.has(propName)) continue;
    lines.push(`  readonly ${propName} = new ${resolvedName}(this);`);
  }

  // Auth override — only emit when auth is non-default (not bearer)
  if (needsAuthOverride(spec.auth)) {
    lines.push('');
    lines.push('  protected override setAuthHeaders(headers: Record<string, string>): void {');
    renderAuthOverride(lines, spec.auth!);
    lines.push('  }');
  }

  lines.push('}');

  return { path: 'src/workos.ts', content: lines.join('\n'), skipIfExists: true };
}

function generateBarrel(spec: ApiSpec, ctx: EmitterContext): GeneratedFile {
  const lines: string[] = [];
  const { modelToService, resolveDir } = createServiceDirResolver(spec.models, spec.services, ctx);

  // Track all exported names to prevent duplicates.
  // Pre-seed with names already exported by the existing SDK to avoid generating
  // duplicate exports that would conflict with existing `export *` statements.
  const exportedNames = new Set<string>();
  if (ctx.apiSurface?.interfaces) {
    for (const name of Object.keys(ctx.apiSurface.interfaces)) {
      exportedNames.add(name);
    }
  }
  if (ctx.apiSurface?.classes) {
    for (const name of Object.keys(ctx.apiSurface.classes)) {
      exportedNames.add(name);
    }
  }

  // Common exports
  lines.push("export * from './common/exceptions';");
  lines.push("export { AutoPaginatable } from './common/utils/pagination';");
  lines.push("export type { List, ListMetadata, ListResponse } from './common/utils/pagination';");
  lines.push("export type { PaginationOptions } from './common/interfaces/pagination-options.interface';");
  lines.push("export type { WorkOSOptions } from './common/interfaces/workos-options.interface';");
  lines.push("export type { PostOptions } from './common/interfaces/post-options.interface';");
  lines.push("export type { GetOptions } from './common/interfaces/get-options.interface';");
  lines.push('');
  for (const name of [
    'AutoPaginatable',
    'List',
    'ListMetadata',
    'ListResponse',
    'PaginationOptions',
    'WorkOSOptions',
    'PostOptions',
    'GetOptions',
  ]) {
    exportedNames.add(name);
  }

  // Per-service exports: interfaces + resource class
  for (const service of spec.services) {
    const resolvedName = resolveServiceName(service, ctx);
    const serviceDir = serviceDirName(resolvedName);

    // Collect models that belong to this service, skipping already-exported names
    const serviceModels = spec.models.filter((m) => modelToService.get(m.name) === service.name);
    for (const model of serviceModels) {
      const name = resolveInterfaceName(model.name, ctx);
      const wireName = wireInterfaceName(name);
      if (exportedNames.has(name) || exportedNames.has(wireName)) continue;
      exportedNames.add(name);
      exportedNames.add(wireName);
      lines.push(
        `export type { ${name}, ${wireName} } from './${serviceDir}/interfaces/${fileName(model.name)}.interface';`,
      );
    }

    // Resource class — skip if already exported
    if (!exportedNames.has(resolvedName)) {
      exportedNames.add(resolvedName);
      lines.push(`export { ${resolvedName} } from './${serviceDir}/${fileName(resolvedName)}';`);
    }
    lines.push('');
  }

  // Unassigned models (common), skipping already-exported names
  const unassignedModels = spec.models.filter((m) => !modelToService.has(m.name));
  for (const model of unassignedModels) {
    const name = resolveInterfaceName(model.name, ctx);
    const wireName = wireInterfaceName(name);
    if (exportedNames.has(name) || exportedNames.has(wireName)) continue;
    exportedNames.add(name);
    exportedNames.add(wireName);
    lines.push(`export type { ${name}, ${wireName} } from './common/interfaces/${fileName(model.name)}.interface';`);
  }

  // Enum exports — skip duplicates
  for (const enumDef of spec.enums) {
    if (exportedNames.has(enumDef.name)) continue;
    exportedNames.add(enumDef.name);
    const enumService = findEnumService(enumDef.name, spec.services);
    const dir = resolveDir(enumService);
    lines.push(`export type { ${enumDef.name} } from './${dir}/interfaces/${fileName(enumDef.name)}.interface';`);
  }

  lines.push('');
  // Only emit the WorkOS re-export for standalone generation (no existing SDK).
  // When integrating into an existing SDK, the existing barrel already exports
  // WorkOS (often as a subclass alias like `export { WorkOSNode as WorkOS }`),
  // and adding a second export with the same name causes a duplicate identifier error.
  if (!ctx.apiSurface && !exportedNames.has('WorkOS')) {
    exportedNames.add('WorkOS');
    lines.push("export { WorkOS } from './workos';");
  }

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

/**
 * Determine whether the spec's auth scheme requires overriding the
 * default bearer auth in WorkOSBase.setAuthHeaders().
 */
function needsAuthOverride(auth?: AuthScheme[]): boolean {
  if (!auth || auth.length === 0) return false;
  const scheme = auth[0];
  // bearer and oauth2 match the base class default — no override needed
  return scheme.kind === 'apiKey';
}

/**
 * Render the body of a setAuthHeaders override for non-default auth schemes.
 * Only called when needsAuthOverride() returns true.
 */
function renderAuthOverride(lines: string[], auth: AuthScheme[]): void {
  const scheme = auth[0];
  if (scheme.kind !== 'apiKey') return;
  switch (scheme.in) {
    case 'header':
      lines.push(`    headers['${scheme.name}'] = this.key;`);
      break;
    case 'query':
      lines.push(`    // Auth key sent as query parameter '${scheme.name}' (see buildUrl)`);
      break;
    case 'cookie':
      lines.push(`    headers['Cookie'] = \`${scheme.name}=\${this.key}\`;`);
      break;
  }
}

/**
 * Convert a server description or URL into a SCREAMING_SNAKE_CASE constant name.
 */
function serverConstName(description: string): string {
  return (
    'SERVER_' +
    description
      .replace(/https?:\/\//g, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .toUpperCase()
  );
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

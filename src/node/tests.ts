import type { ApiSpec, Service, Operation, EmitterContext, GeneratedFile } from "@workos/oagen";
import { planOperation, toCamelCase } from "@workos/oagen";
import {
  fileName,
  serviceDirName,
  servicePropertyName,
  resolveMethodName,
  resolveClassName,
} from "./naming.js";
import { generateFixtures } from "./fixtures.js";

export function generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // Generate fixture JSON files
  const fixtures = generateFixtures(spec);
  for (const f of fixtures) {
    files.push({ path: f.path, content: f.content, headerPlacement: "skip" });
  }

  // Generate test files per service
  for (const service of spec.services) {
    files.push(generateServiceTest(service, spec, ctx));
  }

  return files;
}

function generateServiceTest(service: Service, spec: ApiSpec, ctx: EmitterContext): GeneratedFile {
  const serviceDir = serviceDirName(service.name);
  const serviceClass = resolveClassName(service, ctx);
  const serviceProp = servicePropertyName(service.name);
  const testPath = `src/${serviceDir}/${fileName(service.name)}.spec.ts`;

  const lines: string[] = [];

  lines.push("import fetch from 'jest-fetch-mock';");
  lines.push("import {");
  lines.push("  fetchOnce,");
  lines.push("  fetchURL,");
  lines.push("  fetchSearchParams,");
  lines.push("  fetchBody,");
  lines.push("} from '../common/utils/test-utils';");
  lines.push("import { WorkOS } from '../workos';");
  lines.push("");

  // Import fixtures
  const fixtureImports = new Set<string>();
  for (const op of service.operations) {
    const plan = planOperation(op);
    if (plan.isPaginated && op.pagination) {
      const itemModelName =
        op.pagination.itemType.kind === "model" ? op.pagination.itemType.name : null;
      if (itemModelName) {
        fixtureImports.add(
          `import list${itemModelName}Fixture from './fixtures/list-${fileName(itemModelName)}.fixture.json';`,
        );
      }
    } else if (plan.responseModelName) {
      fixtureImports.add(
        `import ${toCamelCase(plan.responseModelName)}Fixture from './fixtures/${fileName(plan.responseModelName)}.fixture.json';`,
      );
    }
  }
  for (const imp of fixtureImports) {
    lines.push(imp);
  }

  lines.push("");
  lines.push("const workos = new WorkOS('sk_test_Sz3IQjepeSWaI4cMS4ms4sMuU');");
  lines.push("");
  lines.push(`describe('${serviceClass}', () => {`);
  lines.push("  beforeEach(() => fetch.resetMocks());");

  for (const op of service.operations) {
    const plan = planOperation(op);
    const method = resolveMethodName(op, service, ctx);

    lines.push("");
    lines.push(`  describe('${method}', () => {`);

    if (plan.isPaginated) {
      renderPaginatedTest(lines, op, plan, method, serviceProp);
    } else if (plan.isDelete) {
      renderDeleteTest(lines, op, method, serviceProp);
    } else if (plan.hasBody && plan.responseModelName) {
      renderBodyTest(lines, op, plan, method, serviceProp);
    } else if (plan.responseModelName) {
      renderGetTest(lines, op, plan, method, serviceProp);
    } else {
      renderVoidTest(lines, op, method, serviceProp);
    }

    lines.push("  });");
  }

  lines.push("});");

  return { path: testPath, content: lines.join("\n"), skipIfExists: true };
}

function renderPaginatedTest(
  lines: string[],
  op: Operation,
  plan: any,
  method: string,
  serviceProp: string,
): void {
  const itemModelName =
    op.pagination?.itemType.kind === "model" ? op.pagination.itemType.name : "Item";

  lines.push("    it('returns paginated results', async () => {");
  lines.push(`      fetchOnce(list${itemModelName}Fixture);`);
  lines.push("");
  lines.push(`      const { data, listMetadata } = await workos.${serviceProp}.${method}();`);
  lines.push("");
  lines.push(`      expect(fetchURL()).toContain('${op.path.split("{")[0]}');`);
  lines.push("      expect(fetchSearchParams()).toHaveProperty('order');");
  lines.push("      expect(Array.isArray(data)).toBe(true);");
  lines.push("      expect(listMetadata).toBeDefined();");
  lines.push("    });");
}

function renderDeleteTest(
  lines: string[],
  op: Operation,
  method: string,
  serviceProp: string,
): void {
  const hasPathParam = op.pathParams.length > 0;
  const args = hasPathParam ? "'test_id'" : "";

  lines.push("    it('sends a DELETE request', async () => {");
  lines.push("      fetchOnce({}, { status: 204 });");
  lines.push("");
  lines.push(`      await workos.${serviceProp}.${method}(${args});`);
  lines.push("");
  lines.push(`      expect(fetchURL()).toContain('${op.path.split("{")[0]}');`);
  lines.push("    });");
}

function renderBodyTest(
  lines: string[],
  op: Operation,
  plan: any,
  method: string,
  serviceProp: string,
): void {
  const responseModelName = plan.responseModelName!;
  const fixture = `${toCamelCase(responseModelName)}Fixture`;
  const hasPathParam = op.pathParams.length > 0;
  const pathArg = hasPathParam ? "'test_id', " : "";

  lines.push("    it('sends the correct request and returns result', async () => {");
  lines.push(`      fetchOnce(${fixture});`);
  lines.push("");
  lines.push(`      const result = await workos.${serviceProp}.${method}(${pathArg}{});`);
  lines.push("");
  lines.push(`      expect(fetchURL()).toContain('${op.path.split("{")[0]}');`);
  lines.push("      expect(result).toBeDefined();");
  lines.push("    });");
}

function renderGetTest(
  lines: string[],
  op: Operation,
  plan: any,
  method: string,
  serviceProp: string,
): void {
  const responseModelName = plan.responseModelName!;
  const fixture = `${toCamelCase(responseModelName)}Fixture`;
  const hasPathParam = op.pathParams.length > 0;
  const args = hasPathParam ? "'test_id'" : "";

  lines.push("    it('returns the expected result', async () => {");
  lines.push(`      fetchOnce(${fixture});`);
  lines.push("");
  lines.push(`      const result = await workos.${serviceProp}.${method}(${args});`);
  lines.push("");
  lines.push(`      expect(fetchURL()).toContain('${op.path.split("{")[0]}');`);
  lines.push("      expect(result).toBeDefined();");
  lines.push("    });");
}

function renderVoidTest(lines: string[], op: Operation, method: string, serviceProp: string): void {
  const hasPathParam = op.pathParams.length > 0;
  const args = hasPathParam ? "'test_id'" : "";

  lines.push("    it('sends the request', async () => {");
  lines.push("      fetchOnce({});");
  lines.push("");
  lines.push(`      await workos.${serviceProp}.${method}(${args});`);
  lines.push("");
  lines.push(`      expect(fetchURL()).toContain('${op.path.split("{")[0]}');`);
  lines.push("    });");
}

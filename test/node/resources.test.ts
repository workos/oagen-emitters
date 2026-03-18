import { describe, it, expect } from "vitest";
import { generateResources } from "../../src/node/resources.js";
import type { EmitterContext, ApiSpec, Service } from "@workos/oagen";

const emptySpec: ApiSpec = {
  name: "Test",
  version: "1.0.0",
  baseUrl: "",
  services: [],
  models: [],
  enums: [],
};

const ctx: EmitterContext = {
  namespace: "workos",
  namespacePascal: "WorkOS",
  spec: emptySpec,
  irVersion: 6,
};

describe("generateResources", () => {
  it("returns empty for no services", () => {
    expect(generateResources([], ctx)).toEqual([]);
  });

  it("generates a resource class with GET method", () => {
    const services: Service[] = [
      {
        name: "Organizations",
        operations: [
          {
            name: "getOrganization",
            httpMethod: "get",
            path: "/organizations/{id}",
            pathParams: [
              {
                name: "id",
                type: { kind: "primitive", type: "string" },
                required: true,
              },
            ],
            queryParams: [],
            headerParams: [],
            response: { kind: "model", name: "Organization" },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    expect(files.length).toBe(1);
    expect(files[0].path).toBe("src/organizations/organizations.ts");

    const content = files[0].content;
    expect(content).toContain("export class Organizations {");
    expect(content).toContain("constructor(private readonly workos: WorkOS) {}");
    expect(content).toContain("async getOrganization(id: string): Promise<Organization>");
    expect(content).toContain("deserializeOrganization(data)");
  });

  it("generates paginated list method", () => {
    const services: Service[] = [
      {
        name: "Organizations",
        operations: [
          {
            name: "listOrganizations",
            httpMethod: "get",
            path: "/organizations",
            pathParams: [],
            queryParams: [
              {
                name: "domains",
                type: { kind: "array", items: { kind: "primitive", type: "string" } },
                required: false,
              },
            ],
            headerParams: [],
            response: { kind: "model", name: "Organization" },
            errors: [],
            pagination: {
              cursorParam: "after",
              dataPath: "data",
              itemType: { kind: "model", name: "Organization" },
            },
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;

    // Should have AutoPaginatable imports
    expect(content).toContain("import { AutoPaginatable }");
    expect(content).toContain("import { fetchAndDeserialize }");

    // Should generate options interface
    expect(content).toContain(
      "export interface ListOrganizationsOptions extends PaginationOptions {",
    );
    expect(content).toContain("domains?: string[];");

    // Should return AutoPaginatable
    expect(content).toContain("Promise<AutoPaginatable<Organization, ListOrganizationsOptions>>");
  });

  it("generates DELETE method returning void", () => {
    const services: Service[] = [
      {
        name: "Organizations",
        operations: [
          {
            name: "deleteOrganization",
            httpMethod: "delete",
            path: "/organizations/{id}",
            pathParams: [
              {
                name: "id",
                type: { kind: "primitive", type: "string" },
                required: true,
              },
            ],
            queryParams: [],
            headerParams: [],
            response: { kind: "primitive", type: "unknown" },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;
    expect(content).toContain("async deleteOrganization(id: string): Promise<void>");
    expect(content).toContain("await this.workos.delete(");
  });

  it("generates POST method with body and idempotency", () => {
    const services: Service[] = [
      {
        name: "Organizations",
        operations: [
          {
            name: "createOrganization",
            httpMethod: "post",
            path: "/organizations",
            pathParams: [],
            queryParams: [],
            headerParams: [],
            requestBody: { kind: "model", name: "CreateOrganizationInput" },
            response: { kind: "model", name: "Organization" },
            errors: [],
            injectIdempotencyKey: true,
          },
        ],
      },
    ];

    const files = generateResources(services, ctx);
    const content = files[0].content;
    expect(content).toContain(
      "async createOrganization(payload: CreateOrganizationInput, requestOptions: PostOptions = {}): Promise<Organization>",
    );
    expect(content).toContain("serializeCreateOrganizationInput(payload)");
    expect(content).toContain("requestOptions,");
  });
});

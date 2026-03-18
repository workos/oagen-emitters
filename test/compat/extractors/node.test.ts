import { describe, it, expect } from "vitest";
import { nodeExtractor } from "../../../src/compat/extractors/node.js";
import { resolve } from "node:path";

const fixturePath = resolve(__dirname, "../../fixtures/sample-sdk-node");

describe("nodeExtractor", () => {
  it("extracts classes with methods and properties", async () => {
    const surface = await nodeExtractor.extract(fixturePath);

    expect(surface.classes).toHaveProperty("WorkOSClient");
    const client = surface.classes["WorkOSClient"];

    expect(client.methods).toHaveProperty("getOrganization");
    expect(client.methods).toHaveProperty("listOrganizations");
    expect(client.methods).toHaveProperty("deleteOrganization");

    expect(client.properties).toHaveProperty("baseURL");
    expect(client.properties["baseURL"].readonly).toBe(true);
  });

  it("extracts method params and return types", async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    const client = surface.classes["WorkOSClient"];

    const getOrg = client.methods["getOrganization"][0];
    expect(getOrg.params).toMatchObject([{ name: "id", type: "string", optional: false }]);
    expect(getOrg.returnType).toBe("Promise<Organization>");
    expect(getOrg.async).toBe(true);
  });

  it("extracts optional params", async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    const client = surface.classes["WorkOSClient"];

    const listOrgs = client.methods["listOrganizations"][0];
    expect(listOrgs.params).toMatchObject([
      { name: "limit", type: "number | undefined", optional: true },
    ]);
  });

  it("extracts delete method returning void", async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    const client = surface.classes["WorkOSClient"];

    const deleteOrg = client.methods["deleteOrganization"][0];
    expect(deleteOrg.returnType).toBe("Promise<void>");
  });

  it("extracts constructor params", async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    const client = surface.classes["WorkOSClient"];

    expect(client.constructorParams).toMatchObject([
      { name: "options", type: "WorkOSOptions", optional: false },
    ]);
  });

  it("extracts interfaces with fields", async () => {
    const surface = await nodeExtractor.extract(fixturePath);

    expect(surface.interfaces).toHaveProperty("Organization");
    const org = surface.interfaces["Organization"];
    expect(org.fields).toHaveProperty("id");
    expect(org.fields).toHaveProperty("name");
    expect(org.fields).toHaveProperty("createdAt");
    expect(org.fields["id"].type).toBe("string");
  });

  it("extracts wire response interface", async () => {
    const surface = await nodeExtractor.extract(fixturePath);

    expect(surface.interfaces).toHaveProperty("OrganizationResponse");
    const resp = surface.interfaces["OrganizationResponse"];
    expect(resp.fields).toHaveProperty("created_at");
  });

  it("extracts interfaces with optional fields", async () => {
    const surface = await nodeExtractor.extract(fixturePath);

    expect(surface.interfaces).toHaveProperty("WorkOSOptions");
    const opts = surface.interfaces["WorkOSOptions"];
    expect(opts.fields["apiKey"].optional).toBe(false);
    expect(opts.fields["baseUrl"].optional).toBe(true);
  });

  it("extracts generic interfaces", async () => {
    const surface = await nodeExtractor.extract(fixturePath);

    expect(surface.interfaces).toHaveProperty("ListResponse");
    const listResp = surface.interfaces["ListResponse"];
    expect(listResp.fields).toHaveProperty("data");
    expect(listResp.fields).toHaveProperty("hasMore");
  });

  it("extracts type aliases", async () => {
    const surface = await nodeExtractor.extract(fixturePath);

    expect(surface.typeAliases).toHaveProperty("StatusType");
    expect(surface.typeAliases["StatusType"].value).toMatchInlineSnapshot(
      `""active" | "inactive""`,
    );
  });

  it("extracts enums", async () => {
    const surface = await nodeExtractor.extract(fixturePath);

    expect(surface.enums).toHaveProperty("Status");
    expect(surface.enums["Status"].members).toMatchObject({
      Active: "active",
      Inactive: "inactive",
    });
  });

  it("builds export map", async () => {
    const surface = await nodeExtractor.extract(fixturePath);

    // Entry point should list all exported symbols
    const entryExports = Object.values(surface.exports).flat();
    expect(entryExports).toContain("WorkOSClient");
    expect(entryExports).toContain("Organization");
    expect(entryExports).toContain("Status");
    expect(entryExports).toContain("StatusType");
  });

  it("sets metadata correctly", async () => {
    const surface = await nodeExtractor.extract(fixturePath);

    expect(surface.language).toBe("node");
    expect(surface.extractedFrom).toBe(fixturePath);
    expect(surface.extractedAt).toBeTruthy();
  });

  it("produces deterministic output", async () => {
    const surface1 = await nodeExtractor.extract(fixturePath);
    const surface2 = await nodeExtractor.extract(fixturePath);

    // Normalize timestamps for comparison
    surface1.extractedAt = "";
    surface2.extractedAt = "";

    expect(JSON.stringify(surface1)).toBe(JSON.stringify(surface2));
  });

  it("does not extract private members", async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    const client = surface.classes["WorkOSClient"];

    expect(client.properties).not.toHaveProperty("apiKey");
  });
});

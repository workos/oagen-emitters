import { describe, it, expect } from "vitest";
import { mapTypeRef, mapWireTypeRef } from "../../src/node/type-map.js";
import type { TypeRef } from "@workos/oagen";

describe("mapTypeRef", () => {
  it("maps primitive string", () => {
    const ref: TypeRef = { kind: "primitive", type: "string" };
    expect(mapTypeRef(ref)).toBe("string");
  });

  it("maps primitive integer to number", () => {
    const ref: TypeRef = { kind: "primitive", type: "integer" };
    expect(mapTypeRef(ref)).toBe("number");
  });

  it("maps primitive boolean", () => {
    const ref: TypeRef = { kind: "primitive", type: "boolean" };
    expect(mapTypeRef(ref)).toBe("boolean");
  });

  it("maps unknown to any", () => {
    const ref: TypeRef = { kind: "primitive", type: "unknown" };
    expect(mapTypeRef(ref)).toBe("any");
  });

  it("maps array of strings", () => {
    const ref: TypeRef = {
      kind: "array",
      items: { kind: "primitive", type: "string" },
    };
    expect(mapTypeRef(ref)).toBe("string[]");
  });

  it("maps model reference", () => {
    const ref: TypeRef = { kind: "model", name: "Organization" };
    expect(mapTypeRef(ref)).toBe("Organization");
  });

  it("maps enum reference", () => {
    const ref: TypeRef = { kind: "enum", name: "Status" };
    expect(mapTypeRef(ref)).toBe("Status");
  });

  it("maps nullable type", () => {
    const ref: TypeRef = {
      kind: "nullable",
      inner: { kind: "primitive", type: "string" },
    };
    expect(mapTypeRef(ref)).toBe("string | null");
  });

  it("maps union type", () => {
    const ref: TypeRef = {
      kind: "union",
      variants: [
        { kind: "primitive", type: "string" },
        { kind: "primitive", type: "number" },
      ],
    };
    expect(mapTypeRef(ref)).toBe("string | number");
  });

  it("maps map type", () => {
    const ref: TypeRef = {
      kind: "map",
      valueType: { kind: "primitive", type: "string" },
    };
    expect(mapTypeRef(ref)).toBe("Record<string, string>");
  });

  it("maps literal string", () => {
    const ref: TypeRef = { kind: "literal", value: "organization" };
    expect(mapTypeRef(ref)).toBe("'organization'");
  });

  it("maps literal number", () => {
    const ref: TypeRef = { kind: "literal", value: 42 };
    expect(mapTypeRef(ref)).toBe("42");
  });

  it("parenthesizes union in array", () => {
    const ref: TypeRef = {
      kind: "array",
      items: {
        kind: "union",
        variants: [
          { kind: "primitive", type: "string" },
          { kind: "primitive", type: "number" },
        ],
      },
    };
    expect(mapTypeRef(ref)).toBe("(string | number)[]");
  });
});

describe("mapWireTypeRef", () => {
  it("maps model reference with Response suffix", () => {
    const ref: TypeRef = { kind: "model", name: "Organization" };
    expect(mapWireTypeRef(ref)).toBe("OrganizationResponse");
  });

  it("maps array of models with Response suffix", () => {
    const ref: TypeRef = {
      kind: "array",
      items: { kind: "model", name: "OrganizationDomain" },
    };
    expect(mapWireTypeRef(ref)).toBe("OrganizationDomainResponse[]");
  });

  it("keeps primitives unchanged", () => {
    const ref: TypeRef = { kind: "primitive", type: "string" };
    expect(mapWireTypeRef(ref)).toBe("string");
  });

  it("keeps enum references unchanged", () => {
    const ref: TypeRef = { kind: "enum", name: "Status" };
    expect(mapWireTypeRef(ref)).toBe("Status");
  });

  it("maps nullable model with Response suffix", () => {
    const ref: TypeRef = {
      kind: "nullable",
      inner: { kind: "model", name: "Organization" },
    };
    expect(mapWireTypeRef(ref)).toBe("OrganizationResponse | null");
  });
});

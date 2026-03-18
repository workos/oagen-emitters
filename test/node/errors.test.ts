import { describe, it, expect } from "vitest";
import { generateErrors } from "../../src/node/errors.js";
import type { EmitterContext, ApiSpec } from "@workos/oagen";

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

describe("generateErrors", () => {
  it("generates all exception classes", () => {
    const files = generateErrors(ctx);

    const names = files.map((f) => f.path);
    expect(names).toContain("src/common/exceptions/bad-request.exception.ts");
    expect(names).toContain("src/common/exceptions/unauthorized.exception.ts");
    expect(names).toContain("src/common/exceptions/not-found.exception.ts");
    expect(names).toContain("src/common/exceptions/conflict.exception.ts");
    expect(names).toContain("src/common/exceptions/unprocessable-entity.exception.ts");
    expect(names).toContain("src/common/exceptions/rate-limit-exceeded.exception.ts");
    expect(names).toContain("src/common/exceptions/generic-server.exception.ts");
    expect(names).toContain("src/common/exceptions/no-api-key-provided.exception.ts");
    expect(names).toContain("src/common/exceptions/index.ts");
  });

  it("generates NotFoundException with correct status", () => {
    const files = generateErrors(ctx);
    const notFoundFile = files.find((f) => f.path.includes("not-found.exception.ts"))!;

    expect(notFoundFile.content).toContain("export class NotFoundException extends Error");
    expect(notFoundFile.content).toContain("readonly status = 404;");
    expect(notFoundFile.content).toContain("requestID: string");
  });

  it("generates RateLimitExceededException with retryAfter", () => {
    const files = generateErrors(ctx);
    const rateLimitFile = files.find((f) => f.path.includes("rate-limit-exceeded.exception.ts"))!;

    expect(rateLimitFile.content).toContain(
      "export class RateLimitExceededException extends Error",
    );
    expect(rateLimitFile.content).toContain("readonly status = 429;");
    expect(rateLimitFile.content).toContain("retryAfter?: number");
  });

  it("generates exception barrel with all exports", () => {
    const files = generateErrors(ctx);
    const barrel = files.find((f) => f.path === "src/common/exceptions/index.ts")!;

    expect(barrel.content).toContain("export { BadRequestException }");
    expect(barrel.content).toContain("export { UnauthorizedException }");
    expect(barrel.content).toContain("export { NotFoundException }");
    expect(barrel.content).toContain("export { RateLimitExceededException }");
    expect(barrel.content).toContain("export { NoApiKeyProvidedException }");
  });
});

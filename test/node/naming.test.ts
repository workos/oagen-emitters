import { describe, it, expect } from "vitest";
import {
  className,
  fileName,
  methodName,
  fieldName,
  wireFieldName,
  serviceDirName,
  servicePropertyName,
} from "../../src/node/naming.js";

describe("naming", () => {
  describe("className", () => {
    it("converts to PascalCase", () => {
      expect(className("organizations")).toBe("Organizations");
      expect(className("user_management")).toBe("UserManagement");
      expect(className("api_keys")).toBe("ApiKeys");
    });
  });

  describe("fileName", () => {
    it("converts to kebab-case", () => {
      expect(fileName("Organization")).toBe("organization");
      expect(fileName("OrganizationDomain")).toBe("organization-domain");
      expect(fileName("UserManagement")).toBe("user-management");
    });
  });

  describe("methodName", () => {
    it("converts to camelCase", () => {
      expect(methodName("list_organizations")).toBe("listOrganizations");
      expect(methodName("create_organization")).toBe("createOrganization");
      expect(methodName("get_organization")).toBe("getOrganization");
    });
  });

  describe("fieldName", () => {
    it("converts to camelCase", () => {
      expect(fieldName("allow_profiles_outside_organization")).toBe(
        "allowProfilesOutsideOrganization",
      );
      expect(fieldName("stripe_customer_id")).toBe("stripeCustomerId");
      expect(fieldName("id")).toBe("id");
    });
  });

  describe("wireFieldName", () => {
    it("converts to snake_case", () => {
      expect(wireFieldName("allowProfilesOutsideOrganization")).toBe(
        "allow_profiles_outside_organization",
      );
      expect(wireFieldName("id")).toBe("id");
      expect(wireFieldName("created_at")).toBe("created_at");
    });
  });

  describe("serviceDirName", () => {
    it("converts to kebab-case", () => {
      expect(serviceDirName("Organizations")).toBe("organizations");
      expect(serviceDirName("UserManagement")).toBe("user-management");
      expect(serviceDirName("ApiKeys")).toBe("api-keys");
    });
  });

  describe("servicePropertyName", () => {
    it("converts to camelCase", () => {
      expect(servicePropertyName("Organizations")).toBe("organizations");
      expect(servicePropertyName("UserManagement")).toBe("userManagement");
      expect(servicePropertyName("ApiKeys")).toBe("apiKeys");
    });
  });
});

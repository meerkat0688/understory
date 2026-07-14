import { describe, expect, it } from "vitest";
import { loadSecurityConfig } from "../src/security.js";

describe("security configuration", () => {
  it("defaults to loopback and no cross-origin allowlist", () => {
    const config = loadSecurityConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.corsOrigins.size).toBe(0);
  });

  it("requires authentication for non-loopback exposure", () => {
    expect(() => loadSecurityConfig({ HOST: "0.0.0.0" })).toThrow(/API_BEARER_TOKEN/);
    expect(loadSecurityConfig({ HOST: "0.0.0.0", API_BEARER_TOKEN: "secret" }).token).toBe("secret");
  });

  it("parses only explicitly configured CORS origins", () => {
    const config = loadSecurityConfig({ CORS_ORIGINS: "https://one.example, https://two.example" });
    expect([...config.corsOrigins]).toEqual(["https://one.example", "https://two.example"]);
  });
});

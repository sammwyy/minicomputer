import { describe, expect, test } from "bun:test";
import { loadConfig, normalizePolicy } from "../src/config.ts";

describe("configuration", () => {
  test("rejects weak secrets", () => expect(() => loadConfig({ MINICOMPUTER_JWT_SECRET: "short" })).toThrow());
  test("normalizes policy capabilities", () => expect(normalizePolicy({ portForward: true, scopes: ["ports", "invalid"] as never })).toEqual({ portForward: true, allowSubdomains: false, scopes: ["ports"] }));
});

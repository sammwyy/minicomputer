import { describe, expect, test } from "bun:test";
import { signHs256, verifyJwt, requireScope } from "../src/auth.ts";
import type { Scope } from "../src/types.ts";

const secret = "auth-test-secret";
const future = () => Math.floor(Date.now() / 1000) + 60;

describe("JWT authentication", () => {
  test("round trips HS256 claims", async () => {
    const claims = { sub: "admin", scopes: ["stats"] as Scope[], exp: future(), iss: "issuer", aud: "audience" };
    await expect(verifyJwt(signHs256(claims, secret), secret, { issuer: "issuer", audience: "audience" })).resolves.toMatchObject(claims);
  });

  test("rejects malformed, forged, expired, issuer and audience-invalid tokens", async () => {
    await expect(verifyJwt("not-a-token", secret)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(verifyJwt(signHs256({ sub: "admin", exp: future() }, "other-secret"), secret)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(verifyJwt(signHs256({ sub: "admin", exp: Math.floor(Date.now() / 1000) - 1 }, secret), secret)).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
    await expect(verifyJwt(signHs256({ sub: "admin", exp: future(), iss: "wrong" }, secret), secret, { issuer: "issuer" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(verifyJwt(signHs256({ sub: "admin", exp: future(), aud: "wrong" }, secret), secret, { audience: "audience" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  test("allows admins and enforces delegated scopes", () => {
    expect(() => requireScope({ sub: "admin" }, "ports")).not.toThrow();
    expect(() => requireScope({ sub: "container:id", scopes: ["stats"] }, "stats")).not.toThrow();
    expect(() => requireScope({ sub: "container:id", scopes: ["stats"] }, "ports")).toThrow();
  });
});

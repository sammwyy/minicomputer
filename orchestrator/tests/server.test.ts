import { describe, expect, test } from "bun:test";
import { signHs256 } from "../src/auth.ts";
import { MockBackend } from "../src/backends/mock.ts";
import { ContainerRegistry } from "../src/registry.ts";
import { createServer } from "../src/server.ts";

const secret = "test-secret";
function setup() { const registry = new ContainerRegistry(new MockBackend()); return { registry, fetch: createServer(registry, { secret }) }; }
function auth() { return { authorization: `Bearer ${signHs256({ sub: "admin", exp: Math.floor(Date.now() / 1000) + 60 }, secret)}` }; }

describe("orchestrator HTTP API", () => {
  test("creates and manages a container", async () => {
    const { fetch } = setup();
    const created = await fetch(new Request("http://localhost/containers", { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ image: "alpine:3.20", policy: { scopes: ["stats"] } }) }));
    expect(created.status).toBe(201); const body = await created.json(); expect(body.containerId).toBeString();
    const info = await fetch(new Request(`http://localhost/containers/${body.containerId}`, { headers: { authorization: `Bearer ${body.accessToken}` } }));
    expect(info.status).toBe(200); expect((await info.json()).state).toBe("ready");
    const stats = await fetch(new Request(`http://localhost/containers/${body.containerId}/stats`, { headers: { authorization: `Bearer ${body.accessToken}` } }));
    expect(stats.status).toBe(200);
  });

  test("rejects a delegated token used for another container", async () => {
    const { fetch } = setup();
    const first = await fetch(new Request("http://localhost/containers", { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ image: "alpine" }) }));
    const second = await fetch(new Request("http://localhost/containers", { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ image: "alpine" }) }));
    const a = await first.json(); const b = await second.json();
    const response = await fetch(new Request(`http://localhost/containers/${b.containerId}`, { headers: { authorization: `Bearer ${a.accessToken}` } }));
    expect(response.status).toBe(403);
  });
});

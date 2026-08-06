import { describe, expect, test } from "bun:test";
import { signHs256 } from "../src/auth.ts";
import { MockBackend } from "../src/backends/mock.ts";
import { ContainerRegistry } from "../src/registry.ts";
import { createServer } from "../src/server.ts";
import { PortRegistry } from "../src/ports.ts";

const secret = "test-secret";
function setup() { const registry = new ContainerRegistry(new MockBackend()); return { registry, fetch: createServer(registry, { secret }) }; }
function auth() { return { authorization: `Bearer ${signHs256({ sub: "admin", exp: Math.floor(Date.now() / 1000) + 60 }, secret)}` }; }

describe("orchestrator HTTP API", () => {
  test("returns structured authentication and route errors", async () => {
    const { fetch } = setup();
    expect((await fetch(new Request("http://localhost/health"))).status).toBe(200);
    const unauthorized = await fetch(new Request("http://localhost/containers", { method: "GET" }));
    expect(unauthorized.status).toBe(401); expect((await unauthorized.json()).error.code).toBe("UNAUTHORIZED");
    const notFound = await fetch(new Request("http://localhost/missing", { headers: auth() }));
    expect(notFound.status).toBe(404); expect((await notFound.json()).error.code).toBe("NOT_FOUND");
  });

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

  test("opens and closes a scoped forward", async () => {
    const { registry } = setup(); const ports = new PortRegistry({ domain: "example.test", scheme: "https", style: "flat", separator: "-", ttl: 60000 });
    const fetch = createServer(registry, { secret, ports });
    const created = await fetch(new Request("http://localhost/containers", { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ image: "alpine", policy: { portForward: true, scopes: ["ports"] } }) }));
    const body = await created.json(); const response = await fetch(new Request(`http://localhost/containers/${body.containerId}/ports`, { method: "POST", headers: { authorization: `Bearer ${body.accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ port: 3000 }) }));
    expect(response.status).toBe(201); expect((await response.json()).url).toMatch(/^https:\/\//);
  });

  test("keeps filesystem operations inside the container root", async () => {
    const { fetch } = setup();
    const created = await fetch(new Request("http://localhost/containers", { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ image: "alpine", policy: { scopes: ["fs.read", "fs.write"] } }) }));
    const body = await created.json(); const headers = { authorization: `Bearer ${body.accessToken}` };
    const write = await fetch(new Request(`http://localhost/containers/${body.containerId}/fs/write?path=%2Fworkspace%2Fhello.txt`, { method: "PUT", headers, body: "hello" }));
    expect(write.status).toBe(204);
    const read = await fetch(new Request(`http://localhost/containers/${body.containerId}/fs/read?path=%2Fworkspace%2Fhello.txt`, { headers }));
    expect(read.status).toBe(200); expect(await read.text()).toBe("hello");
    const traversal = await fetch(new Request(`http://localhost/containers/${body.containerId}/fs/read?path=%2F..%2Fsecret`, { headers }));
    expect(traversal.status).toBe(400);
  });
});

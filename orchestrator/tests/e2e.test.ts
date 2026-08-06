import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Minicomputer } from "../../clients/node/src/index.ts";
import { MockBackend } from "../src/backends/mock.ts";
import { PortRegistry } from "../src/ports.ts";
import { ContainerRegistry } from "../src/registry.ts";
import { createServer, listen } from "../src/server.ts";

const secret = "e2e-test-secret";
let server: ReturnType<typeof listen>; let client: Minicomputer;

beforeAll(() => {
  const registry = new ContainerRegistry(new MockBackend());
  server = listen(createServer(registry, { secret, ports: new PortRegistry({ domain: "localhost", scheme: "http", style: "flat", separator: "-", ttl: 60000 }) }), 0);
  client = new Minicomputer({ endpoint: server.url.toString(), secret });
});
afterAll(() => server.stop(true));

describe("SDK to live HTTP server", () => {
  test("creates, delegates, writes, reads and destroys a container", async () => {
    await expect(client.test()).resolves.toEqual({ status: "ok" });
    const vm = await client.create("alpine", { policy: { portForward: true, scopes: ["fs.read", "fs.write", "stats", "ports"] } });
    expect(vm.id).toBeString();
    await vm.fsWrite("/workspace/e2e.txt", "end-to-end");
    expect(new TextDecoder().decode(await vm.fsRead("/workspace/e2e.txt"))).toBe("end-to-end");
    const stats = await vm.stats() as { memory: number };
    expect(stats.memory).toBe(0);
    const forward = await vm.portForward(3000);
    expect(forward.url).toMatch(/^http:\/\//);
    await forward.close();
    expect(await vm.ports()).toHaveLength(0);
    await vm.pause(); expect((await vm.info()).state).toBe("paused");
    await vm.resume(); expect((await vm.info()).state).toBe("ready");
    await vm.destroy();
    await expect(vm.info()).rejects.toThrow("Container not found");
  });
});

import { describe, expect, test } from "bun:test";
import { MockBackend } from "../src/backends/mock.ts";
import { ContainerRegistry } from "../src/registry.ts";

describe("container registry", () => {
  test("tracks lifecycle and removes backend state", async () => {
    const backend = new MockBackend(); const registry = new ContainerRegistry(backend);
    const container = await registry.create("alpine", {}, {}, { portForward: false, allowSubdomains: false, scopes: ["stats"] });
    expect(container.state).toBe("ready");
    expect((await registry.pause(container.id)).state).toBe("paused");
    expect((await registry.resume(container.id)).state).toBe("ready");
    await registry.destroy(container.id);
    expect(registry.list()).toHaveLength(0);
    expect(await backend.list()).toHaveLength(0);
  });

  test("rejects invalid filesystem paths", async () => {
    const registry = new ContainerRegistry(new MockBackend());
    const container = await registry.create("alpine", {}, {}, { portForward: false, allowSubdomains: false, scopes: ["fs.read", "fs.write"] });
    expect(() => registry.writeFile(container.id, "relative.txt", new Uint8Array())).toThrow();
    expect(() => registry.writeFile(container.id, "/workspace/../secret", new Uint8Array())).toThrow();
  });
});

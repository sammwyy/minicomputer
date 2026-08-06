import { describe, expect, test } from "bun:test";
import { PortRegistry } from "../src/ports.ts";

describe("port registry", () => {
  test("is idempotent per container and port", () => {
    const registry = new PortRegistry({ domain: "example.test", scheme: "https", style: "nested", separator: "-", ttl: 60000 });
    const first = registry.open("container", 3000);
    expect(registry.open("container", 3000)).toEqual(first);
    expect(first.host).toMatch(/^[^.]+\.container\.example\.test$/);
    expect(registry.list("container")).toHaveLength(1);
  });

  test("validates ports and custom domains", () => {
    const registry = new PortRegistry({ domain: "example.test", scheme: "http", style: "flat", separator: "-", ttl: 60000 });
    expect(() => registry.open("id", 0)).toThrow();
    expect(() => registry.open("id", 70000)).toThrow();
    expect(() => registry.open("id", 80, true, "attacker.test")).toThrow();
    expect(registry.open("id", 80, true, "preview.example.test").host).toBe("preview.example.test");
  });

  test("expires and closes registrations", async () => {
    const registry = new PortRegistry({ domain: "example.test", scheme: "http", style: "flat", separator: "-", ttl: 1 });
    const forward = registry.open("id", 80);
    await Bun.sleep(5);
    expect(() => registry.get(forward.nonce)).toThrow();
    expect(registry.close("id", 80)).toBe(false);
  });
});

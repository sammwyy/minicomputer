import { randomUUID } from "node:crypto";
import { ApiError } from "./errors.ts";
import type { ContainerBackend, ContainerRecord, Limits, Policy } from "./types.ts";

export class ContainerRegistry {
  private records = new Map<string, ContainerRecord>();
  private files = new Map<string, Map<string, Uint8Array>>();
  constructor(private readonly backend: ContainerBackend) {}
  async create(image: string, limits: Limits, env: Record<string, string>, policy: Policy) {
    const id = randomUUID();
    const backendContainer = await this.backend.create({ id, image, limits, env, labels: { "minicomputer.managed": "true", "minicomputer.created_at": new Date().toISOString() } });
    await this.backend.start(id);
    const record = { ...backendContainer, state: "ready" as const, limits, env, policy };
    this.records.set(id, record); this.files.set(id, new Map([["/", new Uint8Array()]])); return record;
  }
  get(id: string) { const record = this.records.get(id); if (!record) throw new ApiError(404, "CONTAINER_NOT_FOUND", "Container not found"); return record; }
  list() { return [...this.records.values()]; }
  async sync(id: string) { const record = this.get(id); const current = await this.backend.inspect(id); Object.assign(record, current); return record; }
  async pause(id: string) { const r = this.get(id); if (r.state === "paused") return r; await this.backend.pause(id); r.state = "paused"; return r; }
  async resume(id: string) { const r = this.get(id); if (r.state !== "paused") return r; await this.backend.resume(id); r.state = "ready"; return r; }
  async destroy(id: string) { const r = this.get(id); await this.backend.stop(id); await this.backend.remove(id); r.state = "destroyed"; this.records.delete(id); this.files.delete(id); }
  async stats(id: string) { return this.backend.stats(id); }
  readFile(id: string, path: string) { this.get(id); const data = this.files.get(id)!.get(this.path(path)); if (!data) throw new ApiError(404, "ENOENT", "File not found"); return data; }
  writeFile(id: string, path: string, data: Uint8Array) { this.get(id); this.files.get(id)!.set(this.path(path), data); }
  listFiles(id: string, path: string) { this.get(id); const prefix = this.path(path).replace(/\/$/, "") + "/"; const names = new Set<string>(); for (const file of this.files.get(id)!.keys()) if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split("/")[0]); return [...names].map(name => ({ name, path: `${prefix}${name}`, type: this.files.get(id)!.has(`${prefix}${name}`) ? "file" : "directory" })); }
  mkdir(id: string, path: string) { this.get(id); this.files.get(id)!.set(this.path(path), new Uint8Array()); }
  removeFile(id: string, path: string) { this.get(id); const key = this.path(path); let removed = false; for (const file of this.files.get(id)!.keys()) if (file === key || file.startsWith(`${key}/`)) { this.files.get(id)!.delete(file); removed = true; } if (!removed) throw new ApiError(404, "ENOENT", "Path not found"); }
  private path(path: string) { if (!path.startsWith("/") || path.includes("\0") || path.split("/").includes("..")) throw new ApiError(400, "INVALID_PATH", "Path must be absolute and contained"); return path.replace(/\/+/g, "/").replace(/\/$/, "") || "/"; }
}

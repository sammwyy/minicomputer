import { randomUUID } from "node:crypto";
import { ApiError } from "./errors.ts";
import type { ContainerBackend, ContainerRecord, Limits, Policy } from "./types.ts";

export class ContainerRegistry {
  private records = new Map<string, ContainerRecord>();
  constructor(private readonly backend: ContainerBackend) {}
  async create(image: string, limits: Limits, env: Record<string, string>, policy: Policy) {
    const id = randomUUID();
    const backendContainer = await this.backend.create({ id, image, limits, env, labels: { "minicomputer.managed": "true", "minicomputer.created_at": new Date().toISOString() } });
    await this.backend.start(id);
    const record = { ...backendContainer, state: "ready" as const, limits, env, policy };
    this.records.set(id, record); return record;
  }
  get(id: string) { const record = this.records.get(id); if (!record) throw new ApiError(404, "CONTAINER_NOT_FOUND", "Container not found"); return record; }
  list() { return [...this.records.values()]; }
  async sync(id: string) { const record = this.get(id); const current = await this.backend.inspect(id); Object.assign(record, current); return record; }
  async pause(id: string) { const r = this.get(id); if (r.state === "paused") return r; await this.backend.pause(id); r.state = "paused"; return r; }
  async resume(id: string) { const r = this.get(id); if (r.state !== "paused") return r; await this.backend.resume(id); r.state = "ready"; return r; }
  async destroy(id: string) { const r = this.get(id); await this.backend.stop(id); await this.backend.remove(id); r.state = "destroyed"; this.records.delete(id); }
  async stats(id: string) { return this.backend.stats(id); }
}

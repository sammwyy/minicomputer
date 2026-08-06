import { ApiError } from "../errors.ts";
import type { BackendContainer, BackendStats, ContainerBackend, ContainerSpec } from "../types.ts";

export class MockBackend implements ContainerBackend {
  readonly name = "mock";
  private containers = new Map<string, BackendContainer>();
  async probe() { return { ok: true, version: "mock" }; }
  capabilities() { return { pause: true, diskQuota: false, userns: false, checkpoint: false }; }
  async create(spec: ContainerSpec) {
    const item: BackendContainer = { id: spec.id, image: spec.image, state: "creating", createdAt: new Date().toISOString(), labels: spec.labels };
    this.containers.set(item.id, item); return structuredClone(item);
  }
  private get(id: string) { const item = this.containers.get(id); if (!item) throw new ApiError(404, "CONTAINER_NOT_FOUND", "Container not found"); return item; }
  async start(id: string) { this.get(id).state = "ready"; }
  async pause(id: string) { this.get(id).state = "paused"; }
  async resume(id: string) { this.get(id).state = "ready"; }
  async stop(id: string) { this.get(id).state = "stopped"; }
  async remove(id: string) { this.containers.delete(id); }
  async inspect(id: string) { return structuredClone(this.get(id)); }
  async list() { return [...this.containers.values()].map(item => structuredClone(item)); }
  async stats(id: string): Promise<BackendStats> { this.get(id); return { cpu: 0, memory: 0, disk: 0, netRx: 0, netTx: 0 }; }
}

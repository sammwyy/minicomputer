export type ContainerState = "creating" | "ready" | "paused" | "stopped" | "destroyed";
export type Scope = "exec" | "fs.read" | "fs.write" | "fs.watch" | "stats" | "ports";

export interface Limits { memory?: string; cpus?: number; disk?: string; pids?: number; ttl?: number }
export interface Policy { portForward: boolean; allowSubdomains: boolean; scopes: Scope[] }
export interface ContainerSpec { id: string; image: string; limits: Limits; env: Record<string, string>; labels: Record<string, string>; }
export interface BackendContainer { id: string; image: string; state: ContainerState; createdAt: string; labels: Record<string, string>; }
export interface BackendStats { cpu: number; memory: number; disk: number; netRx: number; netTx: number }
export interface ContainerBackend {
  readonly name: string;
  probe(): Promise<{ ok: boolean; version: string }>;
  capabilities(): Record<string, boolean>;
  create(spec: ContainerSpec): Promise<BackendContainer>;
  start(id: string): Promise<void>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  inspect(id: string): Promise<BackendContainer>;
  list(): Promise<BackendContainer[]>;
  stats(id: string): Promise<BackendStats>;
}
export interface ContainerRecord extends BackendContainer { policy: Policy; limits: Limits; env: Record<string, string>; }

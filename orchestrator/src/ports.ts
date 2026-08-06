import { randomBytes } from "node:crypto";
import { ApiError } from "./errors.ts";

export interface Forward { nonce: string; containerId: string; containerPort: number; host: string; url: string; public: boolean; expiresAt: string; customDomain?: string }
export interface PortOptions { domain: string; scheme: "http" | "https"; style: "nested" | "flat"; separator: string; ttl: number; }

export class PortRegistry {
  private readonly forwards = new Map<string, Forward>();
  private readonly byContainerPort = new Map<string, string>();
  constructor(private readonly options: PortOptions) {}
  open(containerId: string, port: number, publicPort = true, customDomain?: string): Forward {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError(400, "INVALID_PORT", "Port must be between 1 and 65535");
    const key = `${containerId}:${port}`; const existing = this.byContainerPort.get(key); if (existing) return this.forwards.get(existing)!;
    if (customDomain && !this.allowedDomain(customDomain)) throw new ApiError(400, "INVALID_DOMAIN", "Custom domain is not allowed");
    const nonce = randomBytes(18).toString("base64url"); const host = customDomain ?? (this.options.style === "flat" ? `${nonce}${this.options.separator}${containerId}.${this.options.domain}` : `${nonce}.${containerId}.${this.options.domain}`);
    const forward: Forward = { nonce, containerId, containerPort: port, host, url: `${this.options.scheme}://${host}`, public: publicPort, expiresAt: new Date(Date.now() + this.options.ttl).toISOString(), customDomain };
    this.forwards.set(nonce, forward); this.byContainerPort.set(key, nonce); return forward;
  }
  private allowedDomain(domain: string) { return domain === this.options.domain || domain.endsWith(`.${this.options.domain}`); }
  get(nonce: string) { const item = this.forwards.get(nonce); if (!item || Date.parse(item.expiresAt) <= Date.now()) { if (item) this.close(item.containerId, item.containerPort); throw new ApiError(404, "FORWARD_NOT_FOUND", "Forward not found"); } return item; }
  list(containerId: string) { return [...this.forwards.values()].filter(item => item.containerId === containerId).filter(item => Date.parse(item.expiresAt) > Date.now()); }
  close(containerId: string, port: number) { const nonce = this.byContainerPort.get(`${containerId}:${port}`); if (!nonce) return false; this.byContainerPort.delete(`${containerId}:${port}`); return this.forwards.delete(nonce); }
  closeContainer(containerId: string) { for (const item of this.list(containerId)) this.close(containerId, item.containerPort); }
}

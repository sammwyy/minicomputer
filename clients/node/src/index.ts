export interface ClientOptions { endpoint?: string; secret?: string; token?: string; timeout?: number }
export interface CreateOptions { memory?: string; cpus?: number; disk?: string; ttl?: number; env?: Record<string, string>; policy?: { portForward?: boolean; allowSubdomains?: boolean; scopes?: string[] } }
export interface ContainerInfo { containerId: string; accessToken: string; expiresAt: string; state: string; image: string; limits: Record<string, unknown> }
export interface Forward { nonce: string; host: string; url: string; containerPort: number; public: boolean; expiresAt: string; close(): Promise<void> }

export class Minicomputer {
  readonly endpoint: string; readonly token?: string; private readonly timeout: number;
  constructor(options: ClientOptions = {}) { this.endpoint = options.endpoint ?? process.env.MINICOMPUTER_URL ?? "http://localhost:8080"; this.token = options.token ?? options.secret ?? process.env.MINICOMPUTER_SECRET; this.timeout = options.timeout ?? 30000; }
  static connect(endpoint: string, containerId: string, token: string) { return new VM(new Minicomputer({ endpoint, token }), containerId, token); }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers); headers.set("content-type", "application/json"); if (this.token) headers.set("authorization", `Bearer ${this.token.includes(".") ? this.token : await signToken(this.token)}`);
    const response = await fetch(new URL(path, this.endpoint), { ...init, headers, signal: AbortSignal.timeout(this.timeout) });
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error?.message ?? `HTTP ${response.status}`); }
    return response.status === 204 ? undefined as T : await response.json() as T;
  }
  async test() { return this.request<{ status: string }>("/health", { headers: {} }); }
  async create(image: string, options: CreateOptions = {}) { const result = await this.request<ContainerInfo>("/containers", { method: "POST", body: JSON.stringify({ image, limits: { memory: options.memory, cpus: options.cpus, disk: options.disk, ttl: options.ttl }, env: options.env, policy: options.policy }) }); return new VM(this, result.containerId, result.accessToken, result); }
  async list() { return this.request<ContainerInfo[]>("/containers"); }
}

async function signToken(secret: string) {
  const encode = (value: string) => { const bytes = new TextEncoder().encode(value); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const header = encode(JSON.stringify({ alg: "HS256", typ: "JWT" })); const payload = encode(JSON.stringify({ sub: "admin", exp: Math.floor(Date.now() / 1000) + 60 }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`)));
  let binary = ""; for (const byte of signature) binary += String.fromCharCode(byte);
  return `${header}.${payload}.${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

export class VM {
  private infoValue?: ContainerInfo;
  constructor(private readonly api: Minicomputer, readonly id: string, readonly token: string, initial?: ContainerInfo) { this.infoValue = initial; }
  get infoSnapshot() { return this.infoValue; }
  private withToken() { return new Minicomputer({ endpoint: this.api.endpoint, token: this.token, timeout: 30000 }); }
  async info() { this.infoValue = await this.withToken().request<ContainerInfo>(`/containers/${this.id}`); return this.infoValue; }
  async stats() { return this.withToken().request(`/containers/${this.id}/stats`); }
  async pause() { await this.withToken().request(`/containers/${this.id}/pause`, { method: "POST", body: "{}" }); }
  async resume() { await this.withToken().request(`/containers/${this.id}/resume`, { method: "POST", body: "{}" }); }
  async destroy() { await this.apiRequest<void>(`/containers/${this.id}`, { method: "DELETE" }); }
  async portForward(port: number, options: { public?: boolean; customDomain?: string } = {}): Promise<Forward> { const forward = await this.apiRequest<Omit<Forward, "close">>(`/containers/${this.id}/ports`, { method: "POST", body: JSON.stringify({ port, ...options }) }); return { ...forward, close: () => this.closePort(port) }; }
  async ports() { return this.apiRequest<Omit<Forward, "close">[]>(`/containers/${this.id}/ports`); }
  async closePort(port: number | Forward) { const value = typeof port === "number" ? port : port.containerPort; await this.apiRequest<void>(`/containers/${this.id}/ports/${value}`, { method: "DELETE" }); }
  private apiRequest<T>(path: string, init?: RequestInit) { return this.withToken().request<T>(path, init); }
}

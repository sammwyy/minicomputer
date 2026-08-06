import { randomUUID } from "node:crypto";
import { ApiError, errorResponse } from "./errors.ts";
import { requireScope, signHs256, verifyJwt } from "./auth.ts";
import { ContainerRegistry } from "./registry.ts";
import type { Limits, Policy, Scope } from "./types.ts";
import { PortRegistry } from "./ports.ts";

export interface ServerOptions { secret?: string; issuer?: string; audience?: string; backend?: ConstructorParameters<typeof ContainerRegistry>[0]; ports?: PortRegistry; }
const allScopes: Scope[] = ["exec", "fs.read", "fs.write", "fs.watch", "stats", "ports"];
const defaultPolicy = (): Policy => ({ portForward: false, allowSubdomains: false, scopes: allScopes });

export function createServer(registry: ContainerRegistry, options: ServerOptions = {}) {
  const secret = options.secret ?? process.env.MINICOMPUTER_JWT_SECRET;
  if (!secret) throw new Error("MINICOMPUTER_JWT_SECRET is required");
  const authenticate = async (request: Request, admin = false) => {
    const raw = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!raw) throw new ApiError(401, "UNAUTHORIZED", "Bearer token required");
    const claims = await verifyJwt(raw, secret, { issuer: options.issuer, audience: options.audience });
    if (admin && claims.sub?.startsWith("container:")) throw new ApiError(403, "FORBIDDEN", "Admin token required");
    return claims;
  };
  const json = async (request: Request) => { try { return await request.json() as Record<string, unknown>; } catch { throw new ApiError(400, "INVALID_JSON", "Request body must be JSON"); } };
  const publicRecord = (r: ReturnType<ContainerRegistry["get"]>, token: string) => ({ containerId: r.id, accessToken: token, expiresAt: new Date(Date.now() + 3600000).toISOString(), state: r.state, image: r.image, limits: r.limits, policy: r.policy });
  const ports = options.ports;
  return async function fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url); const path = url.pathname;
      if (request.method === "GET" && path === "/health") return Response.json({ status: "ok" });
      if (request.method === "GET" && path === "/ready") return Response.json({ status: "ready" });
      if (request.method === "POST" && path === "/containers") {
        const claims = await authenticate(request, true); const body = await json(request);
        if (typeof body.image !== "string" || !body.image) throw new ApiError(400, "INVALID_IMAGE", "image is required");
        const limits = (body.limits ?? {}) as Limits; const env = (body.env ?? {}) as Record<string, string>;
        const requested = (body.policy ?? {}) as Partial<Policy>; const policy: Policy = { ...defaultPolicy(), ...requested, scopes: (requested.scopes ?? allScopes).filter((s): s is Scope => allScopes.includes(s)) };
        const record = await registry.create(body.image, limits, env, policy);
        return Response.json(publicRecord(record, signHs256({ sub: `container:${record.id}`, scopes: policy.scopes, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), iss: options.issuer }, secret)), { status: 201 });
      }
      const match = path.match(/^\/containers\/([^/]+)(?:\/(.*))?$/);
      if (request.method === "GET" && path === "/containers") { await authenticate(request, true); return Response.json(registry.list()); }
      if (!match) throw new ApiError(404, "NOT_FOUND", "Route not found");
      const id = match[1]; const action = match[2]; const claims = await authenticate(request, !claimsIsContainer(request));
      const record = registry.get(id); if (claims.sub === `container:${id}` && claims.sub !== `container:${record.id}`) throw new ApiError(403, "FORBIDDEN", "Container access denied");
      if (claims.sub?.startsWith("container:") && claims.sub !== `container:${id}`) throw new ApiError(403, "FORBIDDEN", "Container access denied");
      if (request.method === "GET" && !action) return Response.json(await registry.sync(id));
      if (request.method === "GET" && action === "stats") { requireScope(claims, "stats"); return Response.json(await registry.stats(id)); }
      if (request.method === "GET" && action === "fs/read") { requireScope(claims, "fs.read"); const path = url.searchParams.get("path"); if (!path) throw new ApiError(400, "INVALID_PATH", "path is required"); return new Response(new Blob([registry.readFile(id, path).buffer as ArrayBuffer])); }
      if (request.method === "GET" && action === "fs/list") { requireScope(claims, "fs.read"); return Response.json(registry.listFiles(id, url.searchParams.get("path") ?? "/")); }
      if (request.method === "PUT" && action === "fs/write") { requireScope(claims, "fs.write"); const path = url.searchParams.get("path"); if (!path) throw new ApiError(400, "INVALID_PATH", "path is required"); registry.writeFile(id, path, new Uint8Array(await request.arrayBuffer())); return new Response(null, { status: 204 }); }
      if (request.method === "POST" && action === "fs/mkdir") { requireScope(claims, "fs.write"); const body = await json(request); registry.mkdir(id, String(body.path)); return new Response(null, { status: 204 }); }
      if (request.method === "DELETE" && action === "fs/remove") { requireScope(claims, "fs.write"); const path = url.searchParams.get("path"); if (!path) throw new ApiError(400, "INVALID_PATH", "path is required"); registry.removeFile(id, path); return new Response(null, { status: 204 }); }
      if (request.method === "GET" && action === "ports") { requireScope(claims, "ports"); return Response.json(ports?.list(id) ?? []); }
      if (request.method === "POST" && action === "ports") { requireScope(claims, "ports"); if (!record.policy.portForward) throw new ApiError(403, "FORBIDDEN", "Port forwarding is disabled"); if (!ports) throw new ApiError(501, "NOT_CONFIGURED", "Port forwarding is not configured"); const body = await json(request); return Response.json(ports.open(id, Number(body.port), body.public !== false, typeof body.customDomain === "string" ? body.customDomain : undefined), { status: 201 }); }
      if (request.method === "DELETE" && action?.startsWith("ports/")) { requireScope(claims, "ports"); const port = Number(action.slice("ports/".length)); if (!ports?.close(id, port)) throw new ApiError(404, "FORWARD_NOT_FOUND", "Forward not found"); return new Response(null, { status: 204 }); }
      if (request.method === "POST" && action === "pause") { await registry.pause(id); return Response.json(await registry.sync(id)); }
      if (request.method === "POST" && action === "resume") { await registry.resume(id); return Response.json(await registry.sync(id)); }
      if (request.method === "DELETE" && !action) { await registry.destroy(id); ports?.closeContainer(id); return new Response(null, { status: 204 }); }
      if (request.method === "POST" && action === "token") { requireScope(claims, "exec"); const body = await json(request); const scopes = ((body.scopes ?? record.policy.scopes) as Scope[]).filter(s => record.policy.scopes.includes(s)); return Response.json({ accessToken: signHs256({ sub: `container:${id}`, scopes, exp: Math.floor(Date.now() / 1000) + 3600 }, secret) }); }
      throw new ApiError(404, "NOT_FOUND", "Route not found");
    } catch (error) { return errorResponse(error); }
  };
}

function claimsIsContainer(request: Request) { const raw = request.headers.get("authorization")?.replace(/^Bearer\s+/i, ""); return !!raw?.split(".")[1] && (() => { try { return JSON.parse(Buffer.from(raw!.split(".")[1], "base64url").toString()).sub?.startsWith("container:"); } catch { return false; } })(); }

export function listen(handler: ReturnType<typeof createServer>, port = Number(process.env.MINICOMPUTER_PORT ?? 8080)) { return Bun.serve({ port, fetch: handler }); }

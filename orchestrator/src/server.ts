import { randomUUID } from "node:crypto";
import { ApiError, errorResponse } from "./errors.ts";
import { requireScope, signHs256, verifyJwt } from "./auth.ts";
import { ContainerRegistry } from "./registry.ts";
import type { Limits, Policy, Scope } from "./types.ts";

export interface ServerOptions { secret?: string; issuer?: string; audience?: string; backend?: ConstructorParameters<typeof ContainerRegistry>[0]; }
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
      if (request.method === "POST" && action === "pause") { await registry.pause(id); return Response.json(await registry.sync(id)); }
      if (request.method === "POST" && action === "resume") { await registry.resume(id); return Response.json(await registry.sync(id)); }
      if (request.method === "DELETE" && !action) { await registry.destroy(id); return new Response(null, { status: 204 }); }
      if (request.method === "POST" && action === "token") { requireScope(claims, "exec"); const body = await json(request); const scopes = ((body.scopes ?? record.policy.scopes) as Scope[]).filter(s => record.policy.scopes.includes(s)); return Response.json({ accessToken: signHs256({ sub: `container:${id}`, scopes, exp: Math.floor(Date.now() / 1000) + 3600 }, secret) }); }
      throw new ApiError(404, "NOT_FOUND", "Route not found");
    } catch (error) { return errorResponse(error); }
  };
}

function claimsIsContainer(request: Request) { const raw = request.headers.get("authorization")?.replace(/^Bearer\s+/i, ""); return !!raw?.split(".")[1] && (() => { try { return JSON.parse(Buffer.from(raw!.split(".")[1], "base64url").toString()).sub?.startsWith("container:"); } catch { return false; } })(); }

export function listen(handler: ReturnType<typeof createServer>, port = Number(process.env.MINICOMPUTER_PORT ?? 8080)) { return Bun.serve({ port, fetch: handler }); }

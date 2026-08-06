import { ApiError } from "./errors.ts";
import type { Policy } from "./types.ts";

export interface Config { port: number; jwtSecret: string; backend: "mock" | "docker"; proxyDomain: string; maxContainers: number }

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const jwtSecret = env.MINICOMPUTER_JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) throw new ApiError(500, "INVALID_CONFIG", "MINICOMPUTER_JWT_SECRET must contain at least 32 characters");
  const backend = env.MINICOMPUTER_BACKEND ?? "mock";
  if (backend !== "mock" && backend !== "docker") throw new ApiError(500, "INVALID_CONFIG", `Unsupported backend: ${backend}`);
  const port = Number(env.MINICOMPUTER_PORT ?? 8080); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError(500, "INVALID_CONFIG", "MINICOMPUTER_PORT is invalid");
  return { port, jwtSecret, backend, proxyDomain: env.MINICOMPUTER_PROXY_DOMAIN ?? "localhost", maxContainers: Number(env.MINICOMPUTER_MAX_CONTAINERS ?? 100) };
}

export function normalizePolicy(input: Partial<Policy> = {}): Policy {
  const scopes = ["exec", "fs.read", "fs.write", "fs.watch", "stats", "ports"] as const;
  return { portForward: input.portForward === true, allowSubdomains: input.allowSubdomains === true, scopes: (input.scopes ?? [...scopes]).filter((scope): scope is typeof scopes[number] => scopes.includes(scope as typeof scopes[number])) };
}

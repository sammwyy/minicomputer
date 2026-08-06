import { createHmac, timingSafeEqual, verify, createPublicKey } from "node:crypto";
import { ApiError } from "./errors.ts";
import type { Scope } from "./types.ts";

type Claims = { sub?: string; scopes?: Scope[]; iss?: string; aud?: string | string[]; exp?: number; iat?: number };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const b64 = (data: string | Uint8Array) => Buffer.from(data).toString("base64url");
const parse = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

export async function verifyJwt(token: string, secret: string, options: { issuer?: string; audience?: string } = {}): Promise<Claims> {
  const pieces = token.split(".");
  if (pieces.length !== 3) throw new ApiError(401, "UNAUTHORIZED", "Malformed token");
  let header: Record<string, unknown>, payload: Claims;
  try { header = parse(pieces[0]); payload = parse(pieces[1]) as Claims; } catch { throw new ApiError(401, "UNAUTHORIZED", "Malformed token"); }
  const input = `${pieces[0]}.${pieces[1]}`;
  const signature = Buffer.from(pieces[2], "base64url");
  if (header.alg === "HS256") {
    const expected = createHmac("sha256", secret).update(input).digest();
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new ApiError(401, "UNAUTHORIZED", "Invalid token");
  } else if (header.alg === "RS256") {
    try { if (!verify("RSA-SHA256", encoder.encode(input), createPublicKey(secret), signature)) throw new Error(); } catch { throw new ApiError(401, "UNAUTHORIZED", "Invalid token"); }
  } else throw new ApiError(401, "UNAUTHORIZED", "Unsupported token algorithm");
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp !== undefined && payload.exp <= now) throw new ApiError(401, "TOKEN_EXPIRED", "Token has expired");
  if (options.issuer && payload.iss !== options.issuer) throw new ApiError(401, "UNAUTHORIZED", "Invalid issuer");
  if (options.audience && !(payload.aud === options.audience || (Array.isArray(payload.aud) && payload.aud.includes(options.audience)))) throw new ApiError(401, "UNAUTHORIZED", "Invalid audience");
  return payload;
}

export function signHs256(payload: Claims, secret: string): string {
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify(payload));
  const signature = b64(createHmac("sha256", secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${signature}`;
}

export function requireScope(claims: Claims, scope: Scope): void {
  if (!claims.scopes?.includes(scope)) throw new ApiError(403, "FORBIDDEN", `Missing scope: ${scope}`);
}

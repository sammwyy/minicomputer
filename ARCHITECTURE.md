# Minicomputer — Architecture

This document describes how Minicomputer is put together: the components, the trust boundaries, the wire protocols, and the reasoning behind the main design decisions.

---

## 1. Components

| Component | Language / Runtime | Responsibility |
|---|---|---|
| **Orchestrator** | TypeScript, Bun, ElysiaJS | Public API. Authenticates callers, drives a container backend driver, bridges clients to workers, proxies forwarded ports, emits events. |
| **Backend driver** | TypeScript, in-process | Adapts one container technology (Docker today) to the internal `ContainerBackend` interface. Selected at boot by `MINICOMPUTER_BACKEND`. |
| **Worker** | Rust (static, musl) | Runs *inside* every container as PID 1. Executes processes, serves filesystem operations, reports stats. |
| **Node client** | TypeScript (`@minicomputer/client`) | SDK for backends (admin mode) and browsers (delegated mode). |
| **RabbitMQ** | optional | Event fan-out, and optionally an alternative command intake. |

Three trust zones:

```
  ZONE A: caller           ZONE B: control plane          ZONE C: workload
  ───────────────          ─────────────────────          ───────────────
  backend (admin JWT)      orchestrator                   container + worker
  browser (scoped token)   backend driver + proxy         no host access
  visitor (port nonce)     runtime socket access
```

Zone A never touches the container runtime. Zone C never touches the network beyond its own private control port and whatever the orchestrator's proxy dials on its behalf.

---

## 2. Container backends

Minicomputer is not a Docker wrapper. Docker is one *backend driver* behind an internal interface, chosen at boot from `MINICOMPUTER_BACKEND`, and nothing above that line — REST surface, WebSocket protocol, tokens, SDK, proxy — knows which driver is loaded.

```
        public API (identical for every backend)
  ─────────────────────────────────────────────────────
        ContainerBackend interface   ← the only seam
  ─────────────────────────────────────────────────────
    docker/        podman/       containerd/   firecracker/
   (implemented)   (planned)      (planned)     (planned)
```

The interface is deliberately narrow — everything expressive happens through the worker, not through the runtime:

```ts
export interface ContainerBackend {
  readonly name: string;                     // "docker"

  probe(): Promise<BackendHealth>;           // reachable? version? feature flags?
  capabilities(): BackendCapabilities;       // pause, diskQuota, userns, checkpoint, …

  create(spec: ContainerSpec): Promise<BackendContainer>;
  start(id: string): Promise<void>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  stop(id: string, opts?: { timeout?: number }): Promise<void>;
  remove(id: string, opts?: { force?: boolean }): Promise<void>;

  inspect(id: string): Promise<BackendContainer>;
  list(filter?: BackendFilter): Promise<BackendContainer[]>;   // labels are the source of truth
  stats(id: string): Promise<BackendStats>;

  putFile(id: string, path: string, data: Uint8Array, mode?: number): Promise<void>;  // worker injection
  address(id: string): Promise<ContainerAddress>;              // how to dial the worker & forwarded ports
  events(): AsyncIterable<BackendEvent>;                       // oom, die, health transitions
}
```

`ContainerSpec` is expressed in Minicomputer's own vocabulary (image, limits, env, network mode, labels, mounts, entrypoint override) and each driver translates it into its runtime's shape. Requests for something a driver cannot do fail fast at create time with `501 BACKEND_UNSUPPORTED`, based on `capabilities()` — never silently degraded.

Rules a driver must honour:

1. **Labels are the database.** Every container carries `minicomputer.managed`, `minicomputer.owner`, `minicomputer.created_at`; `list()` must round-trip them so orphan reconciliation works.
2. **No host port publishing.** `address()` returns an address the *orchestrator* can dial (container IP, a socket path, a vsock CID). Nothing is bound on the host — port forwarding is the proxy's job (§6).
3. **Injection without the image's help.** `putFile()` must work on a `scratch` image, before the container's entrypoint runs.
4. **Idempotent teardown.** `remove()` on an already-gone container succeeds.

The Docker driver (`orchestrator/src/backends/docker/`) implements this over the Engine API on `MINICOMPUTER_BACKEND_ENDPOINT` (default `/var/run/docker.sock`): cgroup limits map to `HostConfig`, `putFile` uses the archive-put endpoint, `address()` returns the container IP on the internal network, and `events()` wraps `/events`. The Docker socket mount you see in the quick start is a requirement *of this driver*, not of the service.

Adding a backend means implementing the interface and registering it in `orchestrator/src/backends/index.ts`. No route, SDK method or protocol frame changes.

---

## 3. Why a Rust worker

The obvious way to control a container is the runtime's own exec (`docker exec` and its equivalents). Minicomputer does not, for four reasons:

1. **Image independence.** `docker exec` still needs *something* in the image — a shell, a Python, a `cat`. The worker is a single static binary copied in at creation time, so `FROM scratch` works exactly like `FROM ubuntu`.
2. **Multiplexing.** One WebSocket carries every process, every filesystem call and the stats stream for a container. `docker exec` would need one hijacked HTTP connection per process.
3. **Rich primitives.** inotify watches, recursive directory streaming, archive unpacking and per-process resource accounting are trivial from inside the container and awkward from outside.
4. **Backend portability.** The worker protocol is identical whether the container is started by Docker, Podman, containerd or (later) Firecracker. Only the thin backend driver in the orchestrator changes — see §2.

The binary is built for `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`, statically linked, no libc dependency, ~2 MB stripped.

---

## 4. Container lifecycle

### Creation

1. Client sends `POST /containers` with an admin JWT and `{ image, limits, policy }`.
2. Orchestrator validates the JWT, checks the image against `MINICOMPUTER_IMAGE_ALLOWLIST`, and checks global/tenant concurrency caps.
3. The orchestrator normalizes and persists the VM policy before creation. `policy.scopes` is an allowlist ceiling for every delegated token; `policy.portForward` and `policy.allowSubdomains` are independent capability gates. The active backend driver then creates the container from a `ContainerSpec`: requested limits, an internal-only network attachment, a tmpfs-mounted `/.minicomputer` directory, and the worker binary injected via `putFile()`. Anything the driver's `capabilities()` does not support fails here with `501 BACKEND_UNSUPPORTED`.
4. Entrypoint is overridden to `/.minicomputer/worker --listen 127.0.0.1:7777 --handshake <nonce>`; the original image entrypoint is preserved in metadata and can be launched as a supervised process.
5. Orchestrator dials the worker over the container network, completes the handshake, and marks the container `ready`.
6. It returns `{ containerId, accessToken, expiresAt }`. The token is a JWT signed by the orchestrator with `sub = containerId` and a permission set.

### Pause / resume

`pause()` freezes the cgroup (`SIGSTOP` semantics via the runtime's freezer). Processes, open file descriptors, TCP sockets and memory contents survive; CPU usage drops to zero. The worker's control connection is intentionally kept alive but idle — the orchestrator marks the session `frozen` and rejects exec calls with `409 CONTAINER_PAUSED` until `resume()`.

`resume()` thaws the cgroup and replays any buffered stats subscription.

Memory is still held while paused. For a true zero-cost pause, `pause({ checkpoint: true })` (roadmap) uses CRIU to dump state to disk and free RAM entirely.

### Destroy

Kill → remove → reclaim volumes → drop every forwarded-port registration for the container → close all client sessions with code `4004 CONTAINER_DESTROYED` → publish `container.destroyed` with the reclaimed-resource payload.

### Reapers

Two background loops:
- **TTL reaper** — destroys containers past `ttl`.
- **Orphan reaper** — on boot, reconciles the runtime's actual container list against persisted state; containers labelled `minicomputer.managed=true` with no live session are destroyed or re-adopted depending on `MINICOMPUTER_ADOPT_ORPHANS`.

---

## 5. Protocols

### 5.1 Client ↔ Orchestrator

**Control plane: HTTP + JWT.**

```
POST   /containers                 create { image, limits?, policy?: { portForward?, allowSubdomains?, scopes?: string[] } }
GET    /containers                 list (admin)
GET    /containers/:id             info
POST   /containers/:id/pause
POST   /containers/:id/resume
DELETE /containers/:id             destroy
POST   /containers/:id/exec        one-shot command
GET    /containers/:id/stats       snapshot
POST   /containers/:id/token       mint an additional scoped token
GET    /containers/:id/ports       list open forwards
POST   /containers/:id/ports       open a forward   { port, ttl?, public?, customDomain? }
DELETE /containers/:id/ports/:port close a forward
GET    /health  /ready             probes
```

**Data plane: one WebSocket per container.**

```
GET /containers/:id/ws?token=<accessToken>
```

Everything streaming rides this socket: process stdio, process lifecycle, filesystem notifications and stats. Frames are JSON for control, binary for payloads.

Binary frame layout — a small header keeps stdio out of JSON/base64:

```
 0        1        2        4                       N
 ┌────────┬────────┬────────┬───────────────────────┐
 │  kind  │ stream │  chan  │        payload        │
 └────────┴────────┴────────┴───────────────────────┘
   u8       u8       u16              bytes

 kind:   0x01 stdio  0x02 fs-chunk  0x03 stats
 stream: 0x00 stdin  0x01 stdout    0x02 stderr
 chan:   process id / request id
```

JSON control frames:

```jsonc
// client -> orchestrator
{ "id": "r1", "op": "spawn", "cmd": "bash", "args": ["-l"], "tty": true }
{ "id": "r2", "op": "fs.listdir", "path": "/workspace" }
{ "id": "r3", "op": "process.kill", "pid": 4, "signal": "SIGTERM" }

// orchestrator -> client
{ "id": "r1", "ok": true, "pid": 4 }
{ "ev": "process.exit", "pid": 4, "exitCode": 0, "signal": null }
{ "ev": "fs.notify", "kind": "write", "path": "/workspace/main.js" }
{ "id": "r2", "ok": false, "error": { "code": "ENOENT", "message": "…" } }
```

Every request carries an `id`; every response echoes it. The SDK turns that into promises, and turns `ev` frames into emitter callbacks. Unmatched or malformed frames close the socket rather than being ignored.

### 5.2 Orchestrator ↔ Worker

Length-prefixed binary framing over plain TCP on a container-private port (default `127.0.0.1:7777` on the container's own network namespace, never published to the host).

```
 ┌────────────┬────────┬───────────────────────┐
 │ len (u32)  │ opcode │        body           │
 └────────────┴────────┴───────────────────────┘
```

Bodies are MessagePack. The opcode set mirrors the client operations but is deliberately lower-level: `SPAWN`, `WRITE_STDIN`, `SIGNAL`, `WAIT`, `FS_READ`, `FS_WRITE`, `FS_LIST`, `FS_MKDIR`, `FS_MOVE`, `FS_REMOVE`, `FS_STAT`, `FS_WATCH`, `FS_UNPACK`, `FS_PACK`, `STATS_SUBSCRIBE`, `PING`.

**Handshake.** On start the worker receives a one-time nonce via argv. The first frame from the orchestrator must be `HELLO{nonce, protocolVersion}`. A mismatch, or a second HELLO, terminates the worker. This stops any process *inside* the container from impersonating the orchestrator on the loopback port.

**Backpressure.** Stdout from a runaway process is bounded by a per-process ring buffer in the worker (default 256 KB). When the buffer fills, the worker stops reading the pipe, which naturally applies POSIX backpressure to the child. The orchestrator applies the same policy toward slow WebSocket clients, and drops a `stream.lagged` event rather than buffering without bound.

### 5.3 Orchestrator ↔ RabbitMQ

Optional and strictly non-blocking: Minicomputer never fails a request because the broker is down. Events are published to the `minicomputer.events` topic exchange with routing key = event name, and buffered in a bounded in-memory outbox with retry while the broker is unavailable.

If `MINICOMPUTER_AMQP_COMMANDS=true`, the orchestrator also consumes `minicomputer.commands`. Command messages carry the same JWT in a header, are validated identically to HTTP, and reply to `reply_to` with `correlation_id`. This exists so queue-native architectures can drive Minicomputer without an HTTP hop; it is not required, and streaming still happens over WebSocket.

---

## 6. Port forwarding and the edge proxy

A container's services must be reachable without publishing ports on the host — publishing leaks the workload onto the host's network namespace, collides across containers, and cannot be revoked. Minicomputer instead terminates the traffic itself and dials the container from the inside.

### 6.1 Edge routing

One listener, two destinations, decided purely by the `Host` header:

```
  Host: api.example.com                ──▶  the normal HTTP/WS API
  Host: <forward label>.<proxyDomain>  ──▶  port-forward proxy
  anything else                        ──▶  404
```

`MINICOMPUTER_PROXY_DOMAIN` sets the base. How the nonce and the container id are packed into the labels below it is deliberately configurable, because it is a *DNS and TLS* decision, not a protocol one:

| `MINICOMPUTER_PROXY_HOST_STYLE` | Hostname | Requires |
|---|---|---|
| `nested` (default) | `<nonce>.<containerId>.<domain>` | `*.*.<domain>` DNS, and a certificate covering two wildcard levels — in practice TLS terminated at a front proxy with `MINICOMPUTER_PROXY_TRUST_FORWARDED=true`, since a single `*.<domain>` cert does not match a two-label name |
| `flat` | `<nonce>-<containerId>.<domain>` | `*.<domain>` — an ordinary wildcard record and an ordinary wildcard certificate |

`flat` joins the two with `MINICOMPUTER_PROXY_HOST_SEPARATOR` (default `-`, must not appear in a nonce or a UUID). Parsing is the mirror image: split the leftmost label(s) off the configured domain, then split on the separator for `flat`. Both styles resolve to the same `(nonce, containerId)` pair, and the nonce is what is actually looked up — the container id in the hostname is cosmetic and is verified against the registration, not trusted.

The style is fixed at boot: changing it invalidates every URL already handed out (the registrations survive, the hostnames do not), so treat it as a deployment-time choice. Setting `MINICOMPUTER_PROXY_PORT` moves proxied traffic to its own listener when you would rather not share one.

### 6.2 Opening a port

```ts
const port = await vm.portForward(3000);
// { nonce, host, url, containerPort: 3000, public: true, expiresAt }

const custom = await vm.portForward(3000, {
  customDomain: "preview.mydomainlol.com",
});
// { nonce, host: "preview.mydomainlol.com", url: "https://preview.mydomainlol.com", ... }
```

The orchestrator:

1. Checks the VM policy has `portForward: true`, the caller's token carries the `ports` scope, and the container is below `MINICOMPUTER_PROXY_MAX_PORTS`.
2. Generates a random nonce (`MINICOMPUTER_PROXY_NONCE_BYTES` of entropy, base32, DNS-label safe).
3. If `customDomain` is present, validates the FQDN against `MINICOMPUTER_PROXY_CUSTOM_DOMAINS`. An exact configured domain is always eligible; a hostname below a configured root requires `policy.allowSubdomains === true`. A custom hostname must be unique while registered.
4. Registers `nonce → { containerId, containerPort, public, customDomain?, expiresAt }` and, when present, `customDomain → nonce` in the proxy table, indexed by `(containerId, containerPort)` so `closePort(3000)` can find it.
5. Returns the endpoint already assembled, plus its parts (`nonce`, `host`, `containerPort`, `customDomain`), so callers do not reconstruct hostnames.

Nothing is created in the container or the runtime: opening a port is a control-plane registration. The service inside does not need to exist yet — it can start after the URL is handed out.

**Why a nonce and not just the port.** `<containerId>.<domain>/…` alone would make every port of a container guessable the moment its UUID leaks (and the UUID travels to browsers by design). The nonce makes each forward an independent capability: unguessable, individually revocable, and unlinkable to the container's other ports. It is also the *only* thing that maps to a port number — the real port never appears in the URL.

### 6.3 Serving a request

```
  visitor ──▶ edge router ──▶ proxy table lookup(customDomain or nonce)
                                   │
                                   ├─ miss / expired / closed  ─▶ 404
                                   ├─ container paused / no worker ─▶ 503
                                   └─ hit ─▶ backend.address(id) ─▶ dial ip:3000
                                                    │
                                                    ├─ ECONNREFUSED  ─▶ 502 Bad Gateway
                                                    ├─ timeout       ─▶ 504 Gateway Timeout
                                                    └─ ok            ─▶ stream both ways
```

- **HTTP/1.1 and HTTP/2 in, HTTP/1.1 out.** Request and response bodies stream; nothing is buffered whole.
- **WebSocket.** `Upgrade: websocket` is passed through verbatim, subprotocols and all, and the two sockets are piped until either side closes. This is the only upgrade honoured — raw TCP forwarding is out of scope, `portForward()` is an HTTP-level primitive.
- **Headers.** Hop-by-hop headers are stripped; `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` are set from the real client (or forwarded from the trusted front proxy). `X-Minicomputer-Container` is added for the workload's benefit and stripped from any inbound request.
- **Custom hostnames.** The edge router first resolves an exact registered custom hostname, then the generated nonce hostname. A custom hostname never bypasses the nonce registration or token checks; it is only an alternate lookup key for the same forward.
- **`public: false`** forwards additionally require the container access token — `Authorization: Bearer …` or the `mc_token` cookie — and answer `401` without it. The check runs before the container is dialled.
- Error pages are plain, tiny and identical in shape, so a scanner cannot distinguish "wrong nonce" from "no such container": both are a bare `404`.

### 6.4 Lifetime

A forward dies when: `closePort()`/`port.close()` is called, its `ttl` elapses (reaped on the same loop as container TTLs), the container is destroyed, or the worker is lost. While a container is paused the registration survives but every request answers `503` — a resumed container keeps the same URLs, which is what makes pause/resume usable for preview environments.

`port.opened` and `port.closed` events are published to AMQP with the nonce, container and port, so an audit trail exists without touching the proxy.

Registrations live in memory alongside session state; in multi-node mode (§9) they go in the shared registry, and a node that receives traffic for a container it does not own proxies to the owning node exactly as it does for WebSocket sessions.

---

## 7. Authentication and authorization

Two token types, both JWT.

**Admin token** — signed by *you* with the shared secret or your private key. Verified against `MINICOMPUTER_JWT_SECRET` / `MINICOMPUTER_JWT_PUBLIC_KEY`, plus `iss`, `aud` and `exp` when configured. Optional claims:

```jsonc
{
  "sub": "backend-api",
  "minicomputer": {
    "maxContainers": 10,          // per-subject concurrency cap
    "images": ["node:*"],         // subject-level image allowlist
    "limits": { "memory": "1g" }  // ceiling this subject may request
  }
}
```

**Container access token** — minted by the orchestrator, signed with its own key, scoped to one container:

```jsonc
{
  "sub": "9f1c…",                 // container id
  "scope": ["exec", "fs.read", "fs.write", "stats"],
  "exp": 1775420000
}
```

Scopes: `exec`, `process.kill`, `fs.read`, `fs.write`, `fs.watch`, `stats`, `ports` (open/close forwards), `lifecycle` (pause/resume/destroy). A read-only playground viewer gets `["fs.read", "stats"]`; a full IDE session gets everything but `lifecycle`. Note that `ports` governs *creating* a forward — traffic arriving at an already-open public forward is authorized by the nonce alone (§6.2).

At VM creation, `policy.scopes` is the maximum set that may be granted to container
access tokens. Token issuance computes the intersection of the requested scopes,
the admin subject's limits, and this VM policy. `fs.read`, `fs.write` and `fs.watch`
therefore remain independently controllable; omitting all `fs.*` scopes disables
filesystem access for delegated clients. `ports` is additionally gated by
`policy.portForward`. A token with `ports` cannot open a forward when that VM policy
is false, and `allowSubdomains` only controls custom hostnames below an approved root.
The policy is immutable for the lifetime of the VM; changing any of these capabilities
requires creating a new VM.

Tokens are stateless by default. A revocation list (in-memory, or Redis when `MINICOMPUTER_REDIS_URL` is set) lets you kill a session before its `exp`.

---

## 8. Isolation and resource control

Defaults are conservative; every one is overridable per container.

- cgroup v2 limits: `memory`, `memory.swap`, `cpu.max`, `pids.max`, `io.max`.
- Disk quota via the storage driver's `--storage-opt size=` where supported, otherwise a size-capped volume.
- `--cap-drop=ALL` plus an opt-in list, `--security-opt no-new-privileges`, seccomp default profile.
- `network: "none"` for full network isolation; named networks for grouping related containers.
- Optional read-only rootfs with a writable `/workspace` and `/tmp`.
- The worker itself runs as root inside the container's user namespace so it can spawn as any UID, but the container is started with userns remapping when the backend supports it, so container-root ≠ host-root.
- No container port is ever published to the host, with or without forwarding: the proxy dials the address the backend driver reports, so `network: "none"` plus a forwarded port still means a workload with no outbound reachability.

Which of these a given backend can enforce is reported by `capabilities()`; the orchestrator refuses a create that asks for a guarantee the active driver cannot make, rather than granting a weaker container than requested.

OOM kills, PID-limit hits and disk-quota exhaustion are surfaced as events (`container.oom`) rather than silent failures.

---

## 9. State

Minicomputer is stateless by design at the single-node level: the source of truth for what exists is the active backend itself, queried through labels (`minicomputer.managed`, `minicomputer.owner`, `minicomputer.created_at`). Session and stream state lives in memory.

Forwarded-port registrations are the one piece of state with no runtime-side mirror, so they are rebuilt from nothing on restart: URLs handed out before a restart stop resolving, and callers re-open them. Persisting them in Redis when configured removes that caveat.

For multi-node deployments, `MINICOMPUTER_REDIS_URL` enables a shared session and port registry so any node can answer `GET /containers/:id` and route proxied traffic, and a node that does not own a container proxies the WebSocket to the node that does. Container placement is a simple least-loaded pick with a pluggable interface.

---

## 10. Failure modes

| Failure | Behaviour |
|---|---|
| Worker crashes | Orchestrator detects socket close, marks container `degraded`, closes client sessions with `4001 WORKER_LOST`, publishes `worker.disconnected`. Container is destroyed unless `MINICOMPUTER_KEEP_DEGRADED=true`. |
| Orchestrator restarts | Containers keep running. On boot the orchestrator re-adopts them via labels and re-dials each worker; clients reconnect and re-attach with the same token. Running processes survive; in-flight stdio buffered in the worker ring is replayed. |
| Client disconnects | Processes keep running. `spawn({ killOnDisconnect: true })` opts into the opposite. A reconnect within `MINICOMPUTER_SESSION_GRACE` (default 60 s) re-attaches to live processes. |
| Broker down | Events buffer in a bounded outbox and retry with backoff; requests are unaffected. |
| Backend unavailable | `probe()` fails, `/ready` fails, new creates return `503`; existing WebSocket sessions and open forwards continue, since neither needs the backend once the container address is known. |
| Nothing listening on a forwarded port | Proxy answers `502 Bad Gateway`. The forward stays registered — services that start late are the normal case. |
| Forwarded service hangs | `504` after `MINICOMPUTER_PROXY_TIMEOUT`; the connection to the container is torn down. |
| Traffic for a paused container | `503` until `resume()`; the URL keeps working afterwards. |

---

## 11. Development mode

`MINICOMPUTER_DEV=true` enables:

- Frame-level tracing of both protocols (`minicomputer:proto` log scope), with payload truncation.
- `/debug/containers`, `/debug/sessions`, `/debug/ports`, `/debug/config` (redacted) — bound to loopback only, and compiled out of production builds.
- `MINICOMPUTER_BACKEND=mock`, an in-memory driver that satisfies `ContainerBackend` without a real runtime, for testing the API, proxy and SDK on a machine with no Docker.
- Proxy routing without wildcard DNS: `<nonce>.<id>.localhost` resolution and a `X-Minicomputer-Forward: <nonce>` header override.
- Relaxed CORS and a permissive token TTL.
- A `dev-token` helper CLI: `bun run token --sub dev --ttl 1h`.

Production builds refuse to start if `MINICOMPUTER_DEV=true` and `NODE_ENV=production` are set together, or if `MINICOMPUTER_JWT_SECRET` is missing, shorter than 32 bytes, or matches a known default.

---

## 12. Design decisions, briefly

- **HTTP-first, AMQP-optional.** Streaming interactive stdio over a message broker is possible but miserable — request/response correlation, ordering and backpressure all become your problem. WebSocket gives all three for free. RabbitMQ earns its place as an event bus, which is what queues are good at.
- **One socket per container, not per process.** Fewer connections to authorize, one place to apply backpressure, and process multiplexing is a `u16` channel field.
- **The backend is a driver, not the design.** Committing the public API to Docker semantics would make every later runtime a breaking change. A narrow `ContainerBackend` interface with capability probing costs one indirection today and keeps Podman, containerd and microVM backends additive.
- **Proxy, don't publish.** Binding container ports on the host gives away isolation, collides between containers and cannot be revoked. Terminating at the orchestrator makes a forward a revocable capability with an audit trail, and it comes for free once the orchestrator can already reach every container.
- **A nonce per port, not per container.** The container UUID is public by design — it is handed to browsers. Making the port label the secret keeps a leaked UUID worthless and lets one preview URL be revoked without touching the others.
- **Tokens over sessions.** A stateless scoped token can be handed to a browser, embedded in a URL, or passed through a job queue with no coordination.
- **The backend is the database.** Not needing Postgres to start is a feature for a self-hosted service. Redis is opt-in and only buys multi-node.
- **Rust for the worker, TypeScript for the orchestrator.** The worker needs a static binary, precise process control and low overhead. The orchestrator needs to be readable, quick to extend, and to speak the same language as the SDK consumers.

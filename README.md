# Minicomputer

**Self-hosted container orchestration for your backend and your users.**

Minicomputer is a small, single-binary-friendly microservice that lets any application create, control and destroy containers through a signed HTTP API — and hand safe, scoped control of a single container to an untrusted frontend without ever exposing your Docker socket.

```ts
const api = new Minicomputer(); // reads MINICOMPUTER_URL / MINICOMPUTER_SECRET

const vm = await api.create("alpine:3.20", { memory: "512m", cpus: 1 });
const proc = await vm.spawn("bash");

proc.onStdout((chunk) => process.stdout.write(chunk));
proc.writeStdin("uname -a\n");

await proc.waitFor(5_000);
await vm.destroy();
```

---

## Why Minicomputer

Running untrusted or user-supplied code usually means one of two bad options: expose your container runtime to your app server, or build a bespoke orchestrator every time. Minicomputer is the small middle layer.

- **JWT in, container out.** Every admin call is an HS256/RS256-signed request. No sessions, no dashboard, no database required to get started.
- **Delegable control.** A container comes back with an internal UUID plus a scoped access token. Ship that pair to a browser and the frontend drives *only* that container — no admin key ever leaves your backend.
- **Backend-agnostic.** Docker is the first implementation, not the contract. The orchestrator talks to a container backend through an internal driver interface and picks one from `MINICOMPUTER_BACKEND`; the public API is identical whichever is active. Podman, containerd and Firecracker are future drivers, not future rewrites.
- **Image-agnostic.** Control happens through `minicomputer-worker`, a statically-linked Rust binary injected into the container at start. `scratch`, `alpine`, `ubuntu`, a distroless Go image — it does not matter. No agent to bake in, no `curl` or `bash` required inside.
- **Streaming by default.** Process stdio, filesystem change events and resource stats all arrive over one WebSocket per container.
- **Port forwarding without exposing ports.** `vm.portForward(3000)` returns a public HTTP/WS URL on a random per-port nonce subdomain — `https://<nonce>.<containerId>.your-domain.com`, or the single-label `<nonce>-<containerId>.your-domain.com` if your wildcard certificate only covers one level. A VM may also opt into an allowlisted exact custom domain or subdomain. Nothing is published to the host, and the mapping dies with the container.
- **Optional RabbitMQ.** Enable it and Minicomputer publishes lifecycle events (`container.started`, `container.stopped`, `container.destroyed`, quota reclaimed, OOM kills) so your billing/quota services stay in sync. Admin commands can be consumed from AMQP too, if you want a fully queue-driven control plane.
- **Self-host, no lock-in.** One container, one env file. Your metal, your network, your rules.

## Use cases

| Scenario | Shape |
|---|---|
| **Online IDE / playground** | Backend creates a container, forwards `{ endpoint, containerId, token }` to the browser. The browser spawns processes and edits files directly. |
| **CI / job runner** | Backend spawns short-lived containers, streams logs, reads artifacts back with `fsDownload`, destroys them. |
| **AI agent sandbox** | Give an LLM a real shell inside a resource-capped container with no host access. |
| **Remote build / preview envs** | `pause()` idle environments to free CPU/RAM without losing state, `resume()` on the next request. Expose the dev server with `portForward()` and hand the URL to the user. |

---

## Architecture in one picture

```
                              ┌──────────────────────────────────┐
  ┌───────────┐  signed JWT   │   Minicomputer Orchestrator      │   ┌─────────────────┐
  │  Your     │ ────────────▶ │  ┌────────────────────────────┐  │   │   Container     │
  │  backend  │               │  │  edge router (Host-based)  │  │   │  ┌───────────┐  │
  └───────────┘               │  └─────┬──────────────┬───────┘  │   │  │  worker   │  │
                              │        │ api          │ proxy    │   │  │  (Rust,   │  │
  ┌───────────┐  scoped token │  ┌─────▼─────┐  ┌─────▼───────┐  │   │  │  PID 1)   │  │
  │  Browser  │ ◀───WS──────▶ │  │  HTTP/WS  │  │ port-forward│  │   │  └───────────┘  │
  └───────────┘               │  │    API    │  │   proxy     │  │   │        ▲        │
                              │  └─────┬─────┘  └─────┬───────┘  │   │  :3000 │        │
  ┌───────────┐  nonce.uuid   │        │              │          │   └────────┼────────┘
  │  Anyone   │ ────────────▶ │  ┌─────▼──────────────▼───────┐  │            │
  └───────────┘  .domain.com  │  │   backend driver interface │──┼── runtime ─┘
                              │  │   docker | podman | …      │  │   + private TCP
                              │  └────────────────────────────┘  │
                              └───────────────┬──────────────────┘
                                              │ events (optional)
                                              ▼
                                        ┌───────────┐
                                        │ RabbitMQ  │
                                        └───────────┘
```

Full details in [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Quick start

### 1. Run the orchestrator

```bash
docker run -d --name minicomputer \
  -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e MINICOMPUTER_JWT_SECRET="$(openssl rand -hex 32)" \
  -e MINICOMPUTER_HTTP_ENABLED=true \
  -e MINICOMPUTER_BACKEND=docker \
  ghcr.io/sammwy/minicomputer:latest
```

`MINICOMPUTER_BACKEND` selects the container backend driver. `docker` is the only implemented one today — mounting the Docker socket is a property of *that driver*, not of Minicomputer. Everything above this line in the stack (API, SDK, tokens, proxy) is backend-independent.

For a local Docker deployment without Docker-in-Docker, use the supplied Compose setup:

```bash
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up --build -d
```

The compose service mounts the host socket at `/var/run/docker.sock`. Set `DOCKER_SOCKET` when the host socket uses another path. See [deploy/README.md](./deploy/README.md) for the security implications.

Or with Compose:

```yaml
services:
  minicomputer:
    image: ghcr.io/sammwy/minicomputer:latest
    ports: ["8080:8080"]
    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]
    environment:
      MINICOMPUTER_JWT_SECRET: ${MINICOMPUTER_JWT_SECRET}
      MINICOMPUTER_HTTP_ENABLED: "true"
      MINICOMPUTER_BACKEND: docker
      MINICOMPUTER_PROXY_ENABLED: "true"
      MINICOMPUTER_PROXY_DOMAIN: sandbox.example.com
      MINICOMPUTER_AMQP_ENABLED: "true"
      MINICOMPUTER_AMQP_URL: amqp://guest:guest@rabbitmq:5672
      MINICOMPUTER_DEFAULT_MEMORY: 512m
      MINICOMPUTER_MAX_CONTAINERS: "50"
```

### 2. Install the client

```bash
npm install minicomputer   # works on Node 18+, Bun, Deno and the browser
```

### 3. Drive it

```ts
import { Minicomputer } from "minicomputer";

const api = new Minicomputer({
  endpoint: process.env.MINICOMPUTER_URL, // default: http://localhost:8080
  secret: process.env.MINICOMPUTER_SECRET,
  timeout: 30_000,
  reconnect: true,
});

await api.test(); // throws if credentials or endpoint are wrong

const vm = await api.create("node:22-alpine", {
  memory: "1g",
  cpus: 2,
  disk: "5g",
  network: "none",
  ttl: 3_600,
  env: { NODE_ENV: "sandbox" },
  policy: {
    portForward: true,
    allowSubdomains: true,
    scopes: ["exec", "fs.read", "fs.write", "fs.watch", "stats", "ports"],
  },
});

console.log(vm.id, vm.token); // safe to forward to a browser
```

---

## The API

### Admin mode (backend, JWT-signed)

```ts
const api = new Minicomputer();                 // or new Minicomputer({ endpoint, secret, ... })

await api.test();                       // credential + reachability check
await api.create(image, limits?);       // -> VM
await api.attach(containerId, token?);  // -> VM (reconnect to an existing one)
await api.list();                       // -> ContainerInfo[]
await api.stats();                      // host-level usage
```

### Delegated mode (frontend, scoped token)

```ts
const vm = await Minicomputer.connect(endpoint, containerId, accessToken);
```

Same `VM` surface, scoped to one container. The token can be issued read-only, exec-only, or full, and always carries an expiry.

### Container lifecycle

```ts
await vm.pause();    // freeze processes, keep the filesystem and memory state
await vm.resume();   // thaw and continue exactly where it stopped
await vm.destroy();  // stop, remove, reclaim disk, emit the reclaim event
await vm.info();     // state, uptime, image, limits
await vm.stats();    // { cpu, memory, disk, netRx, netTx } live snapshot
vm.onStats((s) => …, { interval: 1000 });
```

### Processes

```ts
const proc = await vm.spawn("bash", {
  args: ["-l"],
  cwd: "/workspace",
  env: { TERM: "xterm-256color" },
  tty: true,
  combineStderr: false, // true -> stderr is merged into the stdout stream
});

proc.onStdout((chunk: Uint8Array) => …);
proc.onStderr((chunk: Uint8Array) => …);
proc.writeStdin("ls -la\n");
proc.resize(120, 40);          // TTY only
proc.kill("SIGTERM");
proc.onStop((exitCode, signal) => …);

const exitCode = await proc.waitFor(10_000); // optional timeout in ms
```

One-shot commands, when you only care about the output:

```ts
const stdout = await vm.exec("whoami");
const { stdout, stderr, exitCode } = await vm.exec("npm test", { full: true, timeout: 60_000 });
```

### Filesystem

```ts
await vm.fsRead("/etc/hostname");                   // -> Uint8Array
await vm.fsWrite("/workspace/main.js", contents);
await vm.fsListdir("/workspace");                   // -> DirEntry[]
await vm.fsMkdir("/workspace/src", { recursive: true });
await vm.fsNewfile("/workspace/.env");
await vm.fsMove("/workspace/a.txt", "/workspace/b.txt");
await vm.fsRemove("/workspace/tmp", { recursive: true });
await vm.fsStat("/workspace/main.js");

// Live change notifications (inotify inside the container)
const watcher = await vm.fsNotify("/workspace", { recursive: true });
watcher.on((event) => console.log(event.kind, event.path)); // create | write | remove | rename
watcher.close();
```

Bulk transfer helpers:

```ts
// Upload a zip / tar / tar.gz / tar.zst and unpack it at the destination
await vm.fsUpload("/workspace", zipBlob);

// Stream a path back out, file by file
await vm.fsDownload("/workspace/dist", (fileName, content) => {
  fs.writeFileSync(path.join(out, fileName), content);
});

// Or grab a single archive
const tarball = await vm.fsDownloadArchive("/workspace", { format: "tar.gz" });
```

### Port forwarding

Expose an HTTP (or WebSocket) service running inside the container, without publishing anything to the host:

```ts
const port = await vm.portForward(3000);

port.url;         // "https://k7f3q9x2.9f1c2b7e-….sandbox.example.com"
port.nonce;       // "k7f3q9x2"
port.host;        // "k7f3q9x2.9f1c2b7e-….sandbox.example.com"
port.containerPort; // 3000
port.expiresAt;   // Date | null

await port.close();      // or: await vm.closePort(3000);
```

Each `portForward()` mints a **random nonce bound to that one container port** and registers `nonce → { containerId, 3000 }` in the orchestrator's proxy table. How that becomes a hostname is up to `MINICOMPUTER_PROXY_HOST_STYLE`:

| Style | Hostname | DNS / TLS |
|---|---|---|
| `nested` (default) | `<nonce>.<containerId>.<domain>` | needs `*.*.<domain>` — two wildcard labels, so usually TLS terminated at a front proxy, or a cert per level |
| `flat` | `<nonce>-<containerId>.<domain>` | a plain `*.<domain>` wildcard cert is enough |

The separator used by `flat` is `MINICOMPUTER_PROXY_HOST_SEPARATOR` (default `-`). Nothing else changes between the two: same nonce semantics, same proxy, same SDK. `port.host` and `port.url` always come back already assembled in the configured style, so build URLs from those rather than concatenating the parts yourself.

The nonce is the capability: the container UUID alone is not enough to reach anything, two forwarded ports of the same container are unguessable from one another, and closing the port invalidates the URL immediately. Ports are never bound on the host — the orchestrator dials the container's private network address itself.

Both plain HTTP and WebSocket upgrades are proxied (`Upgrade: websocket` passes through, including subprotocols). Raw TCP is not — this is an HTTP-level proxy.

Managing forwards:

```ts
await vm.ports();              // -> ForwardedPort[] currently open
await vm.closePort(3000);      // by container port
await vm.closePort(port);      // or by handle
```

#### Custom domains

A forward may request an exact custom hostname instead of the generated nonce hostname:

```ts
const port = await vm.portForward(3000, {
  customDomain: "mydomainlol.com",
});

// A subdomain is allowed only when the VM was created with allowSubdomains: true
const preview = await vm.portForward(3000, {
  customDomain: "preview.mydomainlol.com",
});
```

`customDomain` is an FQDN, never a URL or an arbitrary `Host` header. The orchestrator
validates it against the deployment's configured custom-domain allowlist, prevents a
hostname from being claimed by two forwards, and stores the hostname in the same proxy
registration as the nonce. DNS for the exact hostname (or a wildcard record for an
allowed subdomain) and a matching TLS certificate must point to the Minicomputer proxy;
Minicomputer does not create DNS records or certificates. The returned `url` and `host`
contain the custom hostname.

The VM policy is an upper bound, and delegated tokens are intersected with it:

```ts
type VmPolicy = {
  portForward?: boolean;       // default false; required for any port forward
  allowSubdomains?: boolean;   // default false; permits customDomain below an allowed root
  scopes?: string[];           // default []; maximum scopes that may be minted
};
```

Opening a port requires both `policy.portForward === true` and the delegated token's
`ports` scope. Filesystem access is controlled by the scope list (`fs.read`, `fs.write`,
`fs.watch`); there is no separate unrestricted filesystem switch. A requested token
scope not present in `policy.scopes` is rejected, so a token can never expand the VM's
permissions. The policy is fixed when the VM is created; it cannot be broadened by a
delegated client or by opening a later forward. `allowSubdomains` has no effect unless
`customDomain` is used.

Forwards are cleaned up on `destroy()`, on TTL expiry, and on worker loss. `pause()` keeps them registered but every request answers `503` until `resume()`.

Responses from the proxy when things are not right:

| Situation | Status |
|---|---|
| Unknown / closed / expired nonce | `404` |
| Nothing listening on that port inside the container | `502 Bad Gateway` |
| Container paused, or worker not ready | `503 Service Unavailable` |
| Upstream accepted but timed out | `504 Gateway Timeout` |

Set `MINICOMPUTER_PROXY_PORT_TTL` to auto-expire forwards, or pass a per-call override:

```ts
const port = await vm.portForward(8080, { ttl: 900, public: false });
```

`public: false` requires the container access token (`Authorization: Bearer …` or the `mc_token` cookie) on every proxied request, for previews that should not be world-readable.

---

## Events over RabbitMQ

With `MINICOMPUTER_AMQP_ENABLED=true`, Minicomputer publishes to the `minicomputer.events` topic exchange:

```json
{
  "event": "container.stopped",
  "containerId": "9f1c…",
  "at": "2026-08-05T20:14:03.221Z",
  "reason": "ttl_expired",
  "reclaimed": { "memory": "1g", "cpus": 2, "disk": "5g" },
  "usage": { "cpuSeconds": 412.7, "peakMemory": "834m", "netRx": 91234, "netTx": 41221 }
}
```

Routing keys: `container.created`, `container.started`, `container.paused`, `container.resumed`, `container.stopped`, `container.destroyed`, `container.oom`, `process.exited`, `port.opened`, `port.closed`, `worker.disconnected`.

Bind a queue and keep your quota, billing or audit service in sync without polling. Admin commands can optionally be consumed from the `minicomputer.commands` queue for a queue-only control plane.

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `MINICOMPUTER_HTTP_ENABLED` | `true` | Enable the HTTP + WebSocket API |
| `MINICOMPUTER_HTTP_PORT` | `8080` | Listen port |
| `MINICOMPUTER_JWT_SECRET` | — | HS256 secret (required unless using RS256) |
| `MINICOMPUTER_JWT_PUBLIC_KEY` | — | RS256/EdDSA public key, for asymmetric signing |
| `MINICOMPUTER_JWT_ISSUER` | — | Enforced `iss` claim |
| `MINICOMPUTER_TOKEN_TTL` | `3600` | Lifetime of issued container access tokens (s) |
| `MINICOMPUTER_AMQP_ENABLED` | `false` | Publish lifecycle events to RabbitMQ |
| `MINICOMPUTER_AMQP_URL` | — | Broker URL |
| `MINICOMPUTER_AMQP_EXCHANGE` | `minicomputer.events` | Topic exchange for events |
| `MINICOMPUTER_AMQP_COMMANDS` | `false` | Also accept admin commands from AMQP |
| `MINICOMPUTER_BACKEND` | `docker` | Container backend driver. Implemented: `docker`. Planned: `podman`, `containerd`, `firecracker` |
| `MINICOMPUTER_BACKEND_ENDPOINT` | driver default | Driver-specific connection string (for `docker`: the socket or TCP host) |
| `MINICOMPUTER_PROXY_ENABLED` | `false` | Enable the built-in reverse proxy and `portForward()` |
| `MINICOMPUTER_PROXY_DOMAIN` | — | Wildcard base domain, e.g. `sandbox.example.com` |
| `MINICOMPUTER_PROXY_CUSTOM_DOMAINS` | — | JSON array of exact custom domains or root domains delegated to the proxy |
| `MINICOMPUTER_PROXY_HOST_STYLE` | `nested` | `nested` → `<nonce>.<id>.<domain>` (needs `*.*.<domain>`); `flat` → `<nonce>-<id>.<domain>` (plain `*.<domain>` cert works) |
| `MINICOMPUTER_PROXY_HOST_SEPARATOR` | `-` | Separator between nonce and container id when style is `flat` |
| `MINICOMPUTER_PROXY_SCHEME` | `https` | Scheme used to build returned URLs |
| `MINICOMPUTER_PROXY_PORT` | same as HTTP | Separate listen port for proxied traffic (defaults to sharing the API listener) |
| `MINICOMPUTER_PROXY_NONCE_BYTES` | `8` | Entropy of the port nonce label |
| `MINICOMPUTER_PROXY_PORT_TTL` | `0` | Auto-close forwards after N seconds (`0` = until the container dies) |
| `MINICOMPUTER_PROXY_MAX_PORTS` | `5` | Max simultaneous forwards per container |
| `MINICOMPUTER_PROXY_TIMEOUT` | `30` | Upstream response timeout before `504` (s) |
| `MINICOMPUTER_PROXY_TRUST_FORWARDED` | `false` | Trust `X-Forwarded-*` from the front proxy in front of Minicomputer |
| `MINICOMPUTER_MAX_CONTAINERS` | `25` | Global concurrency cap |
| `MINICOMPUTER_DEFAULT_MEMORY` | `512m` | Default per-container memory limit |
| `MINICOMPUTER_DEFAULT_CPUS` | `1` | Default CPU quota |
| `MINICOMPUTER_DEFAULT_TTL` | `0` | Auto-destroy after N seconds (`0` = never) |
| `MINICOMPUTER_IMAGE_ALLOWLIST` | — | Comma-separated allowed images/prefixes |
| `MINICOMPUTER_NETWORK_MODE` | `bridge` | Default container network (`none` for full isolation) |
| `MINICOMPUTER_WORKER_PATH` | bundled | Override the injected worker binary |
| `MINICOMPUTER_LOG_LEVEL` | `info` | `trace`…`error` |
| `MINICOMPUTER_DEV` | `false` | Dev mode: verbose protocol tracing, relaxed CORS, `/debug` routes |

## Security model

- Admin JWTs never reach the browser; container tokens are scoped to one container ID, carry an explicit permission set and expire.
- The container backend (Docker socket, Podman socket, …) is only ever touched by the orchestrator's backend driver. Clients speak HTTP/WS, never the runtime API.
- Forwarded ports are reachable only through an unguessable per-port nonce, are never bound on the host, and are revoked the moment the port or the container is closed. `public: false` additionally requires the container token on every request.
- The worker binds to a container-private port that is not published to the host network; only the orchestrator dials it, over a per-container shared secret handshake.
- Image allowlists, per-container CPU/memory/disk/PID limits, `network: "none"`, read-only rootfs, dropped capabilities and no-new-privileges are all first-class options.
- Every admin action is logged with the JWT subject, and mirrored to AMQP when enabled.

## Development

```bash
git clone https://github.com/sammwy/minicomputer && cd minicomputer

cargo build --release --manifest-path worker/Cargo.toml   # the Rust worker
bun install && bun run dev --cwd orchestrator             # the orchestrator, hot reload
cd clients/node && pnpm build                             # the client SDK
```

Set `MINICOMPUTER_DEV=true` for frame-level protocol tracing between orchestrator and worker, plus `/debug/containers` and `/debug/sessions` introspection routes. These are disabled and unroutable in production builds.

Run the complete local verification suite with `make check` and `make test`. The TypeScript suite includes unit, HTTP integration and live-server SDK end-to-end tests; the Rust suite covers worker frame encoding and size validation.

Build and inspect the public client package with `npm run build:client` and `npm run pack:client`. Publish it from `clients/node/` with `npm publish --access public` after incrementing its version.

## Project layout

```
worker/                       Rust control agent injected into every container
  rust-toolchain.toml        Rust toolchain and musl target pinning
orchestrator/                 TypeScript / Bun / ElysiaJS microservice
  tsconfig.json              TypeScript compiler configuration
  src/backends/               container backend drivers
    backend.ts                the ContainerBackend interface every driver implements
    docker/                   the Docker driver (the only one implemented today)
    index.ts                  registry + MINICOMPUTER_BACKEND selection
  src/proxy/                  Host-based edge router and port-forward proxy
clients/node/                 Node-compatible SDK (minicomputer)
  tsconfig.json              TypeScript compiler configuration
```

## License

MIT © Sammwy

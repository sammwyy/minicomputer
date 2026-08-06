# Minicomputer — Roadmap

Path from empty repo to a production-ready, self-hostable release. Phases are ordered by dependency: each one should end with something demonstrable.

Legend: **P0** blocking for the next phase · **P1** needed for the release · **P2** nice to have.

---

## Phase 0 — Foundations

- [ ] Monorepo layout (`worker/`, `orchestrator/`, `clients/node/`, `docs/`, `examples/`) **P0**
- [ ] Rust toolchain pinned via `worker/rust-toolchain.toml`; musl targets for x86_64 and aarch64 **P0**
- [ ] Bun + TypeScript strict config, maintained per TypeScript package **P0**
- [ ] Lint/format: `rustfmt` + `clippy -D warnings`, `biome` for TS **P0**
- [ ] Conventional commits + changesets for versioning **P1**
- [ ] CI skeleton: build worker (both arches), typecheck, lint **P0**
- [ ] `LICENSE`, `CONTRIBUTING.md`, issue templates **P2**

## Phase 1 — Worker core (Rust)

- [ ] Binary framing codec (u32 length + opcode + MessagePack body) **P0**
- [ ] TCP listener on a configurable private port, single-connection policy **P0**
- [ ] Nonce handshake + protocol version negotiation **P0**
- [ ] `SPAWN`: fork/exec with argv, env, cwd, uid/gid **P0**
- [ ] Pipe mode stdio with per-process ring buffers and backpressure **P0**
- [ ] PTY mode (`openpty`, window resize, raw passthrough) **P0**
- [ ] `WRITE_STDIN`, `SIGNAL`, `WAIT`, exit code + signal reporting **P0**
- [ ] Combined stderr→stdout option **P1**
- [ ] Child reaping as PID 1 (`SIGCHLD` handler, zombie sweep) **P0**
- [ ] Graceful shutdown: SIGTERM to children, grace period, SIGKILL **P1**
- [ ] Static musl build, stripped, size budget ≤ 3 MB **P1**
- [ ] Unit tests for codec and process lifecycle **P1**

## Phase 2 — Worker filesystem & telemetry

- [ ] `FS_READ` / `FS_WRITE` with chunked streaming for large files **P0**
- [ ] `FS_LIST`, `FS_STAT`, `FS_MKDIR`, `FS_NEWFILE`, `FS_MOVE`, `FS_REMOVE` **P0**
- [ ] Path sandboxing: reject traversal and symlink escapes outside allowed roots **P0**
- [ ] `FS_WATCH` via inotify — recursive, coalesced, with watch-limit handling **P1**
- [ ] `FS_UNPACK`: zip, tar, tar.gz, tar.zst, with zip-slip protection **P1**
- [ ] `FS_PACK`: stream a directory out as archive or file-by-file **P1**
- [ ] `STATS_SUBSCRIBE`: cgroup v2 CPU/memory/pids/io + net counters, interval-driven **P1**
- [ ] Per-process resource accounting **P2**

## Phase 3 — Orchestrator core (TS / Elysia)

- [ ] Config loader with env schema validation and startup fail-fast **P0**
- [ ] `ContainerBackend` interface: lifecycle, `inspect`/`list`, `stats`, `putFile`, `address`, `events` **P0**
- [ ] Backend registry + `MINICOMPUTER_BACKEND` selection, fail-fast `probe()` at boot **P0**
- [ ] `capabilities()` probing; reject unsupported specs with `501 BACKEND_UNSUPPORTED` instead of degrading **P0**
- [ ] Docker driver implementing the full interface (Engine API, archive-put injection, `/events`) **P0**
- [ ] `mock` in-memory driver for tests and Docker-less development **P1**
- [ ] Backend conformance test suite every driver must pass **P1**
- [ ] Worker binary injection at container creation, via `putFile` (must work on `scratch`) **P0**
- [ ] Worker client: framing, request/response correlation, reconnect, timeouts **P0**
- [ ] Container registry (in-memory) with backend labels as the source of truth **P0**
- [ ] JWT verification: HS256 + RS256/EdDSA, `iss`/`aud`/`exp` enforcement **P0**
- [ ] Scoped container token minting and scope checks per operation **P0**
- [ ] REST surface: create, list, info, pause, resume, destroy, exec, stats, token **P0**
- [ ] VM access policy at creation: `portForward`, `allowSubdomains`, and maximum delegated `scopes[]` **P0**
- [ ] WebSocket data plane with binary + JSON frames, per-container multiplexing **P0**
- [ ] Structured error codes shared with the SDK **P1**
- [ ] Podman driver **P2**
- [ ] containerd driver **P2**

## Phase 4 — Port forwarding & edge proxy

- [ ] Host-header edge router: API traffic vs forward traffic, with pluggable hostname parsing **P0**
- [ ] Configurable host style: `nested` (`<nonce>.<id>.<domain>`, `*.*` DNS) and `flat` (`<nonce>-<id>.<domain>`, plain `*` wildcard cert), with separator config **P0**
- [ ] Proxy config: domain, scheme, dedicated port, nonce entropy, TTL, per-container max, timeout **P0**
- [ ] Port registry: `nonce -> { containerId, port, public, expiresAt }`, indexed by `(container, port)` **P0**
- [ ] REST: `GET/POST /containers/:id/ports`, `DELETE /containers/:id/ports/:port`, `ports` scope **P0**
- [ ] Custom per-forward hostnames: exact domains and policy-gated subdomains, with deployment allowlist and collision checks **P1**
- [ ] HTTP proxying with streamed request/response bodies, hop-by-hop stripping, `X-Forwarded-*` **P0**
- [ ] WebSocket upgrade passthrough, including subprotocols **P0**
- [ ] Status semantics: `404` unknown/expired nonce, `502` nothing listening, `503` paused/no worker, `504` timeout **P0**
- [ ] `public: false` forwards requiring the container token (header or cookie) **P1**
- [ ] Cleanup on close, TTL, destroy and worker loss; forwards survive pause **P0**
- [ ] `port.opened` / `port.closed` events **P1**
- [ ] Dev-mode routing without wildcard DNS (`.localhost`, header override) **P1**
- [ ] Trusted-front-proxy mode (`X-Forwarded-*` ingestion) and TLS/wildcard-cert deployment notes **P1**
- [ ] Per-forward rate limiting and concurrent-connection caps **P2**

## Phase 5 — Node client SDK

- [ ] `new Minicomputer(options?)` with env-derived defaults + `test()` **P0**
- [ ] `create()`, `attach()`, `list()`, `Minicomputer.connect()` for delegated mode **P0**
- [ ] `VM`: `info`, `stats`, `onStats`, `pause`, `resume`, `destroy` **P0**
- [ ] `Process`: `onStdout`, `onStderr`, `writeStdin`, `resize`, `kill`, `onStop`, `waitFor` **P0**
- [ ] `vm.exec()` shorthand, with `{ full: true }` for stderr + exit code **P0**
- [ ] Filesystem methods, `fsNotify` watcher handle **P1**
- [ ] `fsUpload` / `fsDownload` / `fsDownloadArchive` helpers **P1**
- [ ] `vm.portForward(port, opts?)` -> handle with `url`, `nonce`, `host`, `containerPort`, `close()` **P0**
- [ ] `vm.closePort(port | handle)`, `vm.ports()` **P0**
- [ ] Auto-reconnect with session re-attach and exponential backoff **P1**
- [ ] Browser build (no Node built-ins on the delegated path), ESM + CJS + `.d.ts` **P1**
- [ ] Node 18+ / Bun / Deno compatibility matrix in CI **P1**
- [ ] `AbortSignal` support on every async method **P2**

## Phase 6 — Events & RabbitMQ

- [ ] Event bus abstraction with a no-op sink when disabled **P0**
- [ ] AMQP publisher: topic exchange, routing keys, publisher confirms **P1**
- [ ] Bounded outbox with retry/backoff; requests never block on the broker **P1**
- [ ] Full event catalogue: `container.created|started|paused|resumed|stopped|destroyed|oom`, `process.exited`, `port.opened|closed`, `worker.disconnected` **P1**
- [ ] Reclaimed-resource and usage payloads on stop/destroy **P1**
- [ ] Optional command consumer (`minicomputer.commands`) with `reply_to`/`correlation_id` **P2**
- [ ] Webhook sink as an alternative to AMQP **P2**

## Phase 7 — Security hardening

- [ ] Image allowlist, per-subject caps and limit ceilings from JWT claims **P0**
- [ ] Default `cap-drop=ALL`, `no-new-privileges`, seccomp profile **P0**
- [ ] cgroup limits: memory, swap, cpu, pids, io **P0**
- [ ] Disk quota enforcement **P1**
- [ ] `network: "none"` default option and per-container network selection **P1**
- [ ] Userns remapping when the active backend supports it **P1**
- [ ] Token revocation list (memory, Redis-backed when configured) **P1**
- [ ] Port nonces from a CSPRNG, constant-time lookup, indistinguishable `404`s **P0**
- [ ] Proxy hardening: no host port publishing, header injection stripping, request/response size caps **P1**
- [ ] Rate limiting per subject and per container **P1**
- [ ] Refuse to boot on weak/missing secret or dev-mode-in-production **P0**
- [ ] Audit log of every admin action with JWT subject **P1**
- [ ] Third-party security review before 1.0 **P1**

## Phase 8 — Reliability

- [ ] TTL reaper and idle reaper, including forwarded-port expiry **P1**
- [ ] Orphan reconciliation and re-adoption on orchestrator restart **P1**
- [ ] Client reconnect grace window with live-process re-attach **P1**
- [ ] Backpressure end to end (worker ring → orchestrator → slow WS client) with `stream.lagged` **P1**
- [ ] Graceful shutdown: drain sessions, stop accepting creates, optional container preservation **P1**
- [ ] `/health` and `/ready` probes with runtime connectivity checks **P0**
- [ ] Chaos tests: kill worker, kill orchestrator, kill broker, saturate stdout **P1**

## Phase 9 — Observability

- [ ] Structured JSON logging with scopes and request IDs **P0**
- [ ] Prometheus `/metrics`: containers by state, spawn latency, WS sessions, frame throughput, error rates **P1**
- [ ] OpenTelemetry traces across HTTP → orchestrator → worker **P2**
- [ ] Dev-mode protocol tracing and `/debug/*` routes, compiled out in production **P1**
- [ ] Grafana dashboard JSON in `examples/` **P2**

## Phase 10 — Testing & QA

- [ ] Rust unit tests: codec, sandboxing, archive extraction edge cases **P1**
- [ ] Orchestrator unit tests: auth, scopes, config validation **P1**
- [ ] Integration suite against a real Docker daemon in CI **P0**
- [ ] End-to-end: SDK → orchestrator → worker, covering every public method **P1**
- [ ] Load test: 100 concurrent containers, 1000 msg/s stdio **P1**
- [ ] Security tests: path traversal, zip-slip, token scope escalation, handshake spoofing from inside the container, nonce guessing and cross-container proxy access **P0**
- [ ] Backend conformance suite run against every driver in CI **P1**
- [ ] Coverage gate in CI **P2**

## Phase 11 — Packaging & docs

- [ ] Multi-arch orchestrator image on GHCR, worker binaries embedded **P0**
- [ ] `docker-compose.yml` examples: standalone, and with RabbitMQ **P1**
- [ ] Helm chart **P2**
- [ ] `@minicomputer/client` published to npm with provenance **P1**
- [ ] OpenAPI spec + generated HTTP reference **P1**
- [ ] Documented WebSocket and worker wire protocols (for third-party clients) **P1**
- [ ] Examples: web terminal, CI runner, AI agent sandbox, file-manager UI, live preview URLs **P1**
- [ ] Guide: writing a container backend driver **P1**
- [ ] Deployment guide for wildcard DNS + TLS in front of the proxy **P1**
- [ ] Migration/upgrade notes and a documented protocol version policy **P1**

## Phase 12 — 1.0 release gate

- [ ] Public API frozen; semver policy documented **P0**
- [ ] All P0 and P1 items above closed **P0**
- [ ] 48-hour soak test with no leaks in containers, FDs or memory **P0**
- [ ] Security review findings resolved **P0**
- [ ] Production deployment guide: reverse proxy, TLS, resource sizing, backups **P0**
- [ ] Changelog and signed release artifacts **P1**

---

## Beyond 1.0

- [ ] CRIU checkpoint/restore for zero-RAM `pause({ checkpoint: true })`
- [ ] Multi-node mode: Redis session and port registry, placement strategy, cross-node WS and proxy routing
- [ ] Firecracker / gVisor backend drivers for stronger isolation
- [ ] Container snapshots and clone-from-snapshot
- [ ] Persistent volumes surviving `destroy()`
- [ ] Python and Go client SDKs
- [ ] Raw TCP/UDP forwarding (SNI or per-port listeners) alongside the HTTP proxy
- [ ] BYO certificates per forwarded port
- [ ] Optional admin web UI

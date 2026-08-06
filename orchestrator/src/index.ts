import { createBackend } from "./backends/index.ts";
import { ContainerRegistry } from "./registry.ts";
import { createServer, listen } from "./server.ts";
import { PortRegistry } from "./ports.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const backend = createBackend(config.backend);
await backend.probe();
const registry = new ContainerRegistry(backend);
const ports = new PortRegistry({ domain: config.proxyDomain, scheme: "http", style: "flat", separator: "-", ttl: 3600000 });
const server = listen(createServer(registry, { secret: config.jwtSecret, ports }), config.port);
console.log(`Minicomputer listening on ${server.url}`);

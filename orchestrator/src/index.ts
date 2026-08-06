import { MockBackend } from "./backends/mock.ts";
import { ContainerRegistry } from "./registry.ts";
import { createServer, listen } from "./server.ts";

const backend = new MockBackend();
await backend.probe();
const registry = new ContainerRegistry(backend);
const server = listen(createServer(registry));
console.log(`Minicomputer listening on ${server.url}`);

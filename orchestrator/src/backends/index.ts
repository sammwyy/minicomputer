import { ApiError } from "../errors.ts";
import { MockBackend } from "./mock.ts";
import { DockerBackend } from "./docker.ts";
import type { ContainerBackend } from "../types.ts";

export function createBackend(name: string): ContainerBackend {
  if (name === "mock") return new MockBackend();
  if (name === "docker") return new DockerBackend();
  throw new ApiError(501, "BACKEND_UNSUPPORTED", `Backend is not implemented: ${name}`);
}

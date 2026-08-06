import { ApiError } from "../errors.ts";
import { MockBackend } from "./mock.ts";
import type { ContainerBackend } from "../types.ts";

export function createBackend(name: string): ContainerBackend {
  if (name === "mock") return new MockBackend();
  throw new ApiError(501, "BACKEND_UNSUPPORTED", `Backend is not implemented: ${name}`);
}

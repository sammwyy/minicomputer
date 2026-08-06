export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export function errorResponse(error: unknown): Response {
  const e = error instanceof ApiError ? error : new ApiError(500, "INTERNAL_ERROR", "Internal server error");
  return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status });
}

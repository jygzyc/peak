export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface ApiErrorBody { error: string }

export function requireDescription(value: unknown, label = "description"): string {
  if (typeof value !== "string" || value.trim() === "") throw new ApiError(400, `${label} is required`);
  const result = value.trim();
  if (Buffer.byteLength(result, "utf8") > 16 * 1024) throw new ApiError(400, `${label} exceeds 16 KiB`);
  return result;
}

export function requireUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError(400, "invalid project id");
  }
  return value;
}

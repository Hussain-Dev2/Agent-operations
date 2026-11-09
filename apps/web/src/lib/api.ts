import { z } from "zod";
import { ApiError } from "@operator/shared";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const Ok = z.object({ ok: z.literal(true) });

/** Calls the hub through the same-origin /api proxy and validates the response with Zod. */
export async function api<S extends z.ZodType = typeof Ok>(
  path: string,
  options: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; schema?: S } = {},
): Promise<z.output<S>> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: options.body === undefined ? {} : { "content-type": "application/json" },
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = ApiError.safeParse(json);
    throw new ApiRequestError(res.status, err.success ? err.data.error : "error", err.success ? err.data.message : res.statusText);
  }
  return (options.schema ?? Ok).parse(json) as z.output<S>;
}

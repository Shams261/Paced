/** Content-free request events for Workers Logs. Never add identifiers, query strings, headers or bodies. */
const ROUTES = new Set([
  "/api/health",
  "/api/auth/login",
  "/api/auth/callback",
  "/api/auth/session",
  "/api/auth/logout",
  "/api/v1/me",
  "/api/v1/management",
  "/api/v1/status",
  "/api/v1/export",
  "/api/v1/delete-workspace",
  "/api/v1/executors",
  "/api/executor/pair",
  "/api/executor/heartbeat",
  "/api/executor/watchlist",
  "/api/executor/observations",
]);
export interface RequestEvent {
  requestId: string;
  route: string;
  method: string;
  status: number;
  durationMs: number;
  sql: number;
  bytes: number;
}
const FIELDS: Record<keyof RequestEvent, "string" | "number"> = {
  requestId: "string",
  route: "string",
  method: "string",
  status: "number",
  durationMs: "number",
  sql: "number",
  bytes: "number",
};
const uuid = /^[0-9a-f-]{36}$/;
export function requestEvent(
  request: Request,
  response: Response,
  values: { started: number; queries: number; bytes: number },
): RequestEvent {
  const pathname = new URL(request.url).pathname;
  const id = response.headers.get("X-Request-ID") ?? "";
  return {
    requestId: uuid.test(id) ? id : "none",
    route: ROUTES.has(pathname) ? pathname : "other",
    method: /^[A-Z]{3,7}$/.test(request.method) ? request.method : "other",
    status: response.status,
    durationMs: Math.round(values.started * 10) / 10,
    sql: values.queries,
    bytes: values.bytes,
  };
}
/** Refuses any event that could carry content: unknown keys, wrong types, or free text. */
export function logEvent(
  event: RequestEvent,
  log: (line: string) => void = (line) => console.log(line),
): void {
  const keys = Object.keys(event) as (keyof RequestEvent)[];
  if (keys.length !== Object.keys(FIELDS).length)
    throw new Error("TELEMETRY_FIELDS");
  for (const key of keys) {
    const type = FIELDS[key];
    const value = event[key];
    if (!type || typeof value !== type) throw new Error("TELEMETRY_FIELDS");
    if (type === "string" && !/^[A-Za-z0-9/_-]{1,40}$/.test(value as string))
      throw new Error("TELEMETRY_CONTENT");
    if (type === "number" && !Number.isFinite(value))
      throw new Error("TELEMETRY_CONTENT");
  }
  log(JSON.stringify(event));
}

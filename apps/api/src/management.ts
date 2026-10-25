import {
  deleteWorkspaceSchema,
  managementRequestSchema,
} from "../../../packages/shell-contracts/src/management.js";
export { deleteWorkspaceSchema, managementRequestSchema };
export type ManagementFunction =
  "seq_manage" | "seq_export" | "seq_delete_workspace";
export interface ManagementGateway {
  /** Parsed `seq_manage` result. */
  call(token: string, operation: string, args: unknown): Promise<unknown>;
  /** Raw successful RPC response for streaming or route-level parsing. */
  invoke(
    token: string,
    fn: Exclude<ManagementFunction, "seq_manage">,
    args: Record<string, unknown>,
  ): Promise<Response>;
}
export class ManagementError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 409 | 503,
  ) {
    super(code);
  }
}
function failure(error: { code?: string } | null): ManagementError {
  switch (error?.code) {
    case "42501":
      return new ManagementError("ACCESS_DENIED", 403);
    case "28000":
      return new ManagementError("REAUTHENTICATION_REQUIRED", 403);
    case "23505":
    case "40001":
      return new ManagementError("REVISION_OR_REQUEST_CONFLICT", 409);
    case "22023":
      return new ManagementError("INVALID_MANAGEMENT_REQUEST", 400);
    case "53400":
      return new ManagementError("GROWTH_BLOCKED", 503);
    default:
      return new ManagementError("STORAGE_UNAVAILABLE", 503);
  }
}
export function managementGateway(
  base: string,
  key: string,
  send = fetch,
): ManagementGateway {
  async function rpc(fn: ManagementFunction, token: string, body: unknown) {
    const response = await send(`${base}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as {
        code?: string;
      } | null;
      throw failure(error);
    }
    return response;
  }
  return {
    async call(token, operation, args) {
      return (await rpc("seq_manage", token, { operation, args })).json();
    },
    invoke(token, fn, args) {
      return rpc(fn, token, args);
    },
  };
}

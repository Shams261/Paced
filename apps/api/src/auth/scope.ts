import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthControls, AuthDatabase } from "./store.js";
/**
 * The Hono application, provider and vault are built once per isolate. Only the
 * database connection is request-scoped; these proxies resolve it from the
 * current request's async context so cached code never shares a connection.
 */
export interface RequestConnection {
  database: AuthDatabase;
  controls: AuthControls;
}
const storage = new AsyncLocalStorage<RequestConnection>();
function current(): RequestConnection {
  const connection = storage.getStore();
  if (!connection) throw new Error("NO_REQUEST_CONNECTION");
  return connection;
}
export const scopedDatabase: AuthDatabase = {
  invoke: async (operation, args) => current().database.invoke(operation, args),
};
export const scopedControls: AuthControls = {
  rate: async (scope, hash) => current().controls.rate(scope, hash),
  event: async (reason, requestId) =>
    current().controls.event(reason, requestId),
  maintain: async () => current().controls.maintain(),
  usage: async (bytes) => current().controls.usage(bytes),
};
export function withConnection<T>(
  connection: RequestConnection,
  work: () => Promise<T>,
): Promise<T> {
  return storage.run(connection, work);
}

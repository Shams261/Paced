import { expect, it, vi } from "vitest";
import { countedResponse } from "./usage.js";
it("counts streamed bytes after the body ends and preserves status and headers", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("hello "));
      controller.enqueue(encoder.encode("world"));
      controller.close();
    },
  });
  const done = vi.fn();
  const response = countedResponse(
    new Response(body, { status: 201, headers: { "X-Test": "kept" } }),
    done,
  );
  expect(done).not.toHaveBeenCalled();
  expect(await response.text()).toBe("hello world");
  expect(done).toHaveBeenCalledWith(11);
  expect(response.status).toBe(201);
  expect(response.headers.get("X-Test")).toBe("kept");
});
it("reports zero at once for an empty body", () => {
  const done = vi.fn();
  countedResponse(new Response(null, { status: 303 }), done);
  expect(done).toHaveBeenCalledWith(0);
});

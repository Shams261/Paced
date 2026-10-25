/** Counts response bytes without buffering. `done` runs once the body ends, or at once for an empty body. */
export function countedResponse(
  response: Response,
  done: (bytes: number) => void,
): Response {
  if (!response.body) {
    done(0);
    return response;
  }
  let total = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush() {
      done(total);
    },
  });
  return new Response(response.body.pipeThrough(counter), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

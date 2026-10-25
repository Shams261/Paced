interface Context {
  request: Request;
  env: { AUTH_API: { fetch(request: Request): Promise<Response> } };
}
export async function onRequest({ request, env }: Context): Promise<Response> {
  const origin = "https://sequence-dev-etj.pages.dev";
  if (new URL(request.url).origin !== origin)
    return new Response("Origin denied", { status: 403 });
  const headers = new Headers(request.headers);
  // Overwrite user input with the edge's authenticated client-IP header.
  headers.delete("X-Sequence-Client-IP");
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) headers.set("X-Sequence-Client-IP", ip);
  try {
    return await env.AUTH_API.fetch(new Request(request, { headers }));
  } catch {
    return Response.json(
      { error: "AUTH_UNAVAILABLE" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

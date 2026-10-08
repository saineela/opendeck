/**
 * Web replacement for the desktop app's `tauriFetch` / Rust `proxy_http_request`
 * command.
 *
 * YouTube and several lyrics providers do not send CORS headers, so the
 * browser cannot call them directly. Every request made through this function
 * is forwarded by our backend (`POST /api/yt/proxy`), which enforces a host
 * allowlist and injects YouTube OAuth credentials server-side when the user
 * has linked their account.
 *
 * The exported API is intentionally identical to the original module
 * (`tauriFetch`, `getLiveCookie`, `setLiveCookie`) so the data sources,
 * artwork components and player UI reuse it unchanged. There are no cookies in
 * the web client — authentication lives in the httpOnly session cookie and
 * YouTube credentials live on the server.
 */

type ProxyHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body_base64: string;
};

type ProxyFetchInit = RequestInit & {
  timeoutMs?: number;
};

let liveCookie: string | null = null;

/** Kept for API parity with the desktop implementation; always null on web. */
export function getLiveCookie(): string | null {
  return liveCookie;
}

/** Kept for API parity with the desktop implementation; no-op on web. */
export function setLiveCookie(cookie: string | null): void {
  liveCookie = cookie;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function normalizeUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Headers the browser must never send to our proxy: cookies are our own
 * session credentials, and Authorization is decided server-side.
 */
const NEVER_FORWARD_HEADERS = new Set(["cookie", "authorization", "host", "content-length"]);

function collectHeaders(input: RequestInfo | URL, init?: ProxyFetchInit): Record<string, string> {
  let source: HeadersInit | undefined;
  if (init?.headers) source = init.headers;
  else if (typeof input !== "string" && !(input instanceof URL) && input.headers) {
    source = input.headers;
  }
  const headers: Record<string, string> = {};
  if (source) {
    new Headers(source).forEach((value, key) => {
      if (!NEVER_FORWARD_HEADERS.has(key.toLowerCase())) headers[key] = value;
    });
  }
  return headers;
}

async function buildBodyBase64(input: RequestInfo | URL, init?: ProxyFetchInit): Promise<string | undefined> {
  const body = init?.body;
  if (!body) {
    if (typeof input !== "string" && !(input instanceof URL) && input.body) {
      const buffer = await input.clone().arrayBuffer();
      return toBase64(new Uint8Array(buffer));
    }
    return undefined;
  }
  if (typeof body === "string") return toBase64(new TextEncoder().encode(body));
  if (body instanceof URLSearchParams) return toBase64(new TextEncoder().encode(body.toString()));
  if (body instanceof Uint8Array) return toBase64(body);
  if (body instanceof ArrayBuffer) return toBase64(new Uint8Array(body));
  if (body instanceof Blob) return toBase64(new Uint8Array(await body.arrayBuffer()));
  return undefined;
}

function base64ToUint8Array(base64: string): Uint8Array {
  try {
    return fromBase64(base64);
  } catch {
    return new TextEncoder().encode(base64);
  }
}

export async function tauriFetch(input: RequestInfo | URL, init?: ProxyFetchInit): Promise<Response> {
  const url = normalizeUrl(input);
  const method =
    init?.method ??
    (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET") ??
    "GET";
  const headers = collectHeaders(input, init);
  const bodyBase64 = await buildBodyBase64(input, init);

  let response: Response;
  try {
    response = await fetch("/api/yt/proxy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        method,
        headers,
        body_base64: bodyBase64,
        timeout_ms: init?.timeoutMs,
      }),
    });
  } catch (error) {
    // Network failure reaching our own backend — surface like the original did.
    throw error instanceof Error
      ? error
      : new Error("Unable to reach the application server.");
  }

  if (response.status === 204 || response.status === 205 || response.status === 304) {
    return new Response(null, { status: response.status });
  }

  const payload = (await response.json().catch(() => null)) as
    | (ProxyHttpResponse & { error?: string })
    | { error: string }
    | null;

  if (!payload || typeof payload !== "object" || !("status" in payload)) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `Proxy request failed with HTTP ${response.status}.`;
    return new Response(JSON.stringify({ error: message }), {
      status: response.status >= 400 ? response.status : 502,
      headers: { "content-type": "application/json" },
    });
  }

  if (!response.ok && !("body_base64" in payload)) {
    return new Response(
      JSON.stringify({ error: (payload as { error?: string }).error ?? "Proxy request failed." }),
      { status: response.status, headers: { "content-type": "application/json" } },
    );
  }

  const proxyResponse = payload as ProxyHttpResponse;
  const bodyBytes = base64ToUint8Array(proxyResponse.body_base64);
  return new Response(proxyResponse.status === 204 || proxyResponse.status === 304 ? null : bodyBytes, {
    status: proxyResponse.status,
    headers: proxyResponse.headers,
  });
}

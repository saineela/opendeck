/**
 * `fetch()` with redirect handling that never leaves a caller-supplied
 * allowlist. The built-in `redirect: "follow"` would happily hop from an
 * allowlisted host to an arbitrary one (SSRF via redirect), so redirects are
 * handled manually and every hop is re-validated.
 *
 * Redirect semantics mirror the fetch spec:
 *  - 303 → switch to GET, drop the body
 *  - 301/302 on POST → switch to GET, drop the body
 *  - 307/308 → preserve method and body
 */

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface AllowlistedFetchOptions {
  /** Returns true when the URL may be requested (protocol + host policy). */
  isAllowed: (url: URL) => boolean;
  /** Maximum redirect hops to follow (default 5). */
  maxRedirects?: number;
  /**
   * Recomputed for every hop from the original init, so hop-specific
   * credentials (e.g. an Authorization token scoped to one host) are never
   * carried across origins.
   */
  prepare?: (url: URL, init: RequestInit) => RequestInit;
}

export async function fetchAllowlisted(
  input: URL,
  init: RequestInit,
  options: AllowlistedFetchOptions,
): Promise<globalThis.Response> {
  const maxRedirects = options.maxRedirects ?? 5;
  const applyPrepare = options.prepare;
  let current = input;
  let currentInit = applyPrepare ? applyPrepare(current, init) : init;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // TLS is non-negotiable regardless of what the caller's predicate says.
    if (current.protocol !== "https:" || !options.isAllowed(current)) {
      throw new Error(`Blocked redirect target: ${current.protocol}//${current.hostname}`);
    }

    const response = await fetch(current, { ...currentInit, redirect: "manual" });
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return response;
    }

    // Release the redirect response body before moving on.
    try {
      await response.body?.cancel();
    } catch {
      // Body may already be consumed or unavailable.
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error(`Invalid redirect location: ${location}`);
    }

    const method = (currentInit.method ?? "GET").toUpperCase();
    const changesToGet =
      response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST");
    const base: RequestInit = changesToGet
      ? { ...init, method: "GET", body: undefined }
      : init;

    current = next;
    currentInit = applyPrepare ? applyPrepare(current, base) : base;
  }

  throw new Error(`Too many redirects (limit ${maxRedirects}).`);
}

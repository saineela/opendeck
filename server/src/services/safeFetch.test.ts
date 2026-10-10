import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAllowlisted } from "./safeFetch.js";

const isAllowed = (url: URL): boolean =>
  url.hostname === "allowed.test" || url.hostname.endsWith(".allowed.test");

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : "", { status, headers });
}

describe("fetchAllowlisted", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes a non-redirect response straight through", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchAllowlisted(
      new URL("https://allowed.test/x"),
      { method: "GET" },
      { isAllowed },
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("follows redirects while every hop stays allowlisted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(302, { location: "https://cdn.allowed.test/y" }))
      .mockResolvedValueOnce(response(200));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchAllowlisted(
      new URL("https://allowed.test/x"),
      { method: "GET" },
      { isAllowed },
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://cdn.allowed.test/y");
  });

  it("blocks a redirect that leaves the allowlist before requesting it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response(302, { location: "https://evil.example/steal" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchAllowlisted(new URL("https://allowed.test/x"), { method: "GET" }, { isAllowed }),
    ).rejects.toThrow(/Blocked redirect target/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks plain-http redirect targets even from an allowed host", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response(302, { location: "http://allowed.test/internal" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchAllowlisted(new URL("https://allowed.test/x"), { method: "GET" }, { isAllowed }),
    ).rejects.toThrow(/Blocked redirect target/);
  });

  it("recomputes hop credentials from the base init and honors 303 → GET", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(303, { location: "https://other.allowed.test/y" }))
      .mockResolvedValueOnce(response(200));
    vi.stubGlobal("fetch", fetchMock);

    const prepare = vi.fn((url: URL, init: RequestInit): RequestInit =>
      url.hostname === "allowed.test"
        ? {
            ...init,
            headers: {
              ...(init.headers as Record<string, string> | undefined),
              authorization: "Bearer secret",
            },
          }
        : init,
    );

    await fetchAllowlisted(
      new URL("https://allowed.test/x"),
      { method: "POST", body: "payload", headers: {} },
      { isAllowed, prepare },
    );

    expect(prepare).toHaveBeenCalledTimes(2);
    const secondCall = fetchMock.mock.calls[1][1] as RequestInit;
    expect(secondCall.method).toBe("GET");
    expect(secondCall.body).toBeUndefined();
    expect((secondCall.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("caps redirect chains", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => response(302, { location: "https://allowed.test/loop" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchAllowlisted(
        new URL("https://allowed.test/x"),
        { method: "GET" },
        { isAllowed, maxRedirects: 3 },
      ),
    ).rejects.toThrow(/Too many redirects/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

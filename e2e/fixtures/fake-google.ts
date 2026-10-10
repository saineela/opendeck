/**
 * Standalone fake Google OpenID provider for Playwright E2E runs.
 *
 * Implements just enough of the spec for the app's authorization-code + PKCE
 * flow: discovery, JWKS, an auto-approving /authorize endpoint, and a /token
 * endpoint that enforces PKCE (S256) before minting an RS256 id_token.
 *
 * Started by playwright.config.ts on PORT (default 4310). The app under test
 * points GOOGLE_OPENID_DISCOVERY at this server.
 */
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, importPKCS8 } from "jose";

const PORT = Number(process.env.PORT ?? 4310);
const CLIENT_ID = process.env.E2E_GOOGLE_CLIENT_ID ?? "e2e-client-id";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const privateJwk = { ...privateKey.export({ format: "jwk" }), alg: "RS256", kid: "e2e-key" };
const publicJwk = {
  ...publicKey.export({ format: "jwk" }),
  use: "sig",
  alg: "RS256",
  kid: "e2e-key",
};

interface PendingCode {
  challenge: string;
  redirectUri: string;
}

/** code → PKCE challenge captured at /authorize. */
const codes = new Map<string, PendingCode>();
/** Exposed so a test could inspect token traffic if needed. */
const tokenRequests: Array<Record<string, string>> = [];

let origin = "";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", origin || "http://127.0.0.1:0");
    const pathname = url.pathname;

    if (pathname === "/.well-known/openid-configuration") {
      sendJson(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        jwks_uri: `${origin}/jwks`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        id_token_signing_alg_values_supported: ["RS256"],
        scopes_supported: ["openid", "email", "profile"],
      });
      return;
    }

    if (pathname === "/jwks") {
      sendJson(res, 200, { keys: [publicJwk] });
      return;
    }

    // Auto-approving consent: immediately bounce back to the app's callback
    // with a fresh code bound to the PKCE challenge we were handed.
    if (pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      const method = url.searchParams.get("code_challenge_method");
      if (!redirectUri || !state || !challenge || method !== "S256") {
        sendJson(res, 400, { error: "invalid_request" });
        return;
      }
      const code = crypto.randomBytes(24).toString("base64url");
      codes.set(code, { challenge, redirectUri });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", state);
      res.writeHead(302, { location: back.toString() });
      res.end();
      return;
    }

    if (pathname === "/token") {
      const params = new URLSearchParams(await readBody(req));
      tokenRequests.push(Object.fromEntries(params));

      if (params.get("grant_type") !== "authorization_code") {
        sendJson(res, 400, { error: "unsupported_grant_type" });
        return;
      }
      if (params.get("client_id") !== CLIENT_ID) {
        sendJson(res, 400, { error: "invalid_client" });
        return;
      }
      const code = params.get("code") ?? "";
      const pending = codes.get(code);
      if (!pending) {
        sendJson(res, 400, { error: "invalid_grant", error_description: "unknown code" });
        return;
      }
      if (params.get("redirect_uri") !== pending.redirectUri) {
        sendJson(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
        return;
      }
      const verifier = params.get("code_verifier") ?? "";
      const derived = crypto.createHash("sha256").update(verifier).digest("base64url");
      if (derived !== pending.challenge) {
        sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE failed" });
        return;
      }
      codes.delete(code);

      const signingKey = await importPKCS8(
        privateKey.export({ format: "pem", type: "pkcs8" }) as string,
        "RS256",
      );
      const idToken = await new SignJWT({
        name: "E2E Tester",
        email: "e2e@example.com",
        picture: "https://example.com/avatar.png",
      })
        .setProtectedHeader({ alg: "RS256", kid: "e2e-key" })
        .setSubject("e2e-google-sub-1")
        .setIssuer(origin)
        .setAudience(CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(signingKey);

      sendJson(res, 200, {
        access_token: "ya29.e2e-access",
        id_token: idToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid email profile",
      });
      return;
    }

    if (pathname === "/reset") {
      codes.clear();
      tokenRequests.length = 0;
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  })().catch((error) => {
    sendJson(res, 500, { error: String(error) });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  // eslint-disable-next-line no-console
  console.log(`[fake-google] listening on ${origin} (client_id=${CLIENT_ID})`);
});

// Keep the process alive; Playwright manages shutdown.
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Env {
  DATABASE_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_ORG: string;
  JWT_SECRET: string;
  SERVER_URL: string;
  AUTH_KV: AuthStore;
}

export interface AuthStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface PendingCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  githubUsername: string;
}

interface PendingAuthorization {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  oauthState?: string;
}

interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  client_name?: string;
}

// ---------------------------------------------------------------------------
// JWT helpers (Web Crypto — no jose needed)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return base64url(digest);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function base64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signJwt(payload: Record<string, unknown>, secret: string, expiresInSec: number): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = { ...payload, iat: now, exp: now + expiresInSec };
  const segments = base64url(encoder.encode(JSON.stringify(header))) + "." + base64url(encoder.encode(JSON.stringify(claims)));
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(segments));
  return segments + "." + base64url(sig);
}

export async function verifyJwt(token: string, secret: string): Promise<Record<string, unknown>> {
  const [headerB64, payloadB64, sigB64] = token.split(".");
  if (!headerB64 || !payloadB64 || !sigB64) throw new Error("Invalid JWT");
  const key = await importKey(secret);
  const sigBytes = base64urlDecode(sigB64);
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes.buffer.slice(sigBytes.byteOffset, sigBytes.byteOffset + sigBytes.byteLength) as ArrayBuffer, encoder.encode(`${headerB64}.${payloadB64}`));
  if (!valid) throw new Error("Invalid JWT signature");
  const payload = JSON.parse(decoder.decode(base64urlDecode(payloadB64))) as Record<string, unknown>;
  if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Token expired");
  return payload;
}

// ---------------------------------------------------------------------------
// Random hex
// ---------------------------------------------------------------------------

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isValidPkceVerifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

function isValidPkceChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

function isValidRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hash === "";
  } catch {
    return false;
  }
}

function parseRedirectUris(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((uri): uri is string => typeof uri === "string" && isValidRedirectUri(uri));
}

function isRegisteredRedirect(client: RegisteredClient, redirectUri: string): boolean {
  return client.redirect_uris.includes(redirectUri);
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function exchangeGitHubCode(code: string, env: Env): Promise<{ access_token: string }> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
  });
  const data = (await res.json()) as Record<string, string>;
  if (data.error) throw new Error(`GitHub token error: ${data.error_description || data.error}`);
  return { access_token: data.access_token };
}

async function fetchGitHubUser(token: string): Promise<{ login: string; id: number }> {
  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "openwhispr-mcp" },
  });
  if (!res.ok) throw new Error("Failed to fetch GitHub user");
  return res.json() as Promise<{ login: string; id: number }>;
}

async function checkOrgMembership(token: string, org: string): Promise<boolean> {
  const res = await fetch("https://api.github.com/user/orgs", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "openwhispr-mcp" },
  });
  if (!res.ok) return false;
  const orgs = (await res.json()) as Array<{ login: string }>;
  return orgs.some((o) => o.login.toLowerCase() === org.toLowerCase());
}

// ---------------------------------------------------------------------------
// KV-backed stores
// ---------------------------------------------------------------------------

const CODE_TTL = 300; // 5 minutes
const CLIENT_TTL = 60 * 60 * 24 * 365; // 1 year
const REVOKE_TTL = 60 * 60 * 24 * 2; // 2 days

async function storePendingCode(kv: AuthStore, code: string, data: PendingCode): Promise<void> {
  await kv.put(`code:${code}`, JSON.stringify(data), { expirationTtl: CODE_TTL });
}

async function getPendingCode(kv: AuthStore, code: string): Promise<PendingCode | null> {
  const raw = await kv.get(`code:${code}`);
  if (!raw) return null;
  await kv.delete(`code:${code}`);
  return JSON.parse(raw) as PendingCode;
}

async function storePendingAuthorization(kv: AuthStore, state: string, data: PendingAuthorization): Promise<void> {
  await kv.put(`oauth_state:${state}`, JSON.stringify(data), { expirationTtl: CODE_TTL });
}

async function getPendingAuthorization(kv: AuthStore, state: string): Promise<PendingAuthorization | null> {
  const raw = await kv.get(`oauth_state:${state}`);
  if (!raw) return null;
  await kv.delete(`oauth_state:${state}`);
  return JSON.parse(raw) as PendingAuthorization;
}

async function storeClient(kv: AuthStore, client: RegisteredClient): Promise<void> {
  await kv.put(`client:${client.client_id}`, JSON.stringify(client), { expirationTtl: CLIENT_TTL });
}

async function getClient(kv: AuthStore, clientId: string): Promise<RegisteredClient | null> {
  const raw = await kv.get(`client:${clientId}`);
  return raw ? (JSON.parse(raw) as RegisteredClient) : null;
}

async function revokeToken(kv: AuthStore, token: string): Promise<void> {
  await kv.put(`revoked:${token}`, "1", { expirationTtl: REVOKE_TTL });
}

async function isRevoked(kv: AuthStore, token: string): Promise<boolean> {
  return (await kv.get(`revoked:${token}`)) !== null;
}

// ---------------------------------------------------------------------------
// Bearer auth verification
// ---------------------------------------------------------------------------

export async function verifyAccessToken(token: string, env: Env): Promise<AuthInfo> {
  if (await isRevoked(env.AUTH_KV, token)) throw new Error("Token revoked");
  const payload = await verifyJwt(token, env.JWT_SECRET);
  return {
    token,
    clientId: (payload.clientId as string) || "unknown",
    scopes: [],
    expiresAt: payload.exp as number | undefined,
    extra: { githubUsername: payload.sub },
  };
}

// ---------------------------------------------------------------------------
// OAuth endpoint handlers
// ---------------------------------------------------------------------------

/** GET /authorize — redirect to GitHub OAuth */
export async function handleAuthorize(url: URL, env: Env): Promise<Response> {
  const responseType = url.searchParams.get("response_type") || "";
  const clientId = url.searchParams.get("client_id") || "";
  const redirectUri = url.searchParams.get("redirect_uri") || "";
  const codeChallenge = url.searchParams.get("code_challenge") || "";
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "";
  const state = url.searchParams.get("state") || "";

  if (responseType !== "code") {
    return Response.json({ error: "unsupported_response_type" }, { status: 400 });
  }

  const client = await getClient(env.AUTH_KV, clientId);
  if (!client || !isRegisteredRedirect(client, redirectUri)) {
    return Response.json({ error: "invalid_request", error_description: "Unknown client or redirect_uri" }, { status: 400 });
  }

  if (!state) {
    return Response.json({ error: "invalid_request", error_description: "state is required" }, { status: 400 });
  }

  if (!isValidPkceChallenge(codeChallenge) || codeChallengeMethod !== "S256") {
    return Response.json({ error: "invalid_request", error_description: "S256 PKCE is required" }, { status: 400 });
  }

  const ghState = randomHex(32);
  await storePendingAuthorization(env.AUTH_KV, ghState, {
    clientId,
    codeChallenge,
    redirectUri,
    oauthState: state || undefined,
  });

  const ghParams = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${env.SERVER_URL}/github/callback`,
    scope: "read:org read:user",
    state: ghState,
  });

  return Response.redirect(`https://github.com/login/oauth/authorize?${ghParams}`, 302);
}

/** GET /github/callback — GitHub redirects here after user authorizes */
export async function handleGitHubCallback(url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  if (!code || !stateParam) return new Response("Missing code or state", { status: 400 });

  try {
    const pendingAuthorization = await getPendingAuthorization(env.AUTH_KV, stateParam);
    if (!pendingAuthorization) return new Response("Invalid state", { status: 400 });

    const { access_token: ghToken } = await exchangeGitHubCode(code, env);
    const ghUser = await fetchGitHubUser(ghToken);
    const isMember = await checkOrgMembership(ghToken, env.GITHUB_ORG);

    if (!isMember) {
      const errorUrl = new URL(pendingAuthorization.redirectUri);
      errorUrl.searchParams.set("error", "access_denied");
      errorUrl.searchParams.set("error_description", `You must be a member of the ${env.GITHUB_ORG} GitHub organization`);
      if (pendingAuthorization.oauthState) errorUrl.searchParams.set("state", pendingAuthorization.oauthState);
      return Response.redirect(errorUrl.toString(), 302);
    }

    const authCode = randomHex(32);
    await storePendingCode(env.AUTH_KV, authCode, {
      clientId: pendingAuthorization.clientId,
      codeChallenge: pendingAuthorization.codeChallenge,
      redirectUri: pendingAuthorization.redirectUri,
      githubUsername: ghUser.login,
    });

    const redirectUrl = new URL(pendingAuthorization.redirectUri);
    redirectUrl.searchParams.set("code", authCode);
    if (pendingAuthorization.oauthState) redirectUrl.searchParams.set("state", pendingAuthorization.oauthState);
    return Response.redirect(redirectUrl.toString(), 302);
  } catch (err) {
    console.error("GitHub callback error:", err);
    return new Response("Authentication failed", { status: 500 });
  }
}

/** POST /token — exchange auth code for JWT access token */
export async function handleToken(request: Request, env: Env): Promise<Response> {
  const body = await request.formData().catch(() => null);
  const grantType = body?.get("grant_type") as string | null;
  const code = body?.get("code") as string | null;
  const clientId = body?.get("client_id") as string | null;
  const redirectUri = body?.get("redirect_uri") as string | null;
  const codeVerifier = body?.get("code_verifier") as string | null;

  if (grantType !== "authorization_code" || !code) {
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  const pending = await getPendingCode(env.AUTH_KV, code);
  if (!pending) {
    return Response.json({ error: "invalid_grant", error_description: "Unknown or expired code" }, { status: 400 });
  }

  const client = await getClient(env.AUTH_KV, pending.clientId);
  if (!client || clientId !== pending.clientId || redirectUri !== pending.redirectUri || !isRegisteredRedirect(client, redirectUri)) {
    return Response.json({ error: "invalid_grant", error_description: "Client or redirect_uri mismatch" }, { status: 400 });
  }

  if (!codeVerifier || !isValidPkceVerifier(codeVerifier)) {
    return Response.json({ error: "invalid_grant", error_description: "Invalid code_verifier" }, { status: 400 });
  }

  const computedChallenge = await sha256Base64url(codeVerifier);
  if (!constantTimeEqual(computedChallenge, pending.codeChallenge)) {
    return Response.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, { status: 400 });
  }

  const expiresIn = 60 * 60 * 24; // 24h
  const accessToken = await signJwt({ sub: pending.githubUsername, clientId: pending.clientId }, env.JWT_SECRET, expiresIn);

  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: expiresIn,
  });
}

/** POST /register — dynamic client registration */
export async function handleRegister(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const redirectUris = parseRedirectUris(body.redirect_uris);
  if (redirectUris.length === 0) {
    return Response.json({ error: "invalid_client_metadata", error_description: "redirect_uris is required" }, { status: 400 });
  }

  const clientId = crypto.randomUUID();
  const clientSecret = randomHex(32);
  const client: RegisteredClient = {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: redirectUris,
    client_name: (body.client_name as string) || undefined,
  };
  await storeClient(env.AUTH_KV, client);
  return Response.json({ ...client, client_id_issued_at: Math.floor(Date.now() / 1000) }, { status: 201 });
}

/** POST /revoke — revoke a token */
export async function handleRevoke(request: Request, env: Env): Promise<Response> {
  const body = await request.formData().catch(() => null);
  const token = body?.get("token") as string | null;
  if (token) await revokeToken(env.AUTH_KV, token);
  return new Response(null, { status: 200 });
}

/** GET /.well-known/oauth-authorization-server — metadata discovery */
export function handleMetadata(env: Env): Response {
  return Response.json({
    issuer: env.SERVER_URL,
    authorization_endpoint: `${env.SERVER_URL}/authorize`,
    token_endpoint: `${env.SERVER_URL}/token`,
    registration_endpoint: `${env.SERVER_URL}/register`,
    revocation_endpoint: `${env.SERVER_URL}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    code_challenge_methods_supported: ["S256"],
  });
}

/** GET /.well-known/oauth-protected-resource — PRM */
export function handleResourceMetadata(env: Env): Response {
  return Response.json({
    resource: `${env.SERVER_URL}/mcp`,
    authorization_servers: [env.SERVER_URL],
  });
}

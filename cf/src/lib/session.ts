/**
 * Wallet auth for the Workers runtime.
 *
 * The Express server kept `authChallenges` and `authSessions` in module-level Maps
 * (server/src/index.ts:76-77). Workers isolates are created and destroyed per request and never
 * share memory, so that design would sign a user in and lose them on the next request.
 *
 * Both artefacts are therefore self-describing and HMAC-signed instead of stored:
 *
 *   challenge = base64url(payload) "." base64url(HMAC(payload))
 *   session   = base64url(payload) "." base64url(HMAC(payload))
 *
 * The server can validate either without holding state. Challenges additionally record their
 * nonce in D1 on redemption, so a captured challenge cannot be replayed inside its validity
 * window — stateless signing alone cannot give single-use semantics.
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = "judgebuddy_session";

export type AuthChallengePayload = {
  challengeId: string;
  nonce: string;
  accountId: string;
  evmAddress: string;
  issuedAt: string;
  expiresAt: string;
};

export type SessionPayload = {
  accountId: string;
  evmAddress: string;
  walletSource: "metamask";
  network: "testnet" | "mainnet";
  exp: number;
};

// ── encoding ────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Constant-time compare, so signature verification does not leak via timing. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sign<T>(payload: T, secret: string): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

async function verify<T>(token: string, secret: string): Promise<T | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;

  let expected: ArrayBuffer;
  try {
    expected = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  } catch {
    return null;
  }

  let provided: Uint8Array;
  try {
    provided = fromBase64Url(signature);
  } catch {
    return null;
  }

  if (!timingSafeEqual(new Uint8Array(expected), provided)) return null;

  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as T;
  } catch {
    return null;
  }
}

// ── challenges ──────────────────────────────────────────────────────────────

export async function issueChallenge(
  input: { accountId: string; evmAddress: string },
  secret: string,
): Promise<{ token: string; payload: AuthChallengePayload }> {
  const now = Date.now();
  const payload: AuthChallengePayload = {
    challengeId: crypto.randomUUID(),
    nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(24))),
    accountId: input.accountId,
    evmAddress: input.evmAddress.toLowerCase(),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString(),
  };
  return { token: await sign(payload, secret), payload };
}

export async function readChallenge(token: string, secret: string): Promise<AuthChallengePayload | null> {
  const payload = await verify<AuthChallengePayload>(token, secret);
  if (!payload) return null;
  if (Date.parse(payload.expiresAt) < Date.now()) return null;
  return payload;
}

/**
 * Burns a nonce so a captured challenge cannot be redeemed twice.
 * Returns false when the nonce was already used.
 */
export async function consumeNonce(db: D1Database, payload: AuthChallengePayload): Promise<boolean> {
  try {
    await db
      .prepare("INSERT INTO auth_used_nonces (nonce, account_id, expires_at) VALUES (?, ?, ?)")
      .bind(payload.nonce, payload.accountId, payload.expiresAt)
      .run();
    return true;
  } catch {
    // UNIQUE violation — already redeemed.
    return false;
  }
}

/** Drops expired nonce records. Called from the cron handler. */
export async function pruneNonces(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM auth_used_nonces WHERE expires_at < ?").bind(new Date().toISOString()).run();
}

// ── sessions ────────────────────────────────────────────────────────────────

export async function issueSession(
  user: Omit<SessionPayload, "exp">,
  secret: string,
): Promise<string> {
  return sign<SessionPayload>({ ...user, exp: Date.now() + SESSION_TTL_MS }, secret);
}

export async function readSession(token: string | null, secret: string): Promise<SessionPayload | null> {
  if (!token) return null;
  const payload = await verify<SessionPayload>(token, secret);
  if (!payload) return null;
  if (payload.exp < Date.now()) return null;
  return payload;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function sessionCookie(value: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

export const SESSION_MAX_AGE = Math.floor(SESSION_TTL_MS / 1000);

/**
 * The message the wallet is asked to sign. Must stay byte-identical to
 * packages/shared/src/auth.ts buildAuthSignedMessage — the frontend builds the same string and
 * any drift makes every signature fail to recover.
 */
export function buildSignedMessage(payload: AuthChallengePayload, network: string, walletSource: string): string {
  return [
    "JudgeBuddy treasury sign-in",
    "",
    `Account: ${payload.accountId}`,
    `Wallet: ${walletSource}`,
    `Network: ${network}`,
    `EVM Address: ${payload.evmAddress}`,
    `Challenge ID: ${payload.challengeId}`,
    `Nonce: ${payload.nonce}`,
    `Issued At: ${payload.issuedAt}`,
    `Expires At: ${payload.expiresAt}`,
    "",
  ].join("\n");
}

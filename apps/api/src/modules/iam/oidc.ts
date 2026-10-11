/**
 * The OpenID Connect side of single sign-on, as a confidential client using
 * the authorization code flow with PKCE (RFC 6749, RFC 7636, OIDC Core 1.0):
 *
 *   discover()          the provider's endpoints, from its discovery document
 *   authorizationUrl()  where the browser goes to sign in
 *   exchangeCode()      the code the browser brings back → an ID token
 *   verifyIdToken()     signature (the provider's published keys), issuer,
 *                       audience, expiry; the caller checks the nonce
 *
 * Protocol only: what a sign-in means for accounts is in sso.ts. Every
 * failure is an OidcError whose message is written for the admin setting the
 * connection up (the test sign-in shows it); people signing in see a shorter one.
 */

import type { JWTPayload } from 'jose';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import { randomToken, sha256 } from '#/libs/crypto';

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const DISCOVERY_CACHE_MS = 5 * 60_000;
/** Seconds of clock difference allowed between us and the provider. */
const CLOCK_TOLERANCE = 60;
/** Only signatures with the provider's private key; never `none` or a shared-secret HMAC. */
const ASYMMETRIC_ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

export class OidcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OidcError';
  }
}

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  id_token_signing_alg_values_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https, or http to this machine only (a provider run locally for development and tests). */
function isAllowedUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
}

/** The issuer as entered, tidied: no trailing slash. Null when it is not a usable URL. */
export function normalizeIssuer(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!isAllowedUrl(trimmed)) return null;
  const url = new URL(trimmed);
  return url.search || url.hash || url.username || url.password ? null : trimmed;
}

/** `body` is null when the answer is not JSON (an error page, usually); the caller decides what that means. */
async function fetchJson(url: string, init: RequestInit, what: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  let res: Response;
  try {
    // No redirects: an endpoint that moves is a configuration to fix, not to follow.
    res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'it did not answer within 10 seconds' : 'it could not be reached';
    throw new OidcError(`Couldn't get the ${what} from ${new URL(url).host}: ${reason}.`);
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new OidcError(`The ${what} from ${new URL(url).host} is too large.`);
  try {
    return { ok: res.ok, status: res.status, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: res.ok, status: res.status, body: null };
  }
}

const discoveryCache = new Map<string, { doc: Discovery; until: number }>();

/** The provider's discovery document, checked, and cached for a few minutes. */
export async function discover(issuer: string, opts: { fresh?: boolean } = {}): Promise<Discovery> {
  const cached = discoveryCache.get(issuer);
  if (!opts.fresh && cached && cached.until > Date.now()) return cached.doc;

  const { ok, status, body } = await fetchJson(`${issuer}/.well-known/openid-configuration`, {}, 'discovery document');
  if (!ok) throw new OidcError(`The discovery document at ${issuer}/.well-known/openid-configuration answered HTTP ${status}. Check the issuer URL.`);
  if (body === null || typeof body !== 'object') throw new OidcError(`The discovery document at ${issuer}/.well-known/openid-configuration is not JSON.`);
  const doc = body as Partial<Discovery> & { response_types_supported?: string[] };

  // OIDC Discovery §4.3: the document must name exactly the issuer it was fetched for.
  if (doc.issuer !== issuer) {
    throw new OidcError(
      `The provider calls itself "${String(doc.issuer)}", not "${issuer}". Use exactly that issuer URL (for Microsoft Entra, the one with your tenant ID, not "common").`,
    );
  }
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (typeof doc[key] !== 'string' || !isAllowedUrl(doc[key])) {
      throw new OidcError(`The discovery document has no usable ${key}.`);
    }
  }
  if (doc.response_types_supported && !doc.response_types_supported.includes('code')) {
    throw new OidcError('The provider does not offer the authorization code flow.');
  }
  if (doc.code_challenge_methods_supported && !doc.code_challenge_methods_supported.includes('S256')) {
    throw new OidcError('The provider does not support PKCE with S256.');
  }
  if (signingAlgs(doc as Discovery).length === 0) {
    throw new OidcError('The provider signs ID tokens only with algorithms we do not accept (we need RS256, ES256 or similar).');
  }
  const checked = doc as Discovery;
  if (discoveryCache.size > 100) discoveryCache.clear();
  discoveryCache.set(issuer, { doc: checked, until: Date.now() + DISCOVERY_CACHE_MS });
  return checked;
}

function signingAlgs(doc: Discovery): string[] {
  // OIDC Discovery: RS256 must be supported when nothing is listed.
  return (doc.id_token_signing_alg_values_supported ?? ['RS256']).filter((alg) => ASYMMETRIC_ALGS.includes(alg));
}

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

/** PKCE (RFC 7636): the verifier stays with us; the challenge goes to the provider. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32);
  return { verifier, challenge: base64url(await sha256(verifier)) };
}

export function authorizationUrl(
  doc: Discovery,
  p: { clientId: string; redirectUri: string; state: string; nonce: string; codeChallenge: string; loginHint?: string },
): string {
  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', p.state);
  url.searchParams.set('nonce', p.nonce);
  url.searchParams.set('code_challenge', p.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (p.loginHint) url.searchParams.set('login_hint', p.loginHint);
  return url.toString();
}

/** The code the browser brought back, swapped for an ID token at the token endpoint. */
export async function exchangeCode(
  doc: Discovery,
  p: { clientId: string; clientSecret: string; code: string; redirectUri: string; codeVerifier: string },
): Promise<string> {
  const methods = doc.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.codeVerifier,
    client_id: p.clientId,
  });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (methods.includes('client_secret_basic')) {
    // RFC 6749 §2.3.1: each part form-encoded before joining.
    const encode = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
    headers.authorization = `Basic ${Buffer.from(`${encode(p.clientId)}:${encode(p.clientSecret)}`).toString('base64')}`;
  } else if (methods.includes('client_secret_post')) {
    body.set('client_secret', p.clientSecret);
  } else {
    throw new OidcError('The provider accepts no client authentication we support (client_secret_basic or client_secret_post).');
  }

  const { ok, status, body: answer } = await fetchJson(doc.token_endpoint, { method: 'POST', headers, body }, 'token response');
  const reply = (answer ?? {}) as { id_token?: unknown; error?: unknown; error_description?: unknown };
  if (!ok) {
    const detail = [reply.error, reply.error_description].filter((v) => typeof v === 'string').join(': ').slice(0, 300);
    throw new OidcError(
      `The provider refused the sign-in code (HTTP ${status}${detail ? `, ${detail}` : ''}). Check the client ID, the client secret and the redirect URL.`,
    );
  }
  if (typeof reply.id_token !== 'string') throw new OidcError('The provider sent no ID token. Is the "openid" scope allowed for this app?');
  return reply.id_token;
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** The provider's public keys; jose caches them and fetches again when a new key id appears. */
function keySet(jwksUri: string) {
  let set = keySets.get(jwksUri);
  if (!set) {
    if (keySets.size > 100) keySets.clear();
    set = createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: TIMEOUT_MS });
    keySets.set(jwksUri, set);
  }
  return set;
}

export interface IdTokenClaims {
  /** Stable and unique at this provider: what identities are matched by. */
  sub: string;
  /** Lowercased; null when the provider sent none. */
  email: string | null;
  /** Null when the provider does not say (Microsoft Entra, for one). */
  email_verified: boolean | null;
  name: string | null;
  /** For the caller to compare with the one it sent. */
  nonce: string;
}

function asBoolean(value: unknown): boolean | null {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

function asText(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

/** Checks the ID token (OIDC Core §3.1.3.7) and reads what we use from it. */
export async function verifyIdToken(doc: Discovery, idToken: string, clientId: string): Promise<IdTokenClaims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, keySet(doc.jwks_uri), {
      issuer: doc.issuer,
      audience: clientId,
      algorithms: signingAlgs(doc),
      clockTolerance: CLOCK_TOLERANCE,
      requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
    }));
  } catch (err) {
    throw new OidcError(`The ID token did not check out: ${err instanceof Error ? err.message : 'invalid'}.`);
  }
  // Several audiences: the token must say it was issued to us (azp).
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if ((audiences.length > 1 || payload.azp !== undefined) && payload.azp !== clientId) {
    throw new OidcError('The ID token was issued to another app (azp).');
  }
  const sub = asText(payload.sub, 255);
  const nonce = asText(payload.nonce, 255);
  if (!sub || !nonce) throw new OidcError('The ID token has no subject or nonce.');

  const email = asText(payload.email, 254)?.toLowerCase() ?? null;
  const given = [asText(payload.given_name), asText(payload.family_name)].filter(Boolean).join(' ');
  return {
    sub,
    email: email && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null,
    email_verified: asBoolean(payload.email_verified),
    name: asText(payload.name, 100) ?? (given ? given.slice(0, 100) : null),
    nonce,
  };
}

/** Tests only. */
export function forgetProviders() {
  discoveryCache.clear();
  keySets.clear();
}

/**
 * A small OpenID Connect provider for the SSO tests, on a random local port.
 * It plays the provider faithfully (discovery, keys, the code exchange with
 * PKCE and client authentication) and can be told to misbehave, so the
 * checks on our side are seen to fail closed.
 */

import { createHash } from 'node:crypto';

import type { JWTPayload } from 'jose';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export const CLIENT_ID = 'app-under-test';
export const CLIENT_SECRET = 'fake-idp-client-secret';

export interface Person {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

/** Ways to get the ID token wrong. */
export type Trick = 'wrong_key' | 'wrong_audience' | 'wrong_issuer' | 'wrong_nonce' | 'expired' | 'hs256' | 'no_id_token';

interface PendingCode {
  person: Person;
  clientId: string;
  redirectUri: string;
  nonce: string;
  codeChallenge: string;
  trick?: Trick;
}

export async function startFakeIdp() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const stranger = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'key-1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, PendingCode>();
  let tokenRequests = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const issuer = `http://localhost:${url.port}`;
      if (url.pathname === '/.well-known/openid-configuration') {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (url.pathname === '/jwks') return Response.json({ keys: [jwk] });
      if (url.pathname === '/token' && req.method === 'POST') {
        tokenRequests++;
        const form = new URLSearchParams(await req.text());
        const basic = req.headers.get('authorization')?.replace(/^Basic /, '') ?? '';
        const [id, secret] = Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent);
        if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return Response.json({ error: 'invalid_client' }, { status: 401 });
        const pending = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (!pending || form.get('grant_type') !== 'authorization_code' || form.get('redirect_uri') !== pending.redirectUri) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (challenge !== pending.codeChallenge) return Response.json({ error: 'invalid_grant', error_description: 'PKCE' }, { status: 400 });
        if (pending.trick === 'no_id_token') return Response.json({ access_token: 'x', token_type: 'Bearer' });
        return Response.json({ access_token: 'x', token_type: 'Bearer', id_token: await idToken(issuer, pending) });
      }
      return new Response('not found', { status: 404 });
    },
  });

  async function idToken(issuer: string, p: PendingCode): Promise<string> {
    const claims: JWTPayload = {
      ...p.person,
      nonce: p.trick === 'wrong_nonce' ? 'some-other-nonce' : p.nonce,
    };
    const now = Math.floor(Date.now() / 1000);
    if (p.trick === 'hs256') {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(issuer)
        .setAudience(p.clientId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(CLIENT_SECRET.padEnd(32, '!')));
    }
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer(p.trick === 'wrong_issuer' ? 'http://evil.example' : issuer)
      .setAudience(p.trick === 'wrong_audience' ? 'another-app' : p.clientId)
      .setIssuedAt(p.trick === 'expired' ? now - 3600 : now)
      .setExpirationTime(p.trick === 'expired' ? now - 1800 : now + 300)
      .sign(p.trick === 'wrong_key' ? stranger.privateKey : privateKey);
  }

  return {
    issuer: `http://localhost:${server.port}`,
    /** How many times our API exchanged a code. */
    tokenRequests: () => tokenRequests,
    /**
     * The person signs in at the provider: returns the code it would put in
     * the redirect, for the authorization URL our API produced.
     */
    signIn(authorizationUrl: string, person: Person, trick?: Trick): { code: string; state: string } {
      const url = new URL(authorizationUrl);
      const q = (name: string) => url.searchParams.get(name) ?? '';
      if (q('response_type') !== 'code' || q('code_challenge_method') !== 'S256' || !q('scope').split(' ').includes('openid')) {
        throw new Error(`fake IdP: unexpected authorization request ${authorizationUrl}`);
      }
      const code = crypto.randomUUID();
      codes.set(code, {
        person,
        clientId: q('client_id'),
        redirectUri: q('redirect_uri'),
        nonce: q('nonce'),
        codeChallenge: q('code_challenge'),
        trick,
      });
      return { code, state: q('state') };
    },
    stop: () => server.stop(true),
  };
}

export type FakeIdp = Awaited<ReturnType<typeof startFakeIdp>>;

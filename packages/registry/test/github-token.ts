import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";

const ISSUER = "https://token.actions.githubusercontent.com";

export const AUDIENCE = "https://registry.test";

const { publicKey, privateKey } = await generateKeyPair("RS256");

/** Verifies tokens from signGithubToken, standing in for GitHub's JWKS. */
export const keySet = createLocalJWKSet({
  keys: [{ ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" }],
});

export interface TokenOptions {
  claims?: Record<string, string>;
  audience?: string;
  issuer?: string;
  expiresAt?: number;
  key?: CryptoKey;
}

/** A GitHub Actions OIDC token for a push from acme's repository. */
export function signGithubToken({
  claims = {},
  audience = AUDIENCE,
  issuer = ISSUER,
  expiresAt = Math.floor(Date.now() / 1000) + 300,
  key = privateKey,
}: TokenOptions = {}) {
  return new SignJWT({
    repository_owner: "acme",
    repository_owner_id: "1001",
    event_name: "push",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(key);
}

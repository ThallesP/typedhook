import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from "jose";

const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";

export interface GithubIdentity {
  /** `owner/repo` the workflow ran in. */
  repository: string;
  repositoryOwner: string;
  /** Numeric account id as a string. Unlike the login, it survives renames. */
  repositoryOwnerId: string;
  eventName: string;
}

/** Null for any token that isn't a valid GitHub Actions OIDC token for this registry. */
export type VerifyGithubToken = (token: string) => Promise<GithubIdentity | null>;

export function githubVerifier({
  audience,
  issuer = GITHUB_ISSUER,
  keySet = createRemoteJWKSet(new URL(`${GITHUB_ISSUER}/.well-known/jwks`)),
}: {
  audience: string;
  issuer?: string;
  keySet?: JWTVerifyGetKey;
}): VerifyGithubToken {
  // Clients strip trailing slashes from the registry URL before minting tokens for it.
  const expectedAudience = audience.replace(/\/+$/, "");
  return async (token) => {
    try {
      // Pinning the algorithm stops a token from choosing how it gets verified.
      const { payload } = await jwtVerify(token, keySet, {
        issuer,
        audience: expectedAudience,
        algorithms: ["RS256"],
        requiredClaims: ["exp"],
      });
      const { repository, repository_owner, repository_owner_id, event_name } = payload;
      if (typeof repository !== "string") return null;
      if (typeof repository_owner !== "string") return null;
      if (typeof repository_owner_id !== "string") return null;
      if (typeof event_name !== "string") return null;
      return {
        repository,
        repositoryOwner: repository_owner,
        repositoryOwnerId: repository_owner_id,
        eventName: event_name,
      };
    } catch {
      return null;
    }
  };
}

export interface McpOAuthSecret {
  kind: 'oauth'; accessToken: string; refreshToken?: string; expiresAt?: number;
  issuer: string; tokenEndpoint: string; revocationEndpoint?:string; resource: string; clientId: string;
  clientSecret?: string; tokenEndpointAuthMethod?: 'none' | 'client_secret_basic' | 'client_secret_post';
  /**
   * First-party only: the scopes the provider reported for this token, so the
   * host can offer exactly the tools they cover. With Google's incremental
   * consent this is the account's whole grant; the host intersects it with the
   * connector's own scopes before using it.
   */
  grantedScopes?: string[];
}

export interface IntegrationKeyProvider {
  readonly activeKeyId: string;
  keyFor(keyId: string | null | undefined): Promise<Buffer>;
}

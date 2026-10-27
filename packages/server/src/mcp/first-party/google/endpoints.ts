import { GOOGLE_OAUTH_ISSUER } from '@tm8/contract';

/**
 * Every address the Google host calls. STATIC: Google's OAuth server needs no
 * discovery (G6), and the REST bases are fixed, so nothing a connector
 * definition says can point the host anywhere else. Only tests replace them,
 * with a fixture provider (`privateNetwork` lets that fixture be loopback HTTP).
 */
export interface GoogleEndpoints {
  issuer: string;
  authorization: string;
  token: string;
  revocation: string;
  userinfo: string;
  gmail: string;
  calendar: string;
  drive: string;
  driveUpload: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  issuer: GOOGLE_OAUTH_ISSUER,
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revocation: 'https://oauth2.googleapis.com/revoke',
  userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
  gmail: 'https://gmail.googleapis.com/gmail/v1',
  calendar: 'https://www.googleapis.com/calendar/v3',
  drive: 'https://www.googleapis.com/drive/v3',
  driveUpload: 'https://www.googleapis.com/upload/drive/v3',
};

/** The node's Google OAuth client, from server configuration (never a definition). */
export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
}

export interface GoogleHostOptions {
  endpoints?: GoogleEndpoints;
  /** Reads the client at use time, so a rotated secret applies without a restart of anything but the env. */
  client: () => GoogleClientConfig | undefined;
  /** TESTS ONLY: admits a loopback HTTP fixture provider. */
  privateNetwork?: boolean;
}

export const GOOGLE_NOT_CONFIGURED = 'Google connectors are not configured on this server: set TM8_GOOGLE_OAUTH_CLIENT_ID and TM8_MCP_CLIENT_SECRET_GOOGLE';

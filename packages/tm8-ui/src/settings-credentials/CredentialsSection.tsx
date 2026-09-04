/**
 * Settings owns this outer section chrome; the provider implementation itself
 * lives in `CredentialsProviderBlock`, shared byte-for-byte with Home.
 */
import { CredentialsProviderBlock } from './CredentialsProviderBlock';
import type { CredentialsPort } from './port';

export interface CredentialsSectionProps {
  port: CredentialsPort;
  heading?: string;
  /** Same-origin route prefix for the node that owns the login session. */
  serverBaseUrl?: string;
}

export function CredentialsSection({
  port,
  heading = 'Agent credentials',
  serverBaseUrl,
}: CredentialsSectionProps) {
  return (
    <>
      <div className="set-section__head">
        <span className="set-section__title">{heading}</span>
        <div className="set-section__grow" />
      </div>
      <div className="set-section__scroll">
        <CredentialsProviderBlock port={port} serverBaseUrl={serverBaseUrl} />
      </div>
    </>
  );
}

/**
 * The one UI table that translates vendor-shaped provider ids into things a
 * person can recognise. Keep every provider-specific presentation fact here:
 * callers look up an entry and never branch on an id themselves.
 *
 * The marks are deliberately restrained geometry rather than copies of vendor
 * logos. Every stroke/fill follows `currentColor`, so the same inline SVG works
 * in both themes without an image asset or an icon-library dependency.
 */
import type { ComponentType, SVGProps } from 'react';
import type { CredentialProviderName } from '@tm8/contract';

type ProviderMark = ComponentType<SVGProps<SVGSVGElement>>;

export interface CredentialProviderPresentation {
  name: string;
  binary: string;
  icon: ProviderMark;
  /** The only legacy store-completeness exception in the status response. */
  needsGitCredentialStore: boolean;
}

const markProps = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  xmlns: 'http://www.w3.org/2000/svg',
  'aria-hidden': true,
  focusable: 'false',
} as const;

function ClaudeCodeMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} {...markProps}>
      <path
        d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="2.15" fill="currentColor" />
    </svg>
  );
}

function CodexMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} {...markProps}>
      <path
        d="m12 3 7.5 4.35v8.65L12 20.4 4.5 16V7.35L12 3Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="m9 9-3 3 3 3M15 9l3 3-3 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GitHubMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} {...markProps}>
      <path d="M7 5v8a4 4 0 0 0 4 4h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M7 9h7a3 3 0 0 1 3 3v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="7" cy="5" r="2" fill="currentColor" />
      <circle cx="17" cy="17" r="2" fill="currentColor" />
    </svg>
  );
}

function GeminiMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} {...markProps}>
      <path
        d="M12 3.25c.65 4.85 3.9 8.1 8.75 8.75-4.85.65-8.1 3.9-8.75 8.75C11.35 15.9 8.1 12.65 3.25 12 8.1 11.35 11.35 8.1 12 3.25Z"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="1.35" fill="currentColor" />
    </svg>
  );
}

function HermesMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} {...markProps}>
      <path d="M12 4v16M9 7h6M9 17h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path
        d="M11 9C7.4 6.4 4.7 7.1 3.5 10c2.45-.7 4.7.1 7.5 2M13 12c2.8-1.9 5.05-2.7 7.5-2-1.2-2.9-3.9-3.6-7.5-1"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export const CREDENTIAL_PROVIDER_PRESENTATIONS = {
  anthropic: {
    name: 'Claude Code',
    binary: 'claude',
    icon: ClaudeCodeMark,
    needsGitCredentialStore: false,
  },
  openai: {
    name: 'Codex',
    binary: 'codex',
    icon: CodexMark,
    needsGitCredentialStore: false,
  },
  github: {
    name: 'GitHub',
    binary: 'gh',
    icon: GitHubMark,
    needsGitCredentialStore: true,
  },
  gemini: {
    name: 'Gemini',
    binary: 'gemini',
    icon: GeminiMark,
    needsGitCredentialStore: false,
  },
  hermes: {
    name: 'Hermes',
    binary: 'hermes',
    icon: HermesMark,
    needsGitCredentialStore: false,
  },
} as const satisfies Record<CredentialProviderName, CredentialProviderPresentation>;

export function presentationOf(provider: CredentialProviderName): CredentialProviderPresentation {
  return CREDENTIAL_PROVIDER_PRESENTATIONS[provider];
}

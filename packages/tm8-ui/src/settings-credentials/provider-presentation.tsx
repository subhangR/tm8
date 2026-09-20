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

import { GroqMark, KimiMark } from '../kit/ModelMark';

type ProviderMark = ComponentType<SVGProps<SVGSVGElement>>;

export interface CredentialProviderPresentation {
  name: string;
  /**
   * The vendor CLI this credential belongs to, or `null` when there is no CLI.
   *
   * Nullable because of Kimi and Groq. Every other provider is reached by
   * running someone's binary, and the card says which one so that "Unavailable"
   * can name the thing to install. Those two have no vendor CLI at all — tm8's
   * own paste prompt captures an API key — and the binary the server actually
   * measures for them is `node`, which ships with the server and is never
   * missing. Printing `node` on a Kimi card would answer a question nobody
   * asked and imply that installing node is what connects Kimi. `null` says the
   * true thing instead: this credential is a key, not a program.
   */
  binary: string | null;
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

function CursorMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} {...markProps}>
      <path
        d="M5 4.5 18.5 11.25l-6 2.15-2.25 6.1L5 4.5Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m12.5 13.4 4.3 4.3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

/*
 * Kimi's crescent and Groq's bolt are NOT drawn here. They live in
 * `kit/ModelMark.tsx`, because those two vendors are the only ones in this
 * table that a person also meets as a MODEL — a session row spawned on
 * `kimi-k2-thinking` wears the same crescent as the credential that pays for
 * it, and two copies of one shape drift the moment either is retouched. The
 * kit marks default to this file's 22px, so the cards are unchanged.
 */

// An angular X — Grok/xAI. THIS MARK'S JOB IS TO NOT BE THE BOLT ABOVE. Groq
// and Grok sit adjacent on the Connections screen, their names differ by one
// transposed letter, and a member scanning the list at a glance reads the icon
// before the word. So the two shapes are chosen to be unconfusable rather than
// merely different: a filled diagonal wedge pair against an unbroken zigzag,
// distinguishable in silhouette at 22px and with colour removed.
function GrokMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} {...markProps}>
      <path
        d="M5.2 4.4 18.8 19.6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M18.8 4.4 12.9 11"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M10.6 13.6 5.2 19.6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
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
  cursor: {
    name: 'Cursor',
    binary: 'cursor-agent',
    icon: CursorMark,
    needsGitCredentialStore: false,
  },
  // The three API-key providers. `binary: null` is explained on the field above.
  // The names carry the vendor rather than the model family — a member pastes a
  // key from platform.moonshot.ai, and "Kimi" alone would not tell them which
  // console to open. For the last two that convention stops being a nicety and
  // becomes the guard: "Groq" and "Grok" one under the other, unqualified, are
  // one transposed letter apart and read as a typo, so the vendor is spelled
  // out on the one that would otherwise be mistaken for the other.
  kimi: {
    name: 'Kimi (Moonshot AI)',
    binary: null,
    icon: KimiMark,
    needsGitCredentialStore: false,
  },
  groq: {
    name: 'Groq',
    binary: null,
    icon: GroqMark,
    needsGitCredentialStore: false,
  },
  grok: {
    name: 'Grok (xAI)',
    binary: null,
    icon: GrokMark,
    needsGitCredentialStore: false,
  },
} as const satisfies Record<CredentialProviderName, CredentialProviderPresentation>;

export function presentationOf(provider: CredentialProviderName): CredentialProviderPresentation {
  return CREDENTIAL_PROVIDER_PRESENTATIONS[provider];
}

/**
 * What to print in the small monospace chip beside a provider's name.
 *
 * One function rather than `?? 'API key'` at each call site: the fallback is a
 * claim about the credential's SHAPE, and three copies of it would be three
 * places to disagree the next time a provider arrives with neither a CLI nor a
 * key.
 */
export function providerBinaryLabel(provider: CredentialProviderName): string {
  return CREDENTIAL_PROVIDER_PRESENTATIONS[provider].binary ?? 'API key';
}

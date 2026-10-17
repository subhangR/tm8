import type { SVGProps } from 'react';

/**
 * AgentToolIcon — THE one place an agent tool is drawn as an icon.
 *
 * Every surface that marks which tool a session runs with (the Sessions list
 * tile, the launch card and composer model buttons, the credential cards)
 * renders this, so Claude and Codex look the same wherever they appear and a
 * new tool is taught to the UI once.
 *
 * Claude and Codex are their REAL marks — the Claude spark and the Codex
 * cloud-with-prompt — not the text glyphs (✳ ✦) that stood in for them, which
 * read as decoration rather than as "this ran on Claude". Tools without a mark
 * of their own keep their glyph, now from this table instead of a ternary at
 * each call site.
 *
 * Both marks fill with `currentColor`; colour stays in CSS (raw hex is banned
 * in src/). `.kit-tool--claude` takes the Claude orange from
 * `--pn-x-claude`; Codex is monochrome and inherits the surrounding ink.
 */

export type AgentToolKind = 'claude' | 'codex' | 'gemini' | 'hermes' | 'shell' | 'agent';

/** Normalises a recorded `agentTool` id (`claude-code`, `codex`, …) to an icon kind. */
export function agentToolKind(tool: string | null | undefined, opts: { shell?: boolean } = {}): AgentToolKind {
  if (opts.shell) return 'shell';
  const id = (tool || 'agent').toLowerCase();
  if (id === 'claude-code' || id === 'claude' || id === 'anthropic') return 'claude';
  if (id === 'codex' || id === 'openai') return 'codex';
  if (id === 'gemini' || id === 'hermes') return id;
  return 'agent';
}

const GLYPH: Readonly<Record<Exclude<AgentToolKind, 'claude' | 'codex'>, string>> = {
  gemini: '✧',
  hermes: '✣',
  shell: '▮',
  agent: '✦',
};

export function ClaudeLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden focusable="false" {...props}>
      <path fill="currentColor" d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
    </svg>
  );
}

export function CodexLogo(props: SVGProps<SVGSVGElement>) {
  // The prompt (`>_`) is cut out by winding, not by a second colour, so the
  // mark stays one fill and works on any surface.
  return (
    <svg viewBox="0 0 250 250" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden focusable="false" {...props}>
      <path fill="currentColor" d="m84.3 5.1q3.7-1.5 7.7-2.6 3.9-1 7.9-1.6 4-.5 8.1-.6 4 0 8 .5 20.7 2.4 37.1 17.7.1.1.4.3.1 0 .2 0 0 0 .2 0 0 0 .1 0 0 0 .1 0 5.2-1.4 10.7-1.9 5.4-.4 10.7.1 5.5.4 10.7 1.9 5.2 1.3 10.1 3.6l.6.4 1.6.8q5.2 2.5 9.7 6.1 4.7 3.4 8.6 7.7 3.8 4.3 6.9 9.2 3 4.8 5.2 10.2 4.3 10.5 4.3 22.1.2 2.1 0 4.2-.1 2.2-.2 4.3-.3 2.1-.7 4.3-.4 2.1-.9 4.1 0 .2 0 .4 0 .2 0 .5 0 .1.1.4.1.1.3.3 12.3 12.6 16.3 30 6 29.7-12.2 53.5l-1.9 2.2q-3 3.5-6.5 6.4-3.4 3.1-7.3 5.5-3.8 2.4-8.1 4.2-4.1 1.9-8.5 3.2-.3 0-.4.2-.3 0-.4.1-.1.1-.3.4 0 .1-.1.3c-2.7 7.7-5.3 14.2-10.2 20.7-12.5 16.5-30.8 25.5-51.5 25.5q-24.6-.1-43.6-18.1-.2-.1-.4-.2-.2-.1-.4-.1-.2 0-.3 0-.3 0-.4 0c-5.4 1.7-10.9 1.9-16.7 1.9q-3.5 0-7-.5-3.4-.4-6.9-1.2-3.3-.8-6.6-2-3.3-1.2-6.4-2.8-3.3-1.6-6.4-3.6-3-2-5.8-4.3-3-2.3-5.5-5-2.5-2.6-4.6-5.6c-2.2-2.7-4.3-5.4-5.8-8.5q-.8-1.6-1.6-3.2-.6-1.7-1.3-3.3-.7-1.7-1.2-3.4-.5-1.6-1-3.4-1.1-4-1.6-7.9-.6-4-.6-8 0-4 .6-8 .4-4 1.4-8 0 0 0-.1 0-.1 0-.1.2-.2.2-.3 0-.1-.2-.1 0-.2 0-.3 0-.1-.1-.1 0-.2 0-.2-.1-.1-.1-.1-2.4-2.5-4.6-5.2-2.1-2.7-4-5.4-1.7-3-3.2-6-1.5-3.1-2.6-6.3-.8-2-1.3-4.1-.7-2-1.1-4-.4-2.1-.7-4.2-.2-2.2-.4-4.3-.2-2.8-.1-5.6 0-2.8.3-5.4.1-2.8.6-5.6.4-2.8 1.1-5.5 7-23.1 26.9-36.3 4.3-2.9 8.2-4.5 4.5-1.9 9-3.2.2 0 .3-.1.1-.2.3-.3.1 0 .1-.3.1-.1.1-.2 1-3.1 2.2-6 1-2.9 2.5-5.7 1.5-3 3.2-5.6 1.7-2.7 3.7-5.1 2.5-3.2 5.3-5.9 3-2.8 6.1-5.4 3.2-2.4 6.8-4.4 3.5-2 7.2-3.5zm48.3 146.4c-2.3.1-4.4 1-6 2.8-1.5 1.6-2.4 3.7-2.4 5.9 0 2.3.9 4.4 2.4 6.2 1.6 1.6 3.7 2.5 6 2.6h50.4c2.4.1 4.8-.6 6.5-2.4 1.7-1.6 2.8-4 2.8-6.4 0-2.4-1.1-4.7-2.8-6.3-1.7-1.8-4.1-2.6-6.5-2.4zm-56.7-64.9c-1.2-1.9-3-3.4-5.3-3.9-2.2-.5-4.5-.3-6.5.9-2 1.1-3.5 3-4.1 5.2-.7 2.2-.4 4.6.6 6.5l17.7 30.9-17.5 29.5c-1.2 2-1.6 4.5-1.1 6.8.7 2.3 2.1 4.1 4.1 5.3 2 1.2 4.4 1.6 6.7.9 2.2-.5 4.2-1.9 5.4-3.9l20.1-34.1q.7-.9.9-2.1.3-1.1.3-2.3 0-1.2-.3-2.2-.2-1.2-.8-2.2z" />
    </svg>
  );
}

export interface AgentToolIconProps {
  /** The recorded agent tool id (`claude-code`, `codex`, …), or null when unknown. */
  tool: string | null | undefined;
  /** A vanilla terminal: drawn as a terminal, not as an agent with an unknown tool. */
  shell?: boolean;
  /** Edge length in px. Glyph fallbacks size from the surrounding font instead. */
  size?: number;
  className?: string;
}

export function AgentToolIcon({ tool, shell, size = 14, className }: AgentToolIconProps) {
  const kind = agentToolKind(tool, { shell });
  const cls = `kit-tool kit-tool--${kind}${className ? ` ${className}` : ''}`;
  if (kind === 'claude') return <ClaudeLogo className={cls} width={size} height={size} data-tool-kind={kind} />;
  if (kind === 'codex') return <CodexLogo className={cls} width={size} height={size} data-tool-kind={kind} />;
  return <span className={cls} data-tool-kind={kind} aria-hidden>{GLYPH[kind]}</span>;
}

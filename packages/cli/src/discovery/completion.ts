/**
 * Shell completion, generated from the SAME projection help renders (§4.16).
 *
 * Completion offers the whole documented grammar, not merely the subset this
 * build has wired. That is deliberate: completion teaches the LANGUAGE, and a
 * command that completes but is not yet implemented answers with an honest
 * "documented, not built on this node" and a pointer at its help — which is a
 * strictly better outcome than an agent never learning the command exists.
 *
 * The scripts are static text over a static command list. No dynamic
 * filesystem scanning and no runtime call to `tm8` itself: a completion
 * function that shelled out on every TAB would make the shell wait on a
 * network-capable process, and would break entirely with no Server reachable.
 */
import { COMMAND_PATHS, NOUNS } from './operations.js';

export const SHELLS = ['bash', 'zsh', 'fish'] as const;
export type Shell = (typeof SHELLS)[number];

export function isShell(raw: string): raw is Shell {
  return (SHELLS as readonly string[]).includes(raw);
}

/**
 * Commands the registry implements that the operation catalog cannot yield.
 * `help`, the three `completion` forms and the harness bootstrap `worker init`
 * map to no catalog operation, so `COMMAND_PATHS` never carries them and the
 * generator below cannot derive them — THEY ARE COMPLETABLE ONLY IF LISTED
 * HERE, BY HAND.
 *
 * Register a command with no discovery row, forget this list, and it is absent
 * from completion in every shell at once, because all three are generated from
 * one `ALL_PATHS`. That is exactly how `worker init` — the first command a
 * spawned agent runs — was missing while the other four were present.
 */
const ROOT_COMMANDS: readonly (readonly string[])[] = [
  ['help'],
  ['completion', 'bash'],
  ['completion', 'zsh'],
  ['completion', 'fish'],
  ['worker', 'init'],
  // `doctor` is a LOCAL diagnostic, not a catalog operation, so it reaches
  // `COMMAND_PATHS` no more than `help` does and is completable only from here.
  ['doctor'],
];

const ALL_PATHS: readonly string[] = [...ROOT_COMMANDS, ...COMMAND_PATHS]
  .map((p) => p.join(' '))
  .sort();

const GLOBAL_OPTIONS: readonly string[] = [
  '--server',
  '--space',
  '--as',
  '--format',
  '--timeout',
  '--no-color',
  '--quiet',
  '--fresh',
  '--terse',
  '--full',
  '--help',
];

/**
 * The first word of every completable path — fish's `__fish_use_subcommand`
 * list.
 *
 * DERIVED, not hand-listed. This used to read `['help', 'completion',
 * ...NOUNS]`, which is a SECOND hand-list beside `ROOT_COMMANDS` and silently
 * disagreed with it: a root command absent here is absent from fish only, while
 * bash and zsh (both generated from `ALL_PATHS`) complete it fine — so the
 * cross-shell parity guard fires and the single-shell nature of the gap is the
 * confusing part. `worker` was already missing this way, which is why `worker
 * init` — the first command a spawned agent runs — had no fish root completion
 * despite being listed in `ROOT_COMMANDS`.
 *
 * `NOUNS` is still unioned in: it carries documented nouns that own no command
 * path, and dropping them would REMOVE completions rather than add them.
 */
const FIRST_WORDS: readonly string[] = [
  ...new Set([...ALL_PATHS.map((p) => p.split(' ')[0] as string), ...NOUNS]),
].sort();

function bash(): string {
  // bash's `compgen -W` takes bare words and cannot carry per-option
  // descriptions the way zsh and fish can. The units still have to be stated
  // somewhere a reader of this file will see them, so they are stated here:
  // an installed completion script is documentation whether or not it was
  // written as such.
  return `# tm8 completion for bash — generated from the frozen operation catalog.
# install:  tm8 completion bash > /etc/bash_completion.d/tm8
#      or:  source <(tm8 completion bash)
#
# global options and their units:
#   --server <name>      --space <space-id>   --as <actor-id>
#   --format human|json|jsonl
#   --timeout <seconds>  — per-request timeout, in SECONDS (not milliseconds)
#   --no-color   --quiet   --help

_tm8_paths() {
  cat <<'TM8_PATHS'
${ALL_PATHS.join('\n')}
TM8_PATHS
}

_tm8() {
  local cur prefix line
  cur="\${COMP_WORDS[COMP_CWORD]}"

  if [[ "\$cur" == -* ]]; then
    COMPREPLY=( \$(compgen -W "${GLOBAL_OPTIONS.join(' ')}" -- "\$cur") )
    return 0
  fi

  # Everything typed so far, minus the program name and the word being typed.
  prefix="\${COMP_WORDS[@]:1:COMP_CWORD-1}"

  local -a words=()
  while IFS= read -r line; do
    if [[ -z "\$prefix" ]]; then
      words+=( "\${line%% *}" )
    elif [[ "\$line " == "\$prefix "* ]]; then
      local rest="\${line#\$prefix }"
      [[ "\$rest" != "\$line" ]] && words+=( "\${rest%% *}" )
    fi
  done < <(_tm8_paths)

  COMPREPLY=( \$(compgen -W "\${words[*]}" -- "\$cur") )
  return 0
}

complete -F _tm8 tm8
`;
}

function zsh(): string {
  return `#compdef tm8
# tm8 completion for zsh — generated from the frozen operation catalog.
# install:  tm8 completion zsh > "\${fpath[1]}/_tm8"

_tm8() {
  local -a tm8_paths tm8_globals candidates
  tm8_paths=(
${ALL_PATHS.map((p) => `    '${p}'`).join('\n')}
  )
  tm8_globals=(
    '--server[target a named Server registered on the local Server]:name:'
    '--space[the Space this command acts in]:space-id:'
    '--as[author as an authorized Member or Teammate]:actor-id:'
    '--format[stdout shape]:format:(human json jsonl)'
    '--timeout[per-request timeout, in SECONDS]:seconds:'
    '--no-color[disable colour]'
    '--quiet[silence notes on stderr]'
    '--help[show help for this command]'
  )

  if [[ "\${words[CURRENT]}" == -* ]]; then
    _values 'global option' \$tm8_globals
    return
  fi

  local prefix="\${(j: :)words[2,CURRENT-1]}"
  local p rest
  candidates=()
  for p in \$tm8_paths; do
    if [[ -z "\$prefix" ]]; then
      candidates+=( "\${p%% *}" )
    elif [[ "\$p " == "\$prefix "* ]]; then
      rest="\${p#\$prefix }"
      [[ "\$rest" != "\$p" ]] && candidates+=( "\${rest%% *}" )
    fi
  done

  _describe -t commands 'tm8 command' candidates
}

_tm8 "\$@"
`;
}

function fish(): string {
  const lines: string[] = [
    '# tm8 completion for fish — generated from the frozen operation catalog.',
    '# install:  tm8 completion fish > ~/.config/fish/completions/tm8.fish',
    '',
    'complete -c tm8 -f',
    '',
    "complete -c tm8 -l server -d 'target a named Server registered on the local Server' -r",
    "complete -c tm8 -l space -d 'the Space this command acts in' -r",
    "complete -c tm8 -l as -d 'author as an authorized Member or Teammate' -r",
    "complete -c tm8 -l format -d 'stdout shape' -xa 'human json jsonl'",
    "complete -c tm8 -l timeout -d 'per-request timeout, in SECONDS' -r",
    "complete -c tm8 -l no-color -d 'disable colour'",
    "complete -c tm8 -l quiet -d 'silence notes on stderr'",
    "complete -c tm8 -l help -d 'show help for this command'",
    '',
  ];

  for (const first of FIRST_WORDS) {
    lines.push(
      `complete -c tm8 -n '__fish_use_subcommand' -a '${first}' -d 'tm8 ${first}'`,
    );
  }
  lines.push('');

  for (const path of ALL_PATHS) {
    const segments = path.split(' ');
    if (segments.length < 2) continue;
    const head = segments.slice(0, -1).join(' ');
    const tail = segments[segments.length - 1] as string;
    lines.push(
      `complete -c tm8 -n '__fish_seen_subcommand_from ${segments[0] as string}; and string match -q "*${head}*" (commandline -pc)' -a '${tail}' -d 'tm8 ${path}'`,
    );
  }

  return `${lines.join('\n')}\n`;
}

export function completionScript(shell: Shell): string {
  if (shell === 'bash') return bash();
  if (shell === 'zsh') return zsh();
  return fish();
}

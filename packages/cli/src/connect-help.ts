/**
 * How the CLI finds its node, as one help block. Shared by `USAGE` (run.ts)
 * and the rendered root help (commands/help.ts) so the two never disagree.
 * The order is `resolveContext` (context.ts); a member running the CLI on a
 * laptop against a remote node needs exactly these lines and nothing else.
 */
export const CONNECT_HELP_LINES: readonly string[] = [
  'connecting to a node (first match wins)',
  '  TM8_BASE_URL=<url>        env: the node this CLI talks to, e.g. https://tm8.example.com',
  '  "baseUrl": "<url>"        in ~/.config/tm8/config.json ($XDG_CONFIG_HOME/tm8/config.json,',
  '                            or the file named by TM8_CONFIG_PATH)',
  '  ~/.config/tm8/desktop-node.json',
  '                            written by the tm8 desktop app while it runs',
  '  http://127.0.0.1:4610     the implicit local node',
  '  guide: docs/ops/CONNECT-CLI-TO-REMOTE-NODE.md',
];

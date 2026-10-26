/**
 * THE THREE CLIENT SNIPPETS (§10.7): Claude Desktop, Cursor, and the CLI.
 *
 * Pure functions, and deliberately not a template rendered inside the panel:
 * the snippet a member copies is the one thing on this surface that must be
 * exactly right, and a pure builder is the only shape that can be read next to
 * the client's own documentation.
 *
 * `endpoint` is the SERVER'S answer (`mcp.tokens.create` → `endpoint`), never
 * assembled here from `window.location`: the node knows what it is called
 * (`publicOrigin`, else its bound address) and an external client has to reach
 * the address the node published, not the one this browser happens to be on.
 *
 * WHY CLAUDE DESKTOP GETS THE BRIDGE FORM. Its `claude_desktop_config.json`
 * launches local commands; its own Connectors UI adds a remote server by URL
 * but has nowhere to put a bearer header. `mcp-remote` is the documented way
 * to carry one, so that is what the snippet says. Cursor's config speaks HTTP
 * with headers directly, so it gets the direct form. Neither is a guess
 * dressed up as both.
 *
 * `--allow-http` rides along only for an `http://` endpoint — the loopback and
 * LAN case. Adding it to an `https://` snippet would teach a member to pass a
 * flag that downgrades a connection they already have.
 *
 * THE BRIDGE VERSION IS PINNED (surface advisor, S31). A bare `npx -y
 * mcp-remote` fetches whatever npm published most recently and then hands it
 * the member's bearer token — every Claude Desktop start is a fresh
 * supply-chain decision made by someone else. The pin is the version this
 * snippet was written against; raising it is a deliberate edit here, which is
 * exactly the property a bare tag does not have.
 */
const MCP_REMOTE_VERSION = '0.15.2';

/** A snippet: what to paste, and where it goes. */
export interface McpClientSnippet {
  /** Stable key for the copy button's accessible name and for tests. */
  id: 'claude-desktop' | 'cursor' | 'cli';
  /** The client, as the client calls itself. */
  client: string;
  /** Where this text goes — a file, or a shell. */
  where: string;
  /** Extra sentence the member needs before it will work. Else null. */
  note: string | null;
  text: string;
}

/** The server's endpoint with no trailing slash, so no snippet doubles one. */
function endpointOf(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

export function claudeDesktopSnippet(endpoint: string, secret: string): McpClientSnippet {
  const url = endpointOf(endpoint);
  const args = ['-y', `mcp-remote@${MCP_REMOTE_VERSION}`, url, '--header', `Authorization: Bearer ${secret}`];
  if (url.startsWith('http://')) args.push('--allow-http');
  return {
    id: 'claude-desktop',
    client: 'Claude Desktop',
    where: 'claude_desktop_config.json',
    note: `Needs Node installed. Claude Desktop’s own Connectors screen adds a server by URL but cannot send a bearer header, so the bridge carries it. The bridge is pinned to mcp-remote ${MCP_REMOTE_VERSION}: unpinned, every start would fetch the latest release and hand it this token.`,
    text: `${JSON.stringify({ mcpServers: { tm8: { command: 'npx', args } } }, null, 2)}\n`,
  };
}

export function cursorSnippet(endpoint: string, secret: string): McpClientSnippet {
  return {
    id: 'cursor',
    client: 'Cursor',
    where: '~/.cursor/mcp.json (or .cursor/mcp.json in a project)',
    note: null,
    text: `${JSON.stringify({
      mcpServers: { tm8: { url: endpointOf(endpoint), headers: { Authorization: `Bearer ${secret}` } } },
    }, null, 2)}\n`,
  };
}

/** Verbatim the line `tm8 mcp tokens create` prints, so the two never diverge. */
export function cliSnippet(endpoint: string, secret: string): McpClientSnippet {
  return {
    id: 'cli',
    client: 'Claude Code',
    where: 'a terminal',
    /* The token is on a command line here and nowhere else on this surface, so
       the snippet says so rather than leaving it in the member's history
       unremarked (surface advisor, S31). */
    note: 'This puts the token in your shell history — clear it afterwards, or keep the header in a file and paste from there.',
    text: `claude mcp add --transport http tm8 ${endpointOf(endpoint)} --header "Authorization: Bearer ${secret}"`,
  };
}

export function clientSnippets(endpoint: string, secret: string): McpClientSnippet[] {
  return [claudeDesktopSnippet(endpoint, secret), cursorSnippet(endpoint, secret), cliSnippet(endpoint, secret)];
}

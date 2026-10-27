/**
 * CONNECTOR MARKS — bundled, never fetched (surface ruling S2, security read
 * item (c)).
 *
 * `McpCatalogEntry.logo` is a STABLE SLUG and deliberately not a URL. A catalog
 * that shipped image URLs would give a settings page provider egress and a CSP
 * surface for nothing: three provider hostnames in the connect-time threat
 * model, and a first paint that tells mcp.notion.com you opened Settings.
 *
 * So every mark here is a text glyph drawn in a tile. There is no `<img>`, no
 * `url(...)`, no `background-image` and no icon font in this module, and an
 * UNKNOWN SLUG FALLS BACK rather than constructing an address out of it — the
 * one failure mode a slug-to-URL scheme has, and the reason this is a lookup
 * and not a template.
 */
/**
 * A `Map`, not an object literal: a plain object resolves INHERITED keys, so
 * `GLYPHS['constructor']` would hand back `Object`'s constructor — a function,
 * which React then refuses to render as a child. Slugs come from the server's
 * static catalog so nothing reaches that today (surface advisor, S27), but the
 * guarantee this module exists to make is "an unknown slug falls back", and a
 * lookup that can return a function does not make it.
 */
const GLYPHS = new Map<string, string>([
  ['google-gmail', '✉'],
  ['google-calendar', '◷'],
  ['google-drive', '△'],
  ['notion', 'N'],
  ['slack', '#'],
  ['figma', '◆'],
]);

/** The generic mark: a custom connector, or a catalog slug this build has no glyph for. */
export const GENERIC_GLYPH = '⧉';

/**
 * The glyph for a slug. A slug this build does not know returns the generic
 * mark — it is never interpolated into a path, a URL or a class name.
 */
export function connectorGlyph(logo: string | undefined): string {
  if (!logo) return GENERIC_GLYPH;
  return GLYPHS.get(logo) ?? GENERIC_GLYPH;
}

export function ConnectorLogo({ logo, title }: { logo?: string; title: string }) {
  return <span className="mcp-logo" aria-hidden="true" data-logo={logo ?? 'generic'} title={title}>{connectorGlyph(logo)}</span>;
}

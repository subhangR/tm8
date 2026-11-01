const BRAND_ASSETS = new Map([
  ['github', 'github.png'], ['figma', 'figma.svg'], ['slack', 'slack.png'],
  ['notion', 'notion.png'], ['atlassian', 'atlassian.svg'], ['linear', 'linear.svg'],
  ['google-gmail', 'google-gmail.png'], ['google-calendar', 'google-calendar.png'], ['google-drive', 'google-drive.png'],
]);
const GLYPHS = new Map<string, string>([
  ['google-gmail', '✉'],
  ['google-calendar', '◷'],
  ['google-drive', '△'],
  ['notion', 'N'],
  ['slack', '#'],
  ['figma', '◆'], ['github', '●'], ['atlassian', 'A'], ['linear', '◒'],
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

/**
 * A registered connector's slug: its catalog id with dots as dashes
 * (`google.gmail` → `google-gmail`), the shape the catalog's own `logo` uses.
 * A custom connector has no catalog id and draws the generic mark.
 */
export function serverLogo(definition: { catalogId?: string } | undefined): string | undefined {
  return definition?.catalogId?.replace(/\./g, '-');
}

export function ConnectorLogo({ logo, title }: { logo?: string; title: string }) {
  const asset = BRAND_ASSETS.get(logo ?? '');
  return <span className="mcp-logo" aria-hidden="true" data-logo={logo ?? 'generic'} data-brand={asset ? 'official' : undefined} title={title}>
    {asset ? <img src={`/connector-logos/${asset}`} alt="" draggable={false} /> : connectorGlyph(logo)}
  </span>;
}

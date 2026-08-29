/**
 * Hairline discipline (ATELIER §5): 1px `line` borders separate regions —
 * no heavy dividers. Prefer the CSS utilities (kit-hairline-t / -b /
 * -b--strong) on the region itself; these elements are for the standalone
 * rules the canvases draw (e.g. the 18px vertical rule in the tab bar).
 */
export function VRule({ height }: { height?: number }) {
  return <span aria-hidden className="kit-vrule" style={height ? { height, alignSelf: 'center' } : undefined} />;
}

export function HRule({ strong = false }: { strong?: boolean }) {
  return <div aria-hidden className={strong ? 'kit-hairline-b--strong' : 'kit-hairline-b'} />;
}

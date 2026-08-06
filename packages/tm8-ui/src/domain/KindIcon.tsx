import { VectorIcon } from '../kit/VectorIcon';
import { getKind } from './registry';

/**
 * KindIcon — the drawn mark for an entity kind.
 *
 * The one place a kind becomes a picture. It lives in `domain/` because the
 * artwork is registry data and the lookup is `getKind`; every surface that
 * shows "what kind is this" calls this and learns nothing about kinds, which
 * is §15.2 held intact rather than worked around.
 *
 * A custom kind (`c:{name}`) resolves through the fallback row like everything
 * else, so it draws the neutral diamond instead of nothing.
 */
export function KindIcon({
  kind,
  size = 14,
  className,
  /**
   * Name the mark for assistive tech. Default OFF, because in almost every
   * place it ships the kind's word is already right beside it and a second
   * announcement is noise. Pass `labelled` where the mark stands ALONE.
   */
  labelled = false,
}: {
  kind: string;
  size?: number;
  className?: string;
  labelled?: boolean;
}) {
  const config = getKind(kind);
  return (
    <VectorIcon
      paths={config.iconArt}
      size={size}
      className={className}
      title={labelled ? config.label : undefined}
    />
  );
}

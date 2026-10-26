/**
 * REVEAL and STAGGER — the two choreography primitives every tab is built from.
 *
 * `Reveal` fades and lifts one block into place after `delay` ms; `Stagger`
 * hands its children ascending delays so a list arrives as a cascade. Both
 * are pure CSS (`entity-help.css`, `eh-reveal`): React sets a custom property
 * and a class, the stylesheet does the moving, and under reduced motion the
 * `--still` class pins every block at its final state on first paint.
 *
 * The delay rides a custom property rather than an inline `animation-delay`
 * so the reduced-motion rule can zero it in one place.
 */
import { Children, type CSSProperties, type ReactNode } from 'react';
import { useMotion } from './MotionContext';

/**
 * A DOM tag. Narrower than `ElementType` on purpose: with react-three-fiber
 * in the bundle `ElementType` also spans the scene-graph elements, whose props
 * share nothing with a block's, and the dynamic `<Tag>` stops type-checking.
 */
export type RevealTag = keyof HTMLElementTagNameMap;

export interface RevealProps {
  /** Milliseconds before the block starts arriving. */
  delay?: number | undefined;
  as?: RevealTag | undefined;
  className?: string | undefined;
  children: ReactNode;
  /** Forwarded unchanged: an `id`, a role, a data attribute. */
  [attr: `data-${string}`]: string | undefined;
}

export function Reveal({ delay = 0, as: Tag = 'div', className, children, ...rest }: RevealProps) {
  const { reduced } = useMotion();
  const cls = ['eh-reveal', reduced ? 'eh-reveal--still' : '', className ?? ''].filter(Boolean).join(' ');
  const style = { '--eh-delay': `${delay}ms` } as CSSProperties;
  return (
    <Tag className={cls} style={style} {...rest}>
      {children}
    </Tag>
  );
}

export interface StaggerProps {
  /** Milliseconds between one child's arrival and the next. */
  step?: number | undefined;
  /** Milliseconds before the first child. */
  start?: number | undefined;
  as?: RevealTag | undefined;
  itemAs?: RevealTag | undefined;
  className?: string | undefined;
  itemClassName?: string | undefined;
  children: ReactNode;
}

export function Stagger({
  step = 70,
  start = 0,
  as: Tag = 'div',
  itemAs = 'div',
  className,
  itemClassName,
  children,
}: StaggerProps) {
  const items = Children.toArray(children);
  return (
    <Tag className={className}>
      {items.map((child, index) => (
        <Reveal key={index} as={itemAs} delay={start + index * step} className={itemClassName}>
          {child}
        </Reveal>
      ))}
    </Tag>
  );
}

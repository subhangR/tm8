/** IconBtn — square icon button; aria-label is REQUIRED (a11y contract). */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface IconBtnProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  'aria-label': string;
  active?: boolean;
  children: ReactNode;
}

export function IconBtn({ active = false, children, type, ...rest }: IconBtnProps) {
  return (
    <button
      type={type ?? 'button'}
      className="cv2-iconbtn"
      data-active={active || undefined}
      {...rest}
    >
      {children}
    </button>
  );
}

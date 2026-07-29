/**
 * THE REVIEW BOARD — DEV ONLY, never product.
 *
 * Renders all seventeen frames the way the oracle presents them: each in its
 * own specimen viewport, labelled with its `data-screen-label`, light and dark
 * side by side. It exists so the T3 board can be diffed against the canvas the
 * way the canvas is actually laid out — one screen at a time is not how a
 * "state board" gets judged.
 *
 * THE 500×620 BOX IS CANVAS FURNITURE (the D47 precedent). Product frames are
 * full-bleed; this board puts them back in the specimen viewport ON PURPOSE,
 * because that is the geometry the oracle's pixels were measured in and a
 * diff against a different viewport measures the viewport.
 *
 * The skeleton backdrop below is REVIEW FURNITURE TOO. The oracle draws it as
 * grey blocks (L152–L156, L221–L226) because a canvas has no live app behind
 * its dialogs; the real app does, which is why `AuthFlow` takes `backdrop` as
 * a prop and renders nothing of its own. Shipping this skeleton in product
 * would be inventing a workspace that is not there.
 */
import { AUTH_FRAMES, AuthFlow } from './AuthFlow';
import type { AuthIdentity, AuthFrameId } from './types';

/** The viewer 1p renders. Specimen — the board has no seam behind it. */
const BOARD_IDENTITY: AuthIdentity = {
  username: 'amber',
  displayName: 'amber',
  avatar: null,
  isOwner: true,
};

/** The oracle's own specimen viewports, per frame (L35, L199, L219, L330, L401). */
const SIZE: Partial<Record<AuthFrameId, { w: number; h: number }>> = {
  '1h': { w: 500, h: 660 },
  '1j': { w: 832, h: 660 },
  '1i': { w: 500, h: 660 },
  '1o': { w: 400, h: 620 },
  '1p': { w: 500, h: 460 },
};
const DEFAULT_SIZE = { w: 500, h: 620 };

/** The wireframe workspace the oracle draws behind its dialogs. Review only. */
function SkeletonBackdrop({ wide = false }: { wide?: boolean }) {
  return (
    <div className="authboard-skel" data-wide={wide ? '' : undefined} aria-hidden>
      <div className="authboard-skel__bar" />
      <div className="authboard-skel__body">
        <div className="authboard-skel__rail" />
        <div className="authboard-skel__list" />
        <div className="authboard-skel__center">
          <span className="authboard-skel__strip" />
          <span className="authboard-skel__canvas" />
        </div>
        {wide ? <div className="authboard-skel__right" /> : null}
      </div>
    </div>
  );
}

export function AuthBoard() {
  return (
    <div className="authboard">
      <div className="authboard__head">
        <div className="authboard__eyebrow">T3 · AUTH, ONBOARDING &amp; SERVERS · BUILT</div>
        <div className="authboard__title">Every auth moment, one card grammar</div>
        <div className="authboard__note">
          Seventeen frames, light and dark. Every terminal act renders disabled-with-reason: the
          seam behind this board exposes <code>identity()</code> and no auth command at all. Focus a
          refused control to hear its reason; the caption under each is the same text.
        </div>
      </div>

      {AUTH_FRAMES.map((def) => {
        const size = SIZE[def.id] ?? DEFAULT_SIZE;
        return (
          <section className="authboard__frame" key={def.id}>
            <div className="authboard__label">
              <span className="authboard__id">{def.id}</span>
              <span className="authboard__name">{def.label.slice(def.id.length + 1)}</span>
              <span className="authboard__flow">{def.flow}</span>
            </div>
            <div className="authboard__pair">
              {(['light', 'dark'] as const).map((theme) => (
                <div
                  key={theme}
                  className="authboard__viewport"
                  style={{ width: size.w, height: size.h }}
                >
                  <AuthFlow
                    frame={def.id}
                    theme={theme}
                    identity={BOARD_IDENTITY}
                    liveSessionCount={def.id === '1g' ? 2 : undefined}
                    backdrop={def.overlay ? <SkeletonBackdrop wide={def.id === '1j'} /> : undefined}
                    onDone={() => {}}
                  />
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

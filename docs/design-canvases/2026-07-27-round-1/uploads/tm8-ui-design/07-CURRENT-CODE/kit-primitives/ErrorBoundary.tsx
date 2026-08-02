/**
 * ErrorBoundary — the thing that keeps one broken surface from taking the app
 * with it.
 *
 * Before this existed there was no boundary anywhere in the package, so any
 * render-time throw unmounted the ENTIRE shell: rails, nav, panels, the lot,
 * leaving a white page whose only recovery was a reload. That was not a
 * hypothetical — the Settings screen did exactly this against a real server,
 * because a facade read returned a shape its sections did not expect.
 *
 * Two deliberate choices:
 *
 * 1. **It captions itself rather than staying silent.** A boundary that renders
 *    nothing turns a crash into "this screen is empty", which is
 *    indistinguishable from a screen that is legitimately empty — and this app
 *    has a lot of legitimately-empty screens (unimplemented server ops). So the
 *    fallback says a surface FAILED, names it, and shows the message.
 *
 * 2. **Retry is remount, not reload.** `resetKey` lets a caller (e.g. the view
 *    host, keyed by route) clear the error when the user navigates away, so a
 *    crashed screen does not stay crashed after you leave it. The explicit
 *    "Try again" button re-mounts the same subtree, which is the right recovery
 *    for a transient data shape and a no-op for a deterministic bug — in which
 *    case the caption stays, honestly.
 *
 * Deliberately NOT a hook: React exposes error boundaries only to class
 * components. There is no function-component equivalent as of React 18.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Names the surface in the caption, e.g. "the settings screen". */
  label?: string;
  /** Changing this clears a caught error (route changes pass the route). */
  resetKey?: unknown;
  /** Reported alongside the console error; the shell passes the view name. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    // Navigating away from a broken surface must not leave the error pinned to
    // whatever the user opens next.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the stack in the console: the caption is for the user, this is for
    // whoever has to fix it.
    console.error(`[cv2] ${this.props.label ?? 'a surface'} crashed`, error, info.componentStack);
    this.props.onError?.(error, info);
  }

  private retry = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="cv2-errorboundary" role="alert" data-testid="error-boundary">
        <div className="cv2-errorboundary__title">
          {this.props.label ? `${this.props.label} failed to render` : 'This surface failed to render'}
        </div>
        <p className="cv2-errorboundary__body">
          This is a bug in the app, not a problem with your data. The rest of the
          workspace is still usable.
        </p>
        <pre className="cv2-errorboundary__detail">{error.message || String(error)}</pre>
        <button type="button" className="cv2-errorboundary__retry" onClick={this.retry}>
          Try again
        </button>
      </div>
    );
  }
}

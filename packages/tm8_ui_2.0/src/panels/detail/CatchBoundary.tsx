/**
 * CatchBoundary — the REAL error boundary (Surface Audit: "never
 * white-screens" was asserted by a prop-driven ErrorBody while no
 * componentDidCatch existed anywhere; a render throw took the whole tree
 * down. An asserted safety property with no mechanism is the audit's
 * false-record class, in component form).
 *
 * Class component because React gives the catch hook to nothing else. The
 * fallback is the panel's own designed error state; `retryKey` remounts the
 * children on retry rather than praying the same render resolves twice.
 * The boundary wraps BODIES and VIEWS — chrome (header, tabs, rail) stays
 * outside so close/Esc/navigation survive any body's crash.
 */
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { ErrorBody } from './PanelStates';

interface CatchBoundaryProps {
  /** Names the region in the held error line — "task body", "graph view". */
  label: string;
  children: ReactNode;
}

interface CatchBoundaryState {
  error: Error | null;
  retryKey: number;
}

export class CatchBoundary extends Component<CatchBoundaryProps, CatchBoundaryState> {
  state: CatchBoundaryState = { error: null, retryKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<CatchBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console record keeps the component stack; the SCREEN keeps the
    // honest error state. Neither replaces the other.
    console.error(`[tm8-ui] ${this.props.label} crashed during render`, error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <ErrorBody
          errorText={`The ${this.props.label} crashed: ${this.state.error.message}`}
          onRetry={() =>
            this.setState((s) => ({ error: null, retryKey: s.retryKey + 1 }))
          }
        />
      );
    }
    // key forces a clean remount after retry — stale broken state must not
    // survive into the second attempt. A FRAGMENT, deliberately: a wrapper
    // element (even display:contents) stays in the DOM and breaks
    // direct-child selectors — the a948801 AlwaysDark lesson, same night.
    return <Fragment key={this.state.retryKey}>{this.props.children}</Fragment>;
  }
}

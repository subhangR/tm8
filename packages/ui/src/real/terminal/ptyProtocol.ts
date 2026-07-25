// Re-export the dependency-free shared parser so terminal transports cannot
// drift into incompatible interpretations of PTY text control frames.
export { parseControlFrame, type PtyControlFrame } from '@maestro/pty-protocol';

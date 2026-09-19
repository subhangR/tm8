import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/mobile/mobile.css';
import '../src/panels/panels.css';
import '../src/terminal/terminal.css';
import '../src/mobile/mobile-screens.css';
import '../src/transcript/transcript.css';
import '../src/rich-input/rich-input.css';
import { ComposerCard } from '../src/rich-input/ComposerCard';
import { WorkSessionContent } from '../src/panels/bodies/WorkSessionContent';
import { MobileSurfaceProvider } from '../src/mobile/surface';
import { EntityFab } from '../src/mobile/EntityFab';
import { TerminalModifierBar } from '../src/terminal/TerminalModifierBar';
import { LiveTerminal, type LiveTerminalHandle } from '../src/terminal/LiveTerminal';
import { ptyTransport } from '../src/terminal/pty/ptyTransport';

// Production LiveTerminal, xterm, controls and layout. Only the PTY network
// boundary is replaced: deterministic output and captured input bytes.
const originalOpen = Terminal.prototype.open;
Terminal.prototype.open = function (host) {
  originalOpen.call(this, host);
  window.term = this;
};
Object.assign(window, { inputs: [] });
ptyTransport.openSession = () => {
  window.term.write(Array.from({ length: 200 }, (_, i) => `line ${i}\r\n`).join(''));
};
ptyTransport.write = (_id, data) => window.inputs.push({ type: 'text', data });
ptyTransport.writeBinary = (_id, data) => window.inputs.push({ type: 'binary', data });
ptyTransport.resize = () => {};

function Harness() {
  const terminal = useRef<LiveTerminalHandle | null>(null);
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const [fontSize, setFontSize] = useState(13);
  const [mounted, setMounted] = useState(true);
  const [live, setLive] = useState(true);
  Object.assign(window, { detach: () => setMounted(false), remount: () => setMounted(true), setLive });
  return <div className="cv2-root" data-shell="mobile">
    <MobileSurfaceProvider sheetHost={null}>
    <div className="mobile-frame">
      <header className="mobile-frame__header">Session</header>
      <main className="mobile-frame__content" style={{ display: 'flex' }}>
        <div className="pn-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div className="pn-head">Terminal session</div>
          <div className="pn-panelbar">Content</div>
          <WorkSessionContent sessionId="touch-test" requestedSurface="terminal" transcript={<div className="tr-surface"><div className="tr-surface__scroll">Transcript</div><div className="tr-surface__foot"><ComposerCard field={<textarea rows={2} placeholder="Type to the session’s terminal…" />} foot={<><button className="ri-attach">+</button><button className="ri-send">Send</button></>} /></div></div>} terminal={
            <div className="pn-terminal-body">
              <div className="pn-terminal-stage" id="host">{mounted && <LiveTerminal ref={terminal} sessionId="touch-test" live={live} fontSize={fontSize} onCtrlSpent={() => setCtrl(false)} onAltSpent={() => setAlt(false)} />}</div>
              <TerminalModifierBar terminal={terminal} fontSize={fontSize} onFontSizeChange={setFontSize} geometry={null} hostWidth={390} cellWidth={9} live={live} ctrlArmed={ctrl} onCtrlArmedChange={setCtrl} altArmed={alt} onAltArmedChange={setAlt} />
            </div>
          } />
          <div className="pn-foot">Session details</div>
        </div>
      </main>
      <nav className="mobile-frame__tabbar">Home / Sessions</nav>
      <EntityFab label="Session actions" items={[{ id: 'details', label: 'Session details', onSelect: () => window.inputs.push({ type: 'action', data: 'details' }) }]} />
    </div>
    </MobileSurfaceProvider>
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness /></React.StrictMode>);

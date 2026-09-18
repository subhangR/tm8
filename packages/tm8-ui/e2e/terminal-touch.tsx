import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import '../src/styles/tokens.css';
import '../src/mobile/mobile.css';
import '../src/panels/panels.css';
import '../src/terminal/terminal.css';
import { attachTouchScroll } from '../src/terminal/touchScroll';
import '../src/mobile/mobile-screens.css';
import '../src/transcript/transcript.css';
import '../src/rich-input/rich-input.css';
import { ComposerCard } from '../src/rich-input/ComposerCard';
import { WorkSessionContent } from '../src/panels/bodies/WorkSessionContent';
import { MobileSurfaceProvider } from '../src/mobile/surface';
import { TerminalModifierBar } from '../src/terminal/TerminalModifierBar';
import type { LiveTerminalHandle } from '../src/terminal/LiveTerminal';

// Real xterm, production touch handler, controls, and layout CSS. Only PTY
// transport is omitted: deterministic output supplies genuine scrollback.
function Harness() {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<LiveTerminalHandle | null>(null);
  const [ctrl, setCtrl] = useState(false);
  useEffect(() => {
    const term = new Terminal({ scrollback: 1000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    fit.fit();
    let detach = attachTouchScroll(host.current!, term);
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host.current!);
    Object.assign(window, { term, detach: () => detach(), remount: () => { detach(); detach = attachTouchScroll(host.current!, term); } });
    terminal.current = { focus: () => term.focus(), blur: () => term.blur(), sendText: () => {}, armCtrl: () => {} } as unknown as LiveTerminalHandle;
    term.write(Array.from({ length: 200 }, (_, i) => `line ${i}\r\n`).join(''));
    return () => { observer.disconnect(); detach(); term.dispose(); };
  }, []);
  return <div className="cv2-root" data-shell="mobile">
    <div className="mobile-frame">
      <header className="mobile-frame__header">Session</header>
      <main className="mobile-frame__content" style={{ display: 'flex' }}>
        <div className="pn-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div className="pn-head">Terminal session</div>
          <div className="pn-panelbar">Content</div>
          <MobileSurfaceProvider sheetHost={null}>
          <WorkSessionContent sessionId="touch-test" requestedSurface="terminal" transcript={<div className="tr-surface"><div className="tr-surface__scroll">Transcript</div><div className="tr-surface__foot"><ComposerCard field={<textarea rows={2} placeholder="Type to the session’s terminal…" />} foot={<><button className="ri-attach">+</button><button className="ri-send">Send</button></>} /></div></div>} terminal={
            <div className="pn-terminal-body">
              <div className="pn-terminal-stage"><div ref={host} id="host" className="term-host" /></div>
              <TerminalModifierBar terminal={terminal} fontSize={15} onFontSizeChange={() => {}} geometry={null} hostWidth={390} cellWidth={9} live ctrlArmed={ctrl} onCtrlArmedChange={setCtrl} />
            </div>
          } />
          </MobileSurfaceProvider>
          <div className="pn-foot">Session details</div>
        </div>
      </main>
      <nav className="mobile-frame__tabbar">Home / Sessions</nav>
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness /></React.StrictMode>);

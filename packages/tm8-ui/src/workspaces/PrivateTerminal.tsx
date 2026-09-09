import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './workspace.css';

export function PrivateTerminal({ socketPath, serverBaseUrl = '', ariaLabel = 'Private workspace terminal' }: {
  socketPath: string; serverBaseUrl?: string; ariaLabel?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const terminal = new Terminal({ disableStdin: true, cursorBlink: true, fontSize: 13, scrollback: 5000 });
    const fit = new FitAddon(); terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon((_event, uri) => {
      if (/^https?:\/\//i.test(uri)) window.open(uri, '_blank', 'noopener,noreferrer');
    }));
    terminal.open(host.current); fit.fit();
    const url = new URL(`${serverBaseUrl}${socketPath}`, location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url); socket.binaryType = 'arraybuffer';
    const resize = () => { fit.fit(); if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows })); };
    socket.onopen = () => { terminal.options.disableStdin = false; resize(); terminal.focus(); };
    socket.onmessage = event => terminal.write(event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data);
    socket.onclose = () => { terminal.options.disableStdin = true; terminal.writeln('\r\n[Terminal closed]'); };
    socket.onerror = () => terminal.writeln('\r\n[Could not connect to your workspace terminal]');
    const input = terminal.onData(data => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data })); });
    const observer = new ResizeObserver(resize); observer.observe(host.current);
    return () => { observer.disconnect(); input.dispose(); socket.close(); terminal.dispose(); };
  }, [socketPath, serverBaseUrl]);
  return <div className="workspace-terminal" ref={host} aria-label={ariaLabel} />;
}

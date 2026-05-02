'use client';

import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/addon-fit/css/fit.css';
import 'xterm/css/xterm.css';
import { createSSHSession } from '../lib/api';

interface TerminalModalProps {
  hostName: string;
  machineId: string;
  onClose: () => void;
}

export default function TerminalModal({
  hostName,
  machineId,
  onClose,
}: TerminalModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    let isMounted = true;

    const initializeTerminal = async () => {
      try {
        // Request SSH session token from backend
        const session = await createSSHSession(machineId);

        if (!isMounted) return;

        // Initialize xterm
        const terminal = new Terminal({
          cursorBlink: true,
          theme: {
            background: '#1e1e1e',
            foreground: '#d4d4d4',
          },
        });

        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(containerRef.current!);
        fitAddon.fit();

        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;

        // Construct WebSocket URL
        const wsUrl = new URL(session.ws_url, window.location.href);
        wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl.searchParams.set('token', session.token);

        // Connect WebSocket
        const ws = new WebSocket(wsUrl.toString());
        wsRef.current = ws;

        ws.onopen = () => {
          if (!isMounted) return;
          setLoading(false);
          terminal.write('Connecting to SSH terminal...\r\n');
        };

        ws.onmessage = event => {
          if (event.data instanceof ArrayBuffer) {
            terminal.write(new Uint8Array(event.data));
          } else if (event.data instanceof Blob) {
            event.data.arrayBuffer().then(buffer => {
              terminal.write(new Uint8Array(buffer));
            });
          } else {
            terminal.write(event.data);
          }
        };

        ws.onerror = () => {
          if (!isMounted) return;
          terminal.write('\r\n\x1b[31mConnection error\x1b[0m\r\n');
        };

        ws.onclose = event => {
          if (!isMounted) return;
          if (event.code === 4004) {
            setError('Session expired or invalid');
          } else if (event.code !== 1000) {
            terminal.write(
              `\r\n\x1b[31mConnection closed (${event.code})\x1b[0m\r\n`
            );
          }
        };

        // Handle terminal input
        terminal.onData(data => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
          }
        });

        // Handle terminal resize
        if (containerRef.current) {
          resizeObserverRef.current = new ResizeObserver(() => {
            fitAddon.fit();
            const { cols, rows } = terminal;
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'resize', cols, rows }));
            }
          });
          resizeObserverRef.current.observe(containerRef.current);
        }
      } catch (err) {
        if (!isMounted) return;
        setError(err instanceof Error ? err.message : 'Failed to create SSH session');
        setLoading(false);
      }
    };

    initializeTerminal();

    return () => {
      isMounted = false;
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (terminalRef.current) {
        terminalRef.current.dispose();
      }
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
      }
    };
  }, [machineId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-11/12 h-5/6 bg-gray-900 rounded-lg shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-700 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-mono text-gray-400">ssh</span>
            <span className="text-sm text-gray-300">→</span>
            <span className="text-sm font-semibold text-gray-200">
              {hostName} [{machineId}]
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200 transition-colors p-1"
          >
            <span className="text-xl">×</span>
          </button>
        </div>

        {/* Terminal Container */}
        <div className="flex-1 overflow-hidden bg-black">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-10">
              <div className="text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-500 mx-auto mb-4"></div>
                <p className="text-green-500 font-mono text-sm">
                  Connecting to {hostName}...
                </p>
              </div>
            </div>
          )}

          {error && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-10">
              <div className="text-center">
                <p className="text-red-500 font-mono text-sm mb-4">{error}</p>
                <button
                  onClick={onClose}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded text-sm transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          )}

          <div
            ref={containerRef}
            className="w-full h-full"
            style={{ fontFamily: 'Menlo, Monaco, Courier New, monospace' }}
          />
        </div>

        {/* Footer */}
        <div className="border-t border-gray-700 px-4 py-2 text-xs text-gray-500">
          Interactive terminal - Type your commands, press Ctrl+D to disconnect
        </div>
      </div>
    </div>
  );
}

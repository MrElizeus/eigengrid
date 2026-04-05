'use client';

import { KeyboardEvent, useRef, useState } from 'react';

interface SSHModalProps {
  hostName: string;
  ip: string;
  onClose: () => void;
}

export default function SSHModal({ hostName, ip, onClose }: SSHModalProps) {
  const [lines, setLines] = useState<string[]>([
    `Connected to ${hostName} (${ip})`,
    'Type commands below. This is a simulated terminal.',
    '',
  ]);
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  function handleCommand(cmd: string) {
    const newLines = [...lines, `$ ${cmd}`];

    if (cmd.trim() === '') {
      // Just a blank line
    } else if (cmd.trim() === 'clear') {
      setLines([]);
      setInput('');
      return;
    } else if (cmd.trim() === 'help') {
      newLines.push('Available (simulated): help, clear, uptime, whoami, uname -a');
    } else if (cmd.trim() === 'uptime') {
      newLines.push(` ${new Date().toLocaleTimeString()} up 42 days, 3:17,  1 user,  load average: 0.42, 0.38, 0.35`);
    } else if (cmd.trim() === 'whoami') {
      newLines.push('eigengrid');
    } else if (cmd.trim() === 'uname -a') {
      newLines.push('Linux eigen-node 6.1.0-generic #1 SMP x86_64 GNU/Linux');
    } else {
      newLines.push(`bash: ${cmd.split(' ')[0]}: command not found (simulated terminal)`);
    }

    newLines.push('');
    setLines(newLines);
    setInput('');
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && input.length >= 0) {
      handleCommand(input);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-black/60 p-4">
      <div className="w-full max-w-2xl bg-slate-950 dark:bg-black rounded-xl overflow-hidden shadow-2xl">
        {/* Title bar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800">
          <span className="text-xs text-slate-400 font-mono">
            ssh → {hostName} ({ip})
          </span>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-300 text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* Terminal output */}
        <div
          className="p-4 font-mono text-sm text-green-400 overflow-y-auto"
          style={{ height: '320px' }}
        >
          {lines.map((line, i) => (
            <div key={i} className="whitespace-pre">
              {line}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-slate-800">
          <span className="text-green-400 font-mono text-sm shrink-0">$</span>
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent text-green-400 font-mono text-sm outline-none placeholder:text-slate-600"
            placeholder="Type a command…"
          />
        </div>
      </div>
    </div>
  );
}

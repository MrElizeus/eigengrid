'use client';

import { FormEvent, useState } from 'react';

interface HostModalProps {
  onClose: () => void;
  onSubmit: (
    name: string,
    type: 'standalone' | 'workstation' | 'cluster',
    nodeCount: number
  ) => void;
}

export default function HostModal({ onClose, onSubmit }: HostModalProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'standalone' | 'workstation' | 'cluster'>(
    'standalone'
  );
  const [nodeCount, setNodeCount] = useState(1);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit(name.trim(), type, nodeCount);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60 p-4">
      <div
        className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
            Add Host
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Configure a new standalone machine, workstation, or cluster.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-5">
          {/* Name */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300" htmlFor="host-name">
              Name
            </label>
            <input
              id="host-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. render-node-01"
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-blue-600 dark:focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-600/20 dark:focus:ring-blue-500/20 transition"
            />
          </div>

          {/* Type */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Type
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(['standalone', 'workstation', 'cluster'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={`rounded-lg border px-3 py-2 text-xs font-medium capitalize transition ${
                    type === t
                      ? 'border-blue-600 dark:border-blue-500 bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400'
                      : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Node count (only for clusters) */}
          {type === 'cluster' && (
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium text-slate-700 dark:text-slate-300"
                htmlFor="node-count"
              >
                Initial nodes
              </label>
              <input
                id="node-count"
                type="number"
                min={1}
                max={32}
                value={nodeCount}
                onChange={(e) => setNodeCount(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-800 dark:text-slate-100 focus:border-blue-600 dark:focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-600/20 dark:focus:ring-blue-500/20 transition"
              />
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-2 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim()}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 hover:bg-blue-700 dark:hover:bg-blue-500 transition"
            >
              Add Host
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

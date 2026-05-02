'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Host, SensorReading } from './types';
import {
  createHost,
  loadHosts,
  removeHost,
  saveHosts,
} from './store';
import HostCard from './components/HostCard';
import HostModal from './components/HostModal';
import { logout } from './lib/api';

function useDarkMode() {
  const [dark, setDark] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('eigengrid_dark');
      const isDark = stored
        ? stored === 'true'
        : window.matchMedia('(prefers-color-scheme: dark)').matches;
      return isDark;
    }
    return false;
  });

  // Apply dark class to document after mount
  const [applied, setApplied] = useState(false);
  if (!applied && typeof window !== 'undefined') {
    if (dark) document.documentElement.classList.add('dark');
    setApplied(true);
  }

  const toggle = useCallback(() => {
    setDark((prev) => {
      const next = !prev;
      localStorage.setItem('eigengrid_dark', String(next));
      if (next) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
      return next;
    });
  }, []);

  return { dark, toggle };
}

function generateSensor(
  prev: SensorReading,
  isOn: boolean
): SensorReading {
  if (!isOn) {
    return { timestamp: Date.now(), temperature: 0, cpuUsage: 0 };
  }

  const tempBase = prev.temperature || 40;
  const cpuBase = prev.cpuUsage || 30;

  const temperature = Math.min(
    80,
    Math.max(25, tempBase + (Math.random() - 0.48) * 4)
  );
  const cpuUsage = Math.min(
    100,
    Math.max(2, cpuBase + (Math.random() - 0.48) * 12)
  );

  return { timestamp: Date.now(), temperature, cpuUsage };
}

export default function DashboardPage() {
  const router = useRouter();
  const [hosts, setHosts] = useState<Host[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const { dark, toggle: toggleDark } = useDarkMode();

  // Load hosts from localStorage on mount (client only, avoids hydration mismatch)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHosts(loadHosts());
  }, []);

  // Persist to localStorage whenever hosts change
  useEffect(() => {
    saveHosts(hosts);
  }, [hosts]);

  // Sensor simulation loop
  useEffect(() => {
    const id = setInterval(() => {
      setHosts((prevHosts) => {
        let changed = false;
        const updated = prevHosts.map((host) => {
          const newNodes = host.nodes.map((node) => {
            if (node.powerState !== 'on') return node;
            changed = true;
            const prev =
              node.history[node.history.length - 1] ?? {
                temperature: 40,
                cpuUsage: 30,
                timestamp: Date.now(),
              };
            const reading = generateSensor(prev, true);
            return {
              ...node,
              history: [...node.history.slice(-119), reading],
              temperature: reading.temperature,
              cpuUsage: reading.cpuUsage,
            };
          });
          return changed || host.nodes.some((n) => n.powerState === 'on')
            ? { ...host, nodes: newNodes }
            : host;
        });
        return changed ? updated : prevHosts;
      });
    }, 800);

    return () => clearInterval(id);
  }, []);

  function handleAddHost(
    name: string,
    type: 'standalone' | 'workstation' | 'cluster',
    nodeCount: number,
    firstNodeConfig: { machineId?: string; ip?: string; mac?: string }
  ) {
    const newHost = createHost(name, type, nodeCount, firstNodeConfig);
    setHosts((prev) => [...prev, newHost]);
    setShowAddModal(false);
  }

  function handleDeleteHost(hostId: string) {
    setHosts((prev) => removeHost(prev, hostId));
  }

  function handleUpdateHost(updated: Host) {
    setHosts((prev) =>
      prev.map((h) => (h.id === updated.id ? updated : h))
    );
  }

  async function handleLogout() {
    if (isLoggingOut) return;

    setIsLoggingOut(true);
    try {
      await logout();
    } catch (err) {
      console.error('Logout failed:', err);
    } finally {
      localStorage.removeItem('eigengrid_token');
      router.replace('/');
    }
  }

  const onlineCount = hosts.reduce(
    (s, h) => s + h.nodes.filter((n) => n.powerState === 'on').length,
    0
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 dark:bg-slate-950 dark:text-slate-100">
      {/* Header */}
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <p className="text-xs uppercase tracking-[0.3rem] text-slate-500 dark:text-slate-400">
            EigenGrid
          </p>
          <span className="h-4 w-px bg-slate-300 dark:bg-slate-700" />
          <span className="text-sm text-slate-500 dark:text-slate-400">
            {hosts.length} host{hosts.length !== 1 ? 's' : ''} ·{' '}
            {onlineCount} nodes online
          </span>
        </div>

        {/* Stacked buttons */}
        <div className="flex flex-col gap-2">
          <button
            onClick={() => setShowAddModal(true)}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 dark:hover:bg-blue-500 transition"
          >
            + Add Host
          </button>
          <button
            onClick={toggleDark}
            className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 transition"
            title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {dark ? '☀' : '☾'}
          </button>
          <button
            onClick={handleLogout}
            disabled={isLoggingOut}
            className="rounded-lg border border-red-200 dark:border-red-900/60 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isLoggingOut ? 'Signing out...' : 'Log out'}
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {hosts.length === 0 ? (
          <div className="text-center py-20 space-y-4">
            <p className="text-slate-400 dark:text-slate-500 text-lg">
              No hosts configured
            </p>
            <p className="text-sm text-slate-400 dark:text-slate-500">
              Add a standalone machine, workstation, or cluster to get started.
            </p>
            <button
              onClick={() => setShowAddModal(true)}
              className="inline-block rounded-lg border border-slate-300 dark:border-slate-700 px-5 py-2 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
            >
              Add your first host
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {hosts.map((host) => (
              <HostCard
                key={host.id}
                host={host}
                onDelete={() => handleDeleteHost(host.id)}
                onUpdate={handleUpdateHost}
              />
            ))}
          </div>
        )}
      </main>

      {/* Add Host Modal */}
      {showAddModal && (
        <HostModal
          onClose={() => setShowAddModal(false)}
          onSubmit={handleAddHost}
        />
      )}
    </div>
  );
}

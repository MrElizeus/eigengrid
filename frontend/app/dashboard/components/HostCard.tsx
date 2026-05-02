'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Host, Node } from '../types';
import { addNodeToHost, removeNodeFromHost } from '../store';
import { wakeOnLan } from '../lib/api';
import ECGGraph from './ECGGraph';

const TerminalModal = dynamic(() => import('./TerminalModal'), { ssr: false });

interface HostCardProps {
  host: Host;
  onDelete: () => void;
  onUpdate: (updated: Host) => void;
}

export default function HostCard({ host, onDelete, onUpdate }: HostCardProps) {
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const [sshNode, setSshNode] = useState<Node | null>(null);

  async function togglePower(nodeId: string) {
    const node = host.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    if (node.powerState === 'on') {
      const updated = {
        ...host,
        nodes: host.nodes.map((n) =>
          n.id === nodeId
            ? { ...n, powerState: 'off' as const, temperature: 0, cpuUsage: 0 }
            : n
        ),
      };
      onUpdate(updated);
    } else {
      // Only send WOL if machineId is set
      if (node.machineId) {
        const updated = {
          ...host,
          nodes: host.nodes.map((n) =>
            n.id === nodeId ? { ...n, powerState: 'waking' as const } : n
          ),
        };
        onUpdate(updated);

        try {
          await wakeOnLan(node.machineId);
          // Keep in 'waking' state - user will manually refresh when ready
        } catch (err) {
          console.error('WOL failed:', err);
          // Revert to 'off' state on error
          onUpdate({
            ...updated,
            nodes: updated.nodes.map((n) =>
              n.id === nodeId ? { ...n, powerState: 'off' as const } : n
            ),
          });
        }
      }
    }
  }

  function addNode() {
    onUpdate(addNodeToHost(host));
  }

  function removeNode(nodeId: string) {
    if (host.nodes.length <= 1) return;
    onUpdate(removeNodeFromHost(host, nodeId));
    if (expandedNodeId === nodeId) setExpandedNodeId(null);
  }

  const totalTemp = host.nodes.reduce((s, n) => s + n.temperature, 0);
  const avgTemp = host.nodes.length > 0 ? totalTemp / host.nodes.length : 0;
  const poweredOn = host.nodes.filter((n) => n.powerState === 'on').length;

  const typeLabel =
    host.type === 'cluster'
      ? 'Cluster'
      : host.type === 'workstation'
        ? 'Workstation'
        : 'Standalone';

  return (
    <>
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        {/* Card header */}
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-slate-800 dark:text-slate-100">
                {host.name}
              </h3>
              <span className="text-[10px] uppercase tracking-wider font-medium text-slate-400 dark:text-slate-500 border border-slate-200 dark:border-slate-700 rounded-md px-1.5 py-0.5">
                {typeLabel}
              </span>
            </div>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
              {poweredOn}/{host.nodes.length} node{host.nodes.length !== 1 ? 's' : ''} online
              {avgTemp > 0 && (
                <span className="ml-2">· {avgTemp.toFixed(1)}°C avg</span>
              )}
            </p>
          </div>
          <button
            onClick={onDelete}
            className="text-slate-300 dark:text-slate-600 hover:text-red-500 dark:hover:text-red-400 transition text-xs"
            title="Remove host"
          >
            ×
          </button>
        </div>

        {/* Nodes */}
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {host.nodes.map((node) => {
            const isExpanded = expandedNodeId === node.id;
            const isOn = node.powerState === 'on';
            const isWaking = node.powerState === 'waking';

            return (
              <div key={node.id}>
                {/* Node row */}
                <div className="px-5 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    {/* WoL Button */}
                    <button
                      onClick={() => togglePower(node.id)}
                      disabled={isWaking}
                      className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition ${
                        isOn
                          ? 'bg-green-500/10 text-green-500 hover:bg-green-500/20 dark:bg-green-500/15 dark:hover:bg-green-500/25'
                          : isWaking
                            ? 'bg-amber-500/10 text-amber-500 animate-pulse dark:bg-amber-500/15'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700'
                      }`}
                      title={isOn ? 'Power off' : 'Wake on LAN'}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="w-3.5 h-3.5"
                      >
                        <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
                        <line x1="12" y1="2" x2="12" y2="12" />
                      </svg>
                    </button>

                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
                        {node.name}
                      </p>
                      <p className="text-xs text-slate-400 dark:text-slate-500 truncate">
                        {node.ip || 'No IP set'}
                        {node.mac && (
                          <span className="ml-1 font-mono">{node.mac}</span>
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 ml-3">
                    {/* Status pill */}
                    {isOn && (
                      <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
                        {node.temperature.toFixed(0)}°C
                      </span>
                    )}

                    {/* SSH button */}
                    {isOn && node.machineId && (
                      <button
                        onClick={() => setSshNode(node)}
                        className="rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1 text-[10px] font-mono text-slate-500 dark:text-slate-400 hover:border-blue-400 dark:hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-400 transition"
                      >
                        SSH
                      </button>
                    )}

                    {/* Expand/collapse */}
                    {isOn && (
                      <button
                        onClick={() =>
                          setExpandedNodeId(isExpanded ? null : node.id)
                        }
                        className="text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400 transition text-lg leading-none"
                      >
                        {isExpanded ? '−' : '+'}
                      </button>
                    )}

                    {/* Remove node (clusters only) */}
                    {host.type === 'cluster' && host.nodes.length > 1 && (
                      <button
                        onClick={() => removeNode(node.id)}
                        className="text-slate-300 dark:text-slate-600 hover:text-red-500 dark:hover:text-red-400 transition text-xs"
                        title="Remove node"
                      >
                        ×
                      </button>
                    )}
                  </div>
                </div>

                {/* Expanded graphs */}
                {isOn && isExpanded && (
                  <div className="px-5 pb-4 space-y-3">
                    <ECGGraph
                      data={node.history.map((h) => h.temperature)}
                      label="Temperature"
                      unit="°C"
                      height={80}
                    />
                    <ECGGraph
                      data={node.history.map((h) => h.cpuUsage)}
                      label="CPU Usage"
                      unit="%"
                      height={80}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Add node button (clusters) */}
        {host.type === 'cluster' && (
          <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800">
            <button
              onClick={addNode}
              className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium"
            >
              + Add node
            </button>
          </div>
        )}
      </div>

      {/* Terminal Modal */}
      {sshNode && sshNode.machineId && (
        <TerminalModal
          hostName={host.name}
          machineId={sshNode.machineId}
          onClose={() => setSshNode(null)}
        />
      )}
    </>
  );
}

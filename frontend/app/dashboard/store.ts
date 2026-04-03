import { Host, Node, SensorReading } from './types';

const STORAGE_KEY = 'eigengrid_hosts';

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function emptyHistory(): SensorReading[] {
  const now = Date.now();
  const points: SensorReading[] = [];
  for (let i = 120; i >= 0; i--) {
    points.push({ timestamp: now - i * 500, temperature: 0, cpuUsage: 0 });
  }
  return points;
}

function createDefaultNode(index: number): Node {
  return {
    id: generateId(),
    name: `Node-${index + 1}`,
    mac: '',
    ip: '',
    powerState: 'off',
    temperature: 0,
    cpuUsage: 0,
    history: emptyHistory(),
  };
}

export function loadHosts(): Host[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw) as Host[];
    }
  } catch {
    // Ignore parse errors
  }
  return [];
}

export function saveHosts(hosts: Host[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(hosts));
}

export function createHost(
  name: string,
  type: 'standalone' | 'workstation' | 'cluster',
  nodeCount: number
): Host {
  const nodes: Node[] = Array.from({ length: nodeCount }, (_, i) =>
    createDefaultNode(i)
  );

  return {
    id: generateId(),
    name,
    type,
    nodes,
    createdAt: Date.now(),
  };
}

export function addNodeToHost(host: Host): Host {
  const index = host.nodes.length + 1;
  return {
    ...host,
    nodes: [...host.nodes, createDefaultNode(index)],
  };
}

export function removeNodeFromHost(host: Host, nodeId: string): Host {
  return {
    ...host,
    nodes: host.nodes.filter((n) => n.id !== nodeId),
  };
}

export function removeHost(hosts: Host[], hostId: string): Host[] {
  return hosts.filter((h) => h.id !== hostId);
}

export function updateNode(
  hosts: Host[],
  hostId: string,
  nodeId: string,
  updates: Partial<Node>
): Host[] {
  return hosts.map((h) =>
    h.id === hostId
      ? {
          ...h,
          nodes: h.nodes.map((n) =>
            n.id === nodeId ? { ...n, ...updates } : n
          ),
        }
      : h
  );
}

export function pushSensorReading(
  hosts: Host[],
  hostId: string,
  nodeId: string,
  reading: SensorReading
): Host[] {
  return hosts.map((h) =>
    h.id === hostId
      ? {
          ...h,
          nodes: h.nodes.map((n) =>
            n.id === nodeId
              ? {
                  ...n,
                  history: [...n.history.slice(-119), reading],
                  temperature: reading.temperature,
                  cpuUsage: reading.cpuUsage,
                }
              : n
          ),
        }
      : h
  );
}

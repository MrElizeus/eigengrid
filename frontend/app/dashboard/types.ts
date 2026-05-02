export type HostType = 'standalone' | 'workstation' | 'cluster';
export type PowerState = 'on' | 'off' | 'waking';

export interface SensorReading {
  timestamp: number;
  temperature: number;
  cpuUsage: number;
}

export interface Node {
  id: string;
  name: string;
  mac: string;
  ip: string;
  powerState: PowerState;
  temperature: number;
  cpuUsage: number;
  history: SensorReading[];
  machineId?: string;
}

export interface Host {
  id: string;
  name: string;
  type: HostType;
  nodes: Node[];
  createdAt: number;
}

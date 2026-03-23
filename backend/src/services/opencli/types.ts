import type { WebSocket } from 'ws';

export type RegistryKey = `${string}||${string}`;

export interface BridgeEntry {
  bridgeId: string;
  deviceName: string;
  userId: string;
  projectId: string;
  ws: WebSocket;
  status: 'online' | 'offline';
  connectedAt: Date;
  lastHeartbeat: Date;
  capabilities: BridgeCapabilities;
}

export interface BridgeCapabilities {
  opencliVersion: string;
  nodeVersion: string;
  platform: string;
  daemonRunning: boolean;
  extensionConnected: boolean;
  availableSites: string[];
}

export interface BridgeCommand {
  id: string;
  site: string;
  action: string;
  args: string[];
  timeout?: number;
  env?: Record<string, string>;
}

export interface BridgeResult {
  id: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface OpenCliContext {
  enabled: boolean;
  enabledDomains: string[];
  projectId: string;
  userId: string;
}

export interface OpenCliProjectConfig {
  enabled: boolean;
  enabledDomains: string[];
}

export interface PendingCommand {
  resolve: (stdout: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  projectId: string;
  userId: string;
}

export interface RegisterMessage {
  type: 'register';
  bridgeId: string;
  deviceName: string;
  userId: string;
  projects: Array<{ projectId: string; projectName: string }>;
  capabilities: BridgeCapabilities;
}

export interface ResultMessage {
  type: 'result';
  id: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export class BridgeError extends Error {
  constructor(
    public code: 'BRIDGE_OFFLINE' | 'BRIDGE_DISCONNECTED' | 'BRIDGE_TIMEOUT' | 'CLI_NOT_FOUND' | 'EXEC_ERROR',
    message?: string
  ) {
    super(message || code);
    this.name = 'BridgeError';
  }
}

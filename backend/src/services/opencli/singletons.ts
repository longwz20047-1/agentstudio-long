// Shared singletons for the opencli module.
// Both opencliMcpFactory and opencliWs must use these instances
// to avoid the "dual instance" bug where commands never resolve.
import { bridgeRegistry } from './bridgeRegistry.js';
import { BridgeCommandProxy } from './bridgeCommandProxy.js';
import { BridgeKeyService } from './bridgeKeyService.js';
import { BridgeHistoryStore } from './bridgeHistoryStore.js';
import os from 'os';
import path from 'path';

export { bridgeRegistry };
export const bridgeCommandProxy = new BridgeCommandProxy(bridgeRegistry);
export const bridgeHistoryStore = new BridgeHistoryStore();

// Phase 2: Shared BridgeKeyService singleton.
// dataDir defaults to ~/.agentstudio/opencli — overridden in production via config.
const defaultDataDir = path.join(os.homedir(), '.agentstudio', 'opencli');
export const bridgeKeyService = new BridgeKeyService(defaultDataDir);

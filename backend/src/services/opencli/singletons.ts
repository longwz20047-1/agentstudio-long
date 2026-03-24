// Shared singletons for the opencli module.
// Both opencliMcpFactory and opencliWs must use these instances
// to avoid the "dual instance" bug where commands never resolve.
import { bridgeRegistry } from './bridgeRegistry.js';
import { BridgeCommandProxy } from './bridgeCommandProxy.js';

export { bridgeRegistry };
export const bridgeCommandProxy = new BridgeCommandProxy(bridgeRegistry);

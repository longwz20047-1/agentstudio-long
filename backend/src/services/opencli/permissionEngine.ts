import { WRITE_OPERATIONS, DOMAIN_MAPPING } from './constants.js';

// Flatten all known sites from DOMAIN_MAPPING
const ALL_KNOWN_SITES = new Set(Object.values(DOMAIN_MAPPING).flat());

const DOWNLOAD_ACTIONS = new Set(['download']);
const READ_SAFE_ACTIONS = new Set(['export']);

// Session approval cache: Map<sessionId, { approvals: Set<"site/action">, createdAt: number }>
const APPROVAL_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CACHE_SIZE = 500;
const approvalCache = new Map<string, { approvals: Set<string>; createdAt: number }>();

// Periodic cleanup every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of approvalCache) {
    if (now - entry.createdAt > APPROVAL_TTL_MS) {
      approvalCache.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

/**
 * Determine if a site/action combination is a write operation.
 * - Known write operations -> true
 * - Download/export actions -> false (auto-execute)
 * - Known site + unknown action -> false (assume read)
 * - Unknown site + unknown action -> true (safe default)
 */
export function isWriteOperation(site: string, action: string): boolean {
  if (DOWNLOAD_ACTIONS.has(action)) return false;
  if (READ_SAFE_ACTIONS.has(action)) return false;

  const siteWrites = WRITE_OPERATIONS[site];
  if (siteWrites?.includes(action)) return true;

  if (ALL_KNOWN_SITES.has(site)) return false;

  return true;
}

export function hasSessionApproval(sessionId: string, site: string, action: string): boolean {
  const entry = approvalCache.get(sessionId);
  if (!entry) return false;
  if (Date.now() - entry.createdAt > APPROVAL_TTL_MS) {
    approvalCache.delete(sessionId);
    return false;
  }
  return entry.approvals.has(`${site}/${action}`);
}

export function grantSessionApproval(sessionId: string, site: string, action: string): void {
  let entry = approvalCache.get(sessionId);
  if (!entry) {
    // Evict oldest if at capacity
    if (approvalCache.size >= MAX_CACHE_SIZE) {
      const oldest = approvalCache.keys().next().value;
      if (oldest) approvalCache.delete(oldest);
    }
    entry = { approvals: new Set(), createdAt: Date.now() };
    approvalCache.set(sessionId, entry);
  }
  entry.approvals.add(`${site}/${action}`);
}

export function clearSessionApprovals(sessionId: string): void {
  approvalCache.delete(sessionId);
}

export function clearAllApprovals(): void {
  approvalCache.clear();
}

export function getApprovalCacheSize(): number {
  return approvalCache.size;
}

export function buildConfirmationPrompt(site: string, action: string, args: string[]): string {
  const command = `opencli ${site} ${action} ${args.join(' ')}`;
  return [
    `OpenCLI Write Operation Confirmation`,
    ``,
    `${site}/${action} wants to execute a write operation.`,
    ``,
    `Command: ${command}`,
    ``,
    `This will modify data on ${site}. Reply "confirm" to proceed or "reject" to cancel.`,
    `(Approval remembered for this session. Timeout: 3 minutes)`,
  ].join('\n');
}

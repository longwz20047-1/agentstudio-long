import { WRITE_OPERATIONS, DOMAIN_MAPPING } from './constants.js';

// Flatten all known sites from DOMAIN_MAPPING
const ALL_KNOWN_SITES = new Set(Object.values(DOMAIN_MAPPING).flat());

const DOWNLOAD_ACTIONS = new Set(['download']);
const READ_SAFE_ACTIONS = new Set(['export']);

// Session approval cache: Map<sessionId, Set<"site/action">>
const approvalCache = new Map<string, Set<string>>();

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
  return approvalCache.get(sessionId)?.has(`${site}/${action}`) ?? false;
}

export function grantSessionApproval(sessionId: string, site: string, action: string): void {
  if (!approvalCache.has(sessionId)) {
    approvalCache.set(sessionId, new Set());
  }
  approvalCache.get(sessionId)!.add(`${site}/${action}`);
}

export function clearSessionApprovals(sessionId: string): void {
  approvalCache.delete(sessionId);
}

export function clearAllApprovals(): void {
  approvalCache.clear();
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

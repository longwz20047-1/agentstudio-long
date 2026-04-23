import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { integrateDootaskMcpServer } from '../dootaskMcpIntegration.js';

// 简单 mock：避免真实 createSdkMcpServer / buildAllTools 依赖
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn().mockReturnValue({ name: 'dootask' }),
}));
vi.mock('../tools/index.js', () => ({
  buildAllTools: vi.fn().mockReturnValue([]),
}));
vi.mock('../dootaskTokenExchange.js', () => ({
  getDootaskToken: vi.fn().mockResolvedValue('fake-token'),
}));

/**
 * M1 Part2 Task 6 dootaskMcpIntegration prompt 注入测试（spec v2.1 §7.4 + v2.1 P0-1 修正）
 *
 * 关键回归测试：
 *   `'append' in existing` 对默认 preset { type:'preset', preset:'claude_code' }（无 append 键）返 false
 *   → v1 会走 else 把 preset 整个替换为字符串 → SDK preset 行为全失效
 *   v2.1 修正为 `existing.type === 'preset'` 判断，保留 preset 结构仅追加 append 字段
 */
describe('dootaskMcpIntegration - prompt injection (Task 6)', () => {
  const validContext = { corp_id: 'ww_test', wecom_userid: 'WxTest' };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DOOTASK_INTERNAL_SECRET = 'test-secret';
    process.env.DOOTASK_BASE_URL = 'http://test-dootask';
    delete process.env.DOOTASK_ALLOWED_CORPS; // 默认关白名单
  });

  afterEach(() => {
    delete process.env.DOOTASK_INTERNAL_SECRET;
    delete process.env.DOOTASK_BASE_URL;
  });

  it('injects DOOTASK_WECOM_PROMPT into preset.append when dootaskContext is valid', async () => {
    const queryOptions: any = {
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    };
    await integrateDootaskMcpServer(queryOptions, validContext);
    expect(queryOptions.systemPrompt.type).toBe('preset');
    expect(queryOptions.systemPrompt.preset).toBe('claude_code');
    expect(queryOptions.systemPrompt.append).toContain('list_tasks');
    expect(queryOptions.systemPrompt.append).toContain('pagesize=5');
    expect(queryOptions.systemPrompt.append).toContain('[企微通知上下文规则]');
  });

  it('does NOT replace preset with string (v2.1 P0-1 regression test)', async () => {
    // v2.1 关键：不能用 'append' in existing 判断
    // 默认 preset 无 append 键 → 'append' in 返 false → 会走 else 把 preset 替换为字符串
    // 正确判断 existing.type === 'preset' 保留 preset 结构
    const queryOptions: any = {
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    };
    await integrateDootaskMcpServer(queryOptions, validContext);
    expect(typeof queryOptions.systemPrompt).toBe('object');
    expect(queryOptions.systemPrompt).toHaveProperty('type', 'preset');
    expect(queryOptions.systemPrompt).toHaveProperty('preset', 'claude_code');
  });

  it('skips injection when dootaskContext is absent', async () => {
    const queryOptions: any = {
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    };
    await integrateDootaskMcpServer(queryOptions, undefined);
    expect(queryOptions.systemPrompt.append).toBeUndefined();
  });

  it('appends to string systemPrompt when already a string', async () => {
    const queryOptions: any = { systemPrompt: 'existing prompt' };
    await integrateDootaskMcpServer(queryOptions, validContext);
    expect(typeof queryOptions.systemPrompt).toBe('string');
    expect(queryOptions.systemPrompt).toContain('existing prompt');
    expect(queryOptions.systemPrompt).toContain('list_tasks');
  });

  it('preserves existing preset.append content (accumulation not overwrite)', async () => {
    const queryOptions: any = {
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: 'ORIGINAL_APPEND',
      },
    };
    await integrateDootaskMcpServer(queryOptions, validContext);
    expect(queryOptions.systemPrompt.append).toContain('ORIGINAL_APPEND');
    expect(queryOptions.systemPrompt.append).toContain('list_tasks');
  });
});

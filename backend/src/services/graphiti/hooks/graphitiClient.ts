// backend/src/services/graphiti/hooks/graphitiClient.ts

import type { GraphitiContext } from '../types.js';
import type { GraphitiSearchResponse, ProfileQuery, FactResult } from './types.js';

/** 默认超时时间 (毫秒) */
const DEFAULT_TIMEOUT_MS = 5000;

/** 每个维度最大结果数 */
const DEFAULT_MAX_FACTS = 3;

/**
 * 从 Graphiti 搜索指定维度的 facts
 *
 * @param context - Graphiti 上下文
 * @param query - 搜索查询
 * @param maxFacts - 最大结果数
 * @param timeoutMs - 超时时间
 * @returns 匹配的 facts 数组
 */
export async function searchFacts(
  context: GraphitiContext,
  query: string,
  maxFacts: number = DEFAULT_MAX_FACTS,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<FactResult[]> {
  const { base_url, user_id, group_ids = [], api_key } = context;
  const allGroupIds = [`user_${user_id}`, ...group_ids];

  console.log(`🔍 [Graphiti] Searching: "${query}" in groups:`, allGroupIds);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${base_url}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(api_key ? { 'Authorization': `Bearer ${api_key}` } : {}),
      },
      body: JSON.stringify({
        query,
        group_ids: allGroupIds,
        max_facts: maxFacts,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[Graphiti] Search failed: ${response.status}`);
      return [];
    }

    const data: GraphitiSearchResponse = await response.json();
    console.log(`📦 [Graphiti] Search result for "${query}":`, data.facts?.length || 0, 'facts');
    return data.facts || [];
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn('[Graphiti] Search timeout');
    } else {
      console.warn('[Graphiti] Search error:', error);
    }
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 并行搜索多个维度
 *
 * @param context - Graphiti 上下文
 * @param queries - 搜索维度列表
 * @param maxFactsPerCategory - 每个维度最大结果数
 * @param timeoutMs - 每个搜索的超时时间
 * @returns 按分类名称组织的结果 Map
 */
export async function searchMultipleCategories(
  context: GraphitiContext,
  queries: ProfileQuery[],
  maxFactsPerCategory: number = DEFAULT_MAX_FACTS,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Map<string, string[]>> {
  const results = new Map<string, string[]>();

  const searchPromises = queries.map(async ({ category, query }) => {
    const facts = await searchFacts(context, query, maxFactsPerCategory, timeoutMs);
    const factTexts = facts.map(f => f.fact).filter(Boolean);
    if (factTexts.length > 0) {
      results.set(category, factTexts);
    }
  });

  await Promise.all(searchPromises);

  return results;
}

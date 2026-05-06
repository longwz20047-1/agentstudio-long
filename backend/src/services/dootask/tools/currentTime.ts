/**
 * 当前时间工具（1 个）
 *
 * 解决：A2A 聊天里 LLM 没有实时时间概念，会凭历史消息推断"今天"造成日期偏差。
 *      session reuse 模式下，systemPrompt 注入的时间锚也会被锁定为首次 init 时的快照。
 *
 * 设计：
 *   · 每次 LLM 调用本工具都返回**真实当前时间**（中国时区 Asia/Shanghai）
 *   · 不依赖 systemPrompt 缓存，per-request 真实
 *   · LLM 在涉及时间的场景应主动调用：
 *     - 用户问"现在几点 / 今天 / 本周"
 *     - create_task 算 start_at/end_at（"3 天后" = now + 3 day）
 *     - list_tasks(time='today') 换算 YYYY-MM-DD 范围
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { ToolContext } from './types.js';

export function buildCurrentTimeTools(_ctx: ToolContext) {
  const getCurrentTime = tool(
    'get_current_time',
    `获取**当前实时时间**（中国标准时间 Asia/Shanghai UTC+8）。

⚠️ MUST 调用场景：
1. 用户问"现在几点 / 今天几号 / 星期几"——必须调本工具，不能凭 systemPrompt 时间锚回答
   （systemPrompt 的时间锚在 session reuse 时会被冻结为首次 init 时间，**不准确**）
2. create_task 计算 start_at/end_at 时（如用户说"3 天后截止"）——先调本工具拿 now，再 + 3 天
3. list_tasks 用相对时间过滤时（如 time='today'）——先调本工具确定具体 YYYY-MM-DD 范围
4. 任何涉及"今天/明天/本周/本月/Q1"等相对时间词的判断

返回字段：
- iso: 完整 ISO 字符串（YYYY-MM-DD HH:mm:ss）
- date: 仅日期 YYYY-MM-DD
- time: 仅时间 HH:mm:ss
- timestamp: Unix 毫秒时间戳
- weekday: 星期几（中文，如"星期三"）
- timezone: "Asia/Shanghai (UTC+8)"
- ranges: 常用相对时间区间预计算（today/yesterday/this_week/this_month）`,
    {},
    async () => {
      const now = new Date();
      const tz = 'Asia/Shanghai';

      // 格式化当前时间（中国时区）
      const fmt = new Intl.DateTimeFormat('zh-CN', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      });
      const parts = fmt.formatToParts(now).reduce<Record<string, string>>((acc, p) => {
        if (p.type !== 'literal') acc[p.type] = p.value;
        return acc;
      }, {});
      const date = `${parts.year}-${parts.month}-${parts.day}`;
      const time = `${parts.hour}:${parts.minute}:${parts.second}`;
      const iso = `${date} ${time}`;

      const weekdayFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, weekday: 'long' });
      const weekday = weekdayFmt.format(now); // "星期三"

      // 预计算常用相对时间区间（基于中国时区 0:00:00 / 23:59:59）
      const todayStart = `${date} 00:00:00`;
      const todayEnd = `${date} 23:59:59`;

      // 计算昨天日期
      const yesterdayDate = new Date(now);
      yesterdayDate.setDate(yesterdayDate.getDate() - 1);
      const yesterdayParts = fmt.formatToParts(yesterdayDate).reduce<Record<string, string>>((acc, p) => {
        if (p.type !== 'literal') acc[p.type] = p.value;
        return acc;
      }, {});
      const yesterday = `${yesterdayParts.year}-${yesterdayParts.month}-${yesterdayParts.day}`;

      // 计算本周（周一开始）
      // CN convention: 周一是一周的开始
      const dayOfWeek = now.getDay(); // 0=日, 1=一, ..., 6=六
      const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const weekStart = new Date(now);
      weekStart.setDate(weekStart.getDate() - daysSinceMonday);
      const weekStartParts = fmt.formatToParts(weekStart).reduce<Record<string, string>>((acc, p) => {
        if (p.type !== 'literal') acc[p.type] = p.value;
        return acc;
      }, {});
      const weekStartDate = `${weekStartParts.year}-${weekStartParts.month}-${weekStartParts.day}`;

      // 计算本月开始
      const monthStart = `${parts.year}-${parts.month}-01`;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            iso,
            date,
            time,
            timestamp: now.getTime(),
            weekday,
            timezone: 'Asia/Shanghai (UTC+8)',
            ranges: {
              today: { start: todayStart, end: todayEnd },
              yesterday: { start: `${yesterday} 00:00:00`, end: `${yesterday} 23:59:59` },
              this_week: { start: `${weekStartDate} 00:00:00`, note: '从周一开始' },
              this_month: { start: `${monthStart} 00:00:00`, note: '从本月 1 号开始' },
            },
            usage_hint: '本工具返回的是实时时间，比 systemPrompt 时间锚更可靠（reuse session 不会冻结此结果）。',
          }, null, 2),
        }],
      };
    },
  );

  return [getCurrentTime];
}

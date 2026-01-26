---
title: bypassPermissions 权限模式问题
date: 2026-01-26
tags:
  - bug
  - sdk
  - claude-agent-sdk
  - permissions
status: open
priority: high
---

# bypassPermissions 权限模式问题

## 问题概述

> [!bug] SDK Bug
> Claude Agent SDK 的 `bypassPermissions` 权限模式无法正常工作，无论是在 Docker 容器中还是直接在服务器运行都会报错。

```
Error: Claude Code process exited with code 1
```

## 官方 Issue

> [!info] 相关链接
> - **Issue**: [#54 - BypassPermissions errors with Code 1](https://github.com/anthropics/claude-agent-sdk-typescript/issues/54)
> - **状态**: ==Open（未解决）==
> - **SDK 版本**: `@anthropic-ai/claude-agent-sdk@0.2.19`

## 测试结论

| 环境 | acceptEdits | bypassPermissions |
|:-----|:-----------:|:-----------------:|
| Docker 容器 | ✅ 正常 | ❌ 报错 |
| 服务器直接运行 | ✅ 正常 | ❌ 报错 |

> [!important] 结论
> 这是 SDK 本身的 bug，与运行环境无关。

---

## 已完成的修改

### 1. 前端默认权限模式

> [!success] 已修复

**文件**: `frontend/src/hooks/agentChat/useToolSelector.ts:14`

```typescript
// 修改前
const [permissionMode, setPermissionMode] = useState<...>('bypassPermissions');

// 修改后
const [permissionMode, setPermissionMode] = useState<...>('acceptEdits');
```

### 2. SDK 安全参数（保留）

**文件**: `backend/src/utils/claudeUtils.ts:279-280`

```typescript
// SDK 要求：使用 bypassPermissions 模式时必须显式设置此参数
...(finalPermissionMode === 'bypassPermissions' && { allowDangerouslySkipPermissions: true }),
```

> [!note]
> 此代码保留，以便将来 SDK 修复后可直接使用。

---

## 待修改的代码

> [!warning] 待处理
> 如果需要让 A2A 和定时任务功能正常工作，需要将以下位置的 `bypassPermissions` 改为 `acceptEdits`。

### 修改清单

|  #  | 文件                                                | 行号  | 说明                              |
| :-: | :------------------------------------------------ | :-: | :------------------------------ |
|  1  | `backend/src/routes/a2a.ts`                       | 239 | A2A 同步调用 - agent 配置             |
|  2  | `backend/src/routes/a2a.ts`                       | 243 | A2A 同步调用 - buildQueryOptions 参数 |
|  3  | `backend/src/routes/a2a.ts`                       | 711 | A2A 异步任务创建                      |
|  4  | `backend/src/services/schedulerService.ts`        | 454 | 定时任务执行                          |
|  5  | `backend/src/services/taskExecutor/taskWorker.ts` | 90  | 任务执行器默认值                        |
|  6  | `backend/src/services/taskExecutor/types.ts`      | 16  | 类型定义（添加 acceptEdits）            |

### 详细修改内容

#### 1-2. A2A 路由 - 同步调用

**文件**: `backend/src/routes/a2a.ts`

```typescript
// 行 239
permissionMode: 'bypassPermissions', // A2A 需要绕过权限，否则会卡住等待确认
// 改为
permissionMode: 'acceptEdits',

// 行 243
'bypassPermissions', // permissionMode - A2A 必须绕过权限
// 改为
'acceptEdits',
```

#### 3. A2A 路由 - 异步任务

**文件**: `backend/src/routes/a2a.ts`

```typescript
// 行 711
permissionMode: 'bypassPermissions',
// 改为
permissionMode: 'acceptEdits',
```

#### 4. 定时任务服务

**文件**: `backend/src/services/schedulerService.ts`

```typescript
// 行 454
permissionMode: 'bypassPermissions',
// 改为
permissionMode: 'acceptEdits',
```

#### 5. 任务执行器

**文件**: `backend/src/services/taskExecutor/taskWorker.ts`

```typescript
// 行 90
const permissionMode = task.permissionMode || 'bypassPermissions';
// 改为
const permissionMode = task.permissionMode || 'acceptEdits';
```

#### 6. 类型定义

**文件**: `backend/src/services/taskExecutor/types.ts`

```typescript
// 行 16
export type PermissionMode = 'bypassPermissions' | 'default';
// 改为
export type PermissionMode = 'bypassPermissions' | 'acceptEdits' | 'default';
```

---

## 注意事项

### acceptEdits 模式的限制

> [!caution] 功能限制
> - ✅ 自动接受文件编辑操作（Read、Write、Edit）
> - ⚠️ Bash 命令等危险操作可能需要确认或被拒绝
> - ⚠️ 无人值守的自动化任务可能会卡住等待确认

### 受影响的功能

1. **A2A（Agent-to-Agent）通信** - agent 之间自动通信
2. **定时任务** - 按计划自动执行的任务
3. **异步任务执行器** - 后台任务处理

---

## 建议

> [!tip] 处理建议
> 1. 如果暂时不使用 A2A 和定时任务功能，可以先不修改
> 2. 持续关注 [Issue #54](https://github.com/anthropics/claude-agent-sdk-typescript/issues/54) 的修复进展
> 3. SDK 修复后，将上述代码改回 `bypassPermissions`

---

## 相关链接

- [Claude Agent SDK GitHub](https://github.com/anthropics/claude-agent-sdk-typescript)
- [AgentStudio GitHub](https://github.com/okguitar/agentstudio)
- [Issue #54 - BypassPermissions errors with Code 1](https://github.com/anthropics/claude-agent-sdk-typescript/issues/54)

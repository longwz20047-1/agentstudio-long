import React from 'react';
import { useTranslation } from 'react-i18next';
import { BaseToolComponent, ToolInput } from './BaseToolComponent';
import type { BaseToolExecution, BashOutputToolResult } from './sdk-types';
import type { TaskOutputInput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';
import { Terminal, AlertCircle } from 'lucide-react';

interface TaskOutputToolProps {
  execution: BaseToolExecution;
}

export const TaskOutputTool: React.FC<TaskOutputToolProps> = ({ execution }) => {
  const { t } = useTranslation('components');
  const input = execution.toolInput as unknown as TaskOutputInput;

  const getSubtitle = () => {
    if (!input.task_id) return undefined;
    return `${t('taskOutputTool.taskPrefix')} ${input.task_id}`;
  };

  // TaskOutput result can be BashOutputToolResult or plain string
  const parseResult = (): { stdout: string; stderr: string; status?: string; exitCode?: number | null } | null => {
    if (!execution.toolUseResult && !execution.toolResult) return null;

    const raw = execution.toolUseResult || execution.toolResult;

    if (typeof raw === 'object' && raw !== null) {
      const obj = raw as BashOutputToolResult;
      return {
        stdout: obj.stdout || '',
        stderr: obj.stderr || '',
        status: obj.status,
        exitCode: obj.exitCode,
      };
    }

    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return {
          stdout: parsed.stdout || parsed.output || '',
          stderr: parsed.stderr || '',
          status: parsed.status,
          exitCode: parsed.exitCode ?? parsed.exit_code ?? null,
        };
      } catch {
        // Plain text output
        return { stdout: raw, stderr: '' };
      }
    }

    return null;
  };

  const result = parseResult();

  return (
    <BaseToolComponent execution={execution} subtitle={getSubtitle()} showResult={false} hideToolName={false}>
      <div className="space-y-2">
        <ToolInput label={t('taskOutputTool.taskId')} value={input.task_id} isCode={true} />
        <div className="flex gap-4 text-xs text-gray-500 dark:text-gray-400">
          {input.block !== undefined && (
            <span>{t('taskOutputTool.blocking')}: {input.block ? t('taskOutputTool.yes') : t('taskOutputTool.no')}</span>
          )}
          {input.timeout !== undefined && (
            <span>{t('taskOutputTool.timeout')}: {(input.timeout / 1000).toFixed(0)}s</span>
          )}
        </div>
      </div>

      {result && (
        <div className="mt-3 space-y-3">
          {result.stdout && (
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                <Terminal className="w-3.5 h-3.5" />
                {t('taskOutputTool.output')}
              </div>
              <pre className="bg-gray-900 text-green-400 rounded-lg px-3 py-2 text-sm font-mono overflow-x-auto whitespace-pre-wrap border border-gray-700 max-h-64 overflow-y-auto">
                {result.stdout.trim()}
              </pre>
            </div>
          )}

          {result.stderr && (
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-red-700 dark:text-red-400 mb-1">
                <AlertCircle className="w-3.5 h-3.5" />
                {t('taskOutputTool.stderr')}
              </div>
              <pre className="bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 border border-red-200 dark:border-red-700 rounded-lg px-3 py-2 text-sm font-mono overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">
                {result.stderr.trim()}
              </pre>
            </div>
          )}

          {result.exitCode !== undefined && result.exitCode !== null && (
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {t('taskOutputTool.exitCode')}: {result.exitCode}
            </div>
          )}
        </div>
      )}

      {!result && execution.isExecuting && (
        <div className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          {t('taskOutputTool.waiting', { taskId: input.task_id })}
        </div>
      )}
    </BaseToolComponent>
  );
};

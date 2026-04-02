import type { CronJob } from '../../types/a2aCron.js';

export function maskJobContext(job: CronJob): CronJob {
  const { sdkSessionId: _, ...safeJob } = job;
  if (!safeJob.context?.weknora?.api_key) return safeJob as CronJob;
  return {
    ...safeJob,
    context: {
      ...safeJob.context,
      weknora: {
        ...safeJob.context.weknora,
        api_key: safeJob.context.weknora.api_key.slice(0, 8) + '***',
      },
    },
  } as CronJob;
}

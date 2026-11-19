// In-memory background jobs. Long AI work (a group request ~30s, building a twin) runs here
// so the browser can poll its progress and show it live (the twins' DM chat).

import { randomUUID } from 'node:crypto';
import type { Job, JobEvent } from '../shared/types';

const jobs = new Map<string, Job>();

export type Emit = (e: Omit<JobEvent, 'at'>) => void;
export const noEmit: Emit = () => {};

export function startJob(kind: Job['kind'], work: (emit: Emit) => Promise<Record<string, string>>): Job {
  const job: Job = { id: `job-${randomUUID().slice(0, 8)}`, kind, status: 'running', events: [] };
  jobs.set(job.id, job);
  const emit: Emit = (e) => job.events.push({ ...e, at: Date.now() });
  work(emit)
    .then((result) => {
      job.result = result;
      job.status = 'done';
    })
    .catch((err: unknown) => {
      job.error = err instanceof Error ? err.message : String(err);
      job.status = 'error';
      console.error(`[job ${job.id}]`, err);
    });
  // Forget finished jobs after an hour.
  setTimeout(() => jobs.delete(job.id), 3600_000).unref?.();
  return job;
}

export function getJob(id: string, since = 0): (Omit<Job, 'events'> & { events: JobEvent[]; total: number }) | null {
  const j = jobs.get(id);
  if (!j) return null;
  return { ...j, events: j.events.slice(since), total: j.events.length };
}

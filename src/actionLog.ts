/**
 * Writes one JSON line per event to the browser console so admins can trace
 * what the app did and whether persistence succeeded.
 */

export type OpenQueueLogCategory = 'interaction' | 'persistence' | 'data_load';

export type OpenQueueLogStatus =
  | 'started'
  | 'applied'
  | 'success'
  | 'failed'
  | 'skipped';

export interface OpenQueueActionLog {
  v: 1;
  timestamp: string;
  category: OpenQueueLogCategory;
  action: string;
  trigger: string;
  status: OpenQueueLogStatus;
  persistence: 'none' | 'local' | 'supabase';
  detail?: Record<string, unknown>;
  error?: string;
}

const nowIso = () => new Date().toISOString();

const interactionThrottleMs = 600;
const lastInteractionLogAt = new Map<string, number>();

export const logOpenQueueAction = (entry: Omit<OpenQueueActionLog, 'v' | 'timestamp'>): void => {
  const payload: OpenQueueActionLog = {
    v: 1,
    timestamp: nowIso(),
    ...entry,
  };
  console.log(JSON.stringify(payload));
};

/**
 * Logs a user-driven UI change. When `throttleKey` is set, repeated logs for the
 * same key within `interactionThrottleMs` are dropped (typing in inputs).
 */
export const logUserInteraction = (
  entry: Omit<OpenQueueActionLog, 'v' | 'timestamp' | 'category'>,
  options?: { throttleKey?: string },
): void => {
  if (options?.throttleKey) {
    const key = options.throttleKey;
    const last = lastInteractionLogAt.get(key) ?? 0;
    if (Date.now() - last < interactionThrottleMs) {
      return;
    }
    lastInteractionLogAt.set(key, Date.now());
  }

  logOpenQueueAction({ category: 'interaction', ...entry });
};

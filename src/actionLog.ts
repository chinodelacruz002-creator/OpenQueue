/**
 * Writes one JSON line per user-driven action to the browser console.
 * Automated loads and saves are not logged here (they are not user actions).
 */

export type UserActionLogStatus =
  | 'started'
  | 'applied'
  | 'success'
  | 'failed'
  | 'skipped';

export interface UserActionLog {
  v: 1;
  timestamp: string;
  category: 'user_action';
  action: string;
  trigger: string;
  status: UserActionLogStatus;
  persistence: 'none' | 'local' | 'supabase';
  detail?: Record<string, unknown>;
  error?: string;
}

const nowIso = () => new Date().toISOString();

const interactionThrottleMs = 600;
const lastInteractionLogAt = new Map<string, number>();

/**
 * Logs a user-driven UI change. When `throttleKey` is set, repeated logs for the
 * same key within `interactionThrottleMs` are dropped (typing in inputs).
 */
export const logUserInteraction = (
  entry: Omit<UserActionLog, 'v' | 'timestamp' | 'category'>,
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

  const payload: UserActionLog = {
    v: 1,
    timestamp: nowIso(),
    category: 'user_action',
    ...entry,
  };
  console.log(JSON.stringify(payload));
};

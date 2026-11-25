import { FIELD_POLICIES, NEVER_SEND_KEYS, type TaskType } from './field-policies';

export type CaseRecord = Record<string, unknown>;

export interface ContextLogger {
  /** Receives field names only, never values. */
  logFieldSet(entry: { taskType: string; fields: string[] }): void;
}

export interface BuiltContext {
  ok: true;
  taskType: TaskType;
  /** Only allowed fields, nested as in the source record. */
  context: Record<string, unknown>;
  /** Dot paths actually present in the context. */
  fields: string[];
}

/** Planner should create a human task when it receives this. */
export interface RefusedContext {
  ok: false;
  reason: 'unknown_task_type';
  taskType: string;
}

export type ContextResult = BuiltContext | RefusedContext;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isBlocked = (key: string): boolean => NEVER_SEND_KEYS.includes(key.toLowerCase());

/** Remove never-send keys from any nested value. */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!isBlocked(k)) out[k] = scrub(v);
    return out;
  }
  return value;
}

export function hasFieldPolicy(taskType: string): taskType is TaskType {
  return Object.prototype.hasOwnProperty.call(FIELD_POLICIES, taskType);
}

/** Build the minimum-necessary context for a task. Refuses task types with no policy. */
export function buildContext(
  taskType: string,
  caseRecord: CaseRecord,
  logger?: ContextLogger,
): ContextResult {
  if (!hasFieldPolicy(taskType)) return { ok: false, reason: 'unknown_task_type', taskType };

  const context: Record<string, unknown> = {};
  const fields: string[] = [];
  for (const path of FIELD_POLICIES[taskType]) {
    const segments = path.split('.');
    if (segments.some(isBlocked)) continue;
    let cur: unknown = caseRecord;
    for (const s of segments) {
      cur = isObject(cur) && Object.prototype.hasOwnProperty.call(cur, s) ? cur[s] : undefined;
    }
    if (cur === undefined) continue;
    let target = context;
    for (const s of segments.slice(0, -1)) {
      const next = target[s];
      target = isObject(next) ? next : (target[s] = {});
    }
    target[segments[segments.length - 1] as string] = scrub(cur);
    fields.push(path);
  }
  logger?.logFieldSet({ taskType, fields: [...fields] });
  return { ok: true, taskType, context, fields };
}

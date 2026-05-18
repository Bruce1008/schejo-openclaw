// MVP-4: plugin-side state-0.1 persistence.
// schema 见 docs/contracts/mvp-data-contract.md §8.1；ADR 0008 规定 state 在 plugin 本地
// 持久化（${process.cwd()}/schejo-state.json）。cloud 端有 validate-state.mjs 是 schema 的
// 同步副本——改 schema 时务必同步两份。

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const STATE_SCHEMA_VERSION = "state-0.1";
const SIGNAL_TTL_MS = 72 * 60 * 60 * 1000;

const STATE_FILE_NAME = "schejo-state.json";

export type UserStateStatus =
  | "available"
  | "sick"
  | "injured"
  | "busy"
  | "traveling"
  | "low_motivation";

export type InjuryStatus = "active" | "recovered" | "chronic";

export type QuestionKind = "injury_check" | "status_change" | "signal_capture";

export interface Injury {
  description: string;
  reported_at: string; // YYYY-MM-DD
  status: InjuryStatus;
  next_check_at: string | null;
}

export interface BodySignal {
  type: string;
  detail: string;
  ts: string; // ISO8601 with tz
}

export interface State {
  schema_version: typeof STATE_SCHEMA_VERSION;
  updated_at: string;
  user_state: {
    status: UserStateStatus;
    since: string;
    next_check: string | null;
  };
  injuries: Injury[];
  signals: {
    body: BodySignal[];
  };
}

export interface Reminder {
  kind: QuestionKind;
  injury_idx?: number;
  description?: string;
  next_check_at?: string;
}

export interface UserAnswerEvent {
  question_id: string;
  answer: string;
  answered_at: string;
  context: {
    kind: QuestionKind;
    injury_idx?: number;
  };
}

function getStatePath(): string {
  return resolve(process.cwd(), STATE_FILE_NAME);
}

// "今天"按 Asia/Shanghai 计算——避免中国早晨 UTC 还在昨天导致 reminder 晚一天。
// sv-SE locale 直接输出 YYYY-MM-DD 形态，省得自己拼 Intl 字段。
function todayDate(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyState(): State {
  const today = todayDate();
  return {
    schema_version: STATE_SCHEMA_VERSION,
    updated_at: nowIso(),
    user_state: { status: "available", since: today, next_check: null },
    injuries: [],
    signals: { body: [] }
  };
}

function isStateShape(value: unknown): value is State {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.schema_version !== STATE_SCHEMA_VERSION) return false;
  if (typeof v.updated_at !== "string") return false;
  if (!v.user_state || typeof v.user_state !== "object") return false;
  if (!Array.isArray(v.injuries)) return false;
  if (!v.signals || typeof v.signals !== "object") return false;
  if (!Array.isArray((v.signals as { body?: unknown }).body)) return false;
  return true;
}

export function loadState(): State {
  const path = getStatePath();
  if (!existsSync(path)) {
    return emptyState();
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isStateShape(parsed)) {
      backupCorruptFile(path, "shape mismatch");
      return emptyState();
    }
    return parsed;
  } catch (error) {
    backupCorruptFile(path, error instanceof Error ? error.message : String(error));
    return emptyState();
  }
}

function backupCorruptFile(path: string, reason: string): void {
  try {
    const backup = `${path}.corrupted-${Date.now()}.bak`;
    renameSync(path, backup);
    console.error(`[schejo] state_corrupted backup=${backup} reason=${reason}`);
  } catch (renameError) {
    console.error(
      `[schejo] state_corrupted_backup_failed reason=${reason} rename_error=${renameError instanceof Error ? renameError.message : String(renameError)}`
    );
  }
}

export function saveState(state: State): void {
  const path = getStatePath();
  const next: State = { ...state, updated_at: nowIso() };
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export function cleanExpiredSignals(state: State, now: Date = new Date()): State {
  const cutoff = now.getTime() - SIGNAL_TTL_MS;
  const fresh = state.signals.body.filter((s) => {
    const ts = Date.parse(s.ts);
    return Number.isFinite(ts) && ts >= cutoff;
  });
  if (fresh.length === state.signals.body.length) return state;
  return { ...state, signals: { body: fresh } };
}

export function checkReminders(state: State, today: string = todayDate()): Reminder[] {
  const reminders: Reminder[] = [];
  state.injuries.forEach((injury, idx) => {
    if (injury.status !== "active") return;
    if (!injury.next_check_at) return;
    if (injury.next_check_at <= today) {
      reminders.push({
        kind: "injury_check",
        injury_idx: idx,
        description: injury.description,
        next_check_at: injury.next_check_at
      });
    }
  });
  return reminders;
}

// processAnswer 规则见 docs/contracts/mvp-data-contract.md §8.1.2 与 ADR 0008。
// 输入：当前 state + user_answer event；输出：mutated state（caller 自己 saveState）。
export function processAnswer(state: State, event: UserAnswerEvent): State {
  switch (event.context.kind) {
    case "injury_check":
      return processInjuryCheckAnswer(state, event);
    case "status_change":
      return processStatusChangeAnswer(state, event);
    case "signal_capture":
      return processSignalCaptureAnswer(state, event);
    default:
      return state;
  }
}

function processInjuryCheckAnswer(state: State, event: UserAnswerEvent): State {
  const idx = event.context.injury_idx;
  if (typeof idx !== "number" || idx < 0 || idx >= state.injuries.length) {
    console.error(`[schejo] state_answer_injury_idx_out_of_range idx=${idx}`);
    return state;
  }

  const today = todayDate();
  const answer = event.answer.trim();
  const updated = [...state.injuries];
  const current = { ...updated[idx] };

  // 简单关键词路由——与 healthyclaw references/reminders.md 表格一致。
  // 自由文本只读 quick_answers 的语义，没匹配到时保守保留 active 状态、把 next_check_at
  // 推迟 7 天，避免反复同日询问。
  if (/好了|恢复|已恢复/.test(answer)) {
    current.status = "recovered";
    current.next_check_at = null;
  } else if (/快好|好转/.test(answer)) {
    current.next_check_at = addDays(today, 7);
  } else if (/没好|还在|还疼|仍|没好/.test(answer)) {
    current.reported_at = today;
    current.next_check_at = addDays(today, 14);
  } else if (/老毛病|长期|慢性/.test(answer)) {
    current.status = "chronic";
    current.next_check_at = null;
  } else {
    current.next_check_at = addDays(today, 7);
  }

  updated[idx] = current;
  return { ...state, injuries: updated };
}

function processStatusChangeAnswer(state: State, event: UserAnswerEvent): State {
  const today = todayDate();
  return {
    ...state,
    user_state: {
      ...state.user_state,
      status: state.user_state.status,
      since: today,
      next_check: addDays(today, 14)
    },
    signals: {
      body: [
        ...state.signals.body,
        { type: "status_change_answer", detail: event.answer, ts: event.answered_at }
      ]
    }
  };
}

function processSignalCaptureAnswer(state: State, event: UserAnswerEvent): State {
  return {
    ...state,
    signals: {
      body: [
        ...state.signals.body,
        { type: "signal_answer", detail: event.answer, ts: event.answered_at }
      ]
    }
  };
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 给 LLM 工具调用用：往 state.injuries 加一条新伤
export function addInjury(state: State, input: { description: string; status?: InjuryStatus; nextCheckAtDays?: number }): State {
  const today = todayDate();
  const status: InjuryStatus = input.status ?? "active";
  const next_check_at =
    status === "active" ? addDays(today, input.nextCheckAtDays ?? 14) : null;
  const injury: Injury = {
    description: input.description.slice(0, 200),
    reported_at: today,
    status,
    next_check_at
  };
  return { ...state, injuries: [...state.injuries, injury] };
}

// 给 LLM 工具调用用：改 user_state.status
export function changeStatus(state: State, input: { to: UserStateStatus; nextCheckAtDays?: number | null }): State {
  const today = todayDate();
  const next_check =
    input.nextCheckAtDays === null || input.nextCheckAtDays === undefined
      ? null
      : addDays(today, input.nextCheckAtDays);
  return {
    ...state,
    user_state: { status: input.to, since: today, next_check }
  };
}

// 给 LLM 工具调用用：往 signals.body push 一条
export function pushBodySignal(state: State, input: { type: string; detail: string }): State {
  return {
    ...state,
    signals: {
      body: [
        ...state.signals.body,
        { type: input.type, detail: input.detail.slice(0, 200), ts: nowIso() }
      ]
    }
  };
}

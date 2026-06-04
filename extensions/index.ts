import { randomUUID } from "node:crypto";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/direct-dm";
import { jsonResult } from "openclaw/plugin-sdk/core";
import {
  createChannelPluginBase,
  createChatChannelPlugin,
  defineChannelPluginEntry,
  type OpenClawConfig,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-core";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import {
  createRawChannelSendResultAdapter,
  type ChannelSendRawResult,
} from "openclaw/plugin-sdk/channel-send-result";
import type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { Type } from "typebox";
import {
  addInjury,
  buildReadStateSnapshot,
  changeStatus,
  checkReminders,
  cleanExpiredSignals,
  loadState,
  processAnswer,
  pushBodySignal,
  saveState,
  type Reminder,
  type State,
  type UserAnswerEvent,
  type UserStateStatus,
} from "./state.js";

const CHANNEL_ID = "schejo";
const DEFAULT_ACCOUNT_ID = "ios";
const SCHEJO_SKILL_PREFIX = "使用schejo skill。";
const SCHEJO_SKILL_PREFIX_WITH_SPACE = "使用schejo skill 。";
const LEGACY_THIN_SLICE_SKILL_PREFIX = "请使用schejo skill,";
// MVP-1 时代的 ping 兜底——若 agent 在该时长内没回复，plugin 用 "spike-ack: <body>"
// 自己应一句，保证 iPhone 收到回执（防 SSE 链路看起来死掉）。MVP-4.5 起 iPhone
// 改成发任意自由文本，真 LLM 推理常常 5-15 秒，所以原 1500ms 会被 timer 抢先发 ack
// 把真 LLM reply 阻塞掉。放到 60s 既保留 ping/链路死锁兜底，又让正常 LLM 回复跑完。
const THIN_SLICE_FALLBACK_DELAY_MS = 60_000;
const DAILY_REPORT_PROMPT_PREFIX = `${SCHEJO_SKILL_PREFIX}请生成今日健康报告`;
const DAILY_REPORT_PENDING_TTL_MS = 5 * 60 * 1000;
const ACTIVE_PULL_TIMEOUT_MS = 90 * 1000;
const DAILY_REPORT_KEY_METRIC_KEYS = [
  "resting_hr_bpm",
  "hrv_sdnn_ms",
  "sleep_total_min",
  "sleep_efficiency",
  "steps",
  "exercise_min",
  "active_kcal",
] as const;
const QUESTION_CONTEXT_KINDS = new Set(["injury_check", "status_change", "signal_capture"]);
const REPORT_TEXT_UNSUPPORTED_PATTERNS = [
  /佩戴/,
  /设备/,
  /监测连续/,
  /检查/,
  /Apple\s*Watch/i,
  /HealthKit/i,
  /OpenClaw/i,
  /prompt/i,
  /JSON/i,
  /schema/i,
  /训练计划/,
  /训练目标/,
  /医生/,
  /就医/,
  /用药/,
  /疾病/,
  /诊断/,
];

type JsonRecord = Record<string, unknown>;
type SchejoSendResult = ChannelSendRawResult;
type SchejoLogContext = { log?: { info: (message: string) => void } | null };

type SchejoAccount = {
  accountId: string;
  cloudUrl: string;
  configured: true;
  enabled: true;
};

type SchejoRuntimeState = {
  cloudUrl: string;
  openclawUserId: string;
  pairingCode: string;
};

type PendingDailyReportRequest = {
  requestId: string;
  summary: JsonRecord;
  createdAt: number;
  rawOutput?: string;
  submittedReport?: JsonRecord;
};

type DailyReportDeliveryResult =
  | {
      status: "ready";
      requestId: string;
      rawOutput: string;
      report: JsonRecord;
    }
  | {
      status: "failed";
      requestId: string;
      rawOutput?: string;
      error: string;
    };

type ActivePullSummary = {
  pluginRequestId: string;
  requestId: string;
  summary: JsonRecord;
  userProfile?: JsonRecord;
};

type PendingActivePull = {
  createdAt: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (summary: ActivePullSummary) => void;
  reject: (error: Error) => void;
};

type SchejoSseEvent = {
  type?: unknown;
  body?: unknown;
  id?: unknown;
  request_id?: unknown;
  plugin_request_id?: unknown;
  summary?: unknown;
  user_profile?: unknown;
  timestamp?: unknown;
  // MVP-4 user_answer fields
  question_id?: unknown;
  answer?: unknown;
  answered_at?: unknown;
  context?: unknown;
};

type ReminderForPrompt = {
  reminder: Reminder;
  questionId: string;
};

type SchejoChatChannelParams = Parameters<typeof createChatChannelPlugin<SchejoAccount>>[0];
type SchejoGatewayContext = ChannelGatewayContext<SchejoAccount>;
type SchejoDirectDmRuntime = Parameters<typeof dispatchInboundDirectDmWithRuntime>[0]["runtime"];

let runtimeState: SchejoRuntimeState | null = null;
let activeGatewayContext: SchejoGatewayContext | null = null;
const pendingDailyReports = new Map<string, PendingDailyReportRequest>();
const pendingActivePulls = new Map<string, PendingActivePull>();

function log(message: string): void {
  console.error(message);
}

function logWithContext(input: object, message: string): void {
  const ctx = input as SchejoLogContext;
  const emit = ctx.log?.info?.bind(ctx.log) ?? log;
  emit(message);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function roundMetric(value: unknown): number {
  const number = readFiniteNumber(value);
  return number === undefined ? 0 : Math.max(0, Math.round(number));
}

function round2Metric(value: unknown): number {
  const number = readFiniteNumber(value);
  return number === undefined ? 0 : Math.max(0, Math.round(number * 100) / 100);
}

function coalesceNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = readFiniteNumber(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

function clampMetric(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function currentIso8601WithOffset(): string {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().replace(/\.\d{3}Z$/, "+08:00");
}

function isIso8601WithOffset(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function containsUnsupportedReportText(text: string): boolean {
  return REPORT_TEXT_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(text));
}

function clipText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function normalizeReportText(value: unknown, maxChars: number, fallback: string): string {
  const text = readString(value);
  if (!text || containsUnsupportedReportText(text)) {
    return clipText(fallback, maxChars);
  }
  return clipText(text, maxChars);
}

function pickPath(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    const record = asRecord(current);
    if (!(key in record)) return undefined;
    current = record[key];
  }
  return current;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = readString(value);
    if (text) return text;
  }
  return undefined;
}

function resolvePluginConfig(api: OpenClawPluginApi): JsonRecord {
  const fromApi = asRecord(api.pluginConfig);
  if (Object.keys(fromApi).length > 0) return fromApi;

  return resolvePluginConfigFromConfig(api.config);
}

function resolvePluginConfigFromConfig(config: OpenClawConfig): JsonRecord {
  const cfg = asRecord(config);
  return asRecord(
    pickPath(cfg, ["plugins", "entries", "schejo", "config"]) ??
      pickPath(cfg, ["plugins", "schejo", "config"]),
  );
}

function resolveChannelConfig(cfg: OpenClawConfig): JsonRecord {
  return asRecord(pickPath(cfg, ["channels", "schejo"]));
}

function resolvePairingCode(api: OpenClawPluginApi): string | undefined {
  const pluginConfig = resolvePluginConfig(api);
  const channelConfig = resolveChannelConfig(api.config);
  const anyApi = api as unknown as JsonRecord;

  return firstString(
    process.env.SCHEJO_PAIRING_CODE,
    pluginConfig.pairingCode,
    channelConfig.pairingCode,
    pickPath(anyApi, ["installContext", "pairingCode"]),
    pickPath(anyApi, ["installContext", "config", "pairingCode"]),
    pickPath(anyApi, ["setup", "pairingCode"]),
  );
}

function resolvePairingCodeFromConfig(cfg: OpenClawConfig): string | undefined {
  const pluginConfig = resolvePluginConfigFromConfig(cfg);
  const channelConfig = resolveChannelConfig(cfg);

  return firstString(
    process.env.SCHEJO_PAIRING_CODE,
    pluginConfig.pairingCode,
    channelConfig.pairingCode,
  );
}

function resolveCloudUrlFromConfig(cfg: OpenClawConfig): string | undefined {
  const cfgRecord = asRecord(cfg);
  return firstString(
    process.env.SCHEJO_CLOUD_URL,
    pickPath(cfgRecord, ["plugins", "entries", "schejo", "config", "cloudUrl"]),
    pickPath(cfgRecord, ["plugins", "schejo", "config", "cloudUrl"]),
    pickPath(cfgRecord, ["channels", "schejo", "cloudUrl"]),
  );
}

function resolveCloudUrl(api: OpenClawPluginApi): string | undefined {
  const pluginConfig = resolvePluginConfig(api);
  const channelConfig = resolveChannelConfig(api.config);
  return firstString(process.env.SCHEJO_CLOUD_URL, pluginConfig.cloudUrl, channelConfig.cloudUrl);
}

function resolveOpenClawUserId(api: OpenClawPluginApi): string {
  const pluginConfig = resolvePluginConfig(api);
  const channelConfig = resolveChannelConfig(api.config);
  const anyApi = api as unknown as JsonRecord;

  const resolved = firstString(
    process.env.SCHEJO_OPENCLAW_USER_ID,
    pluginConfig.openclawUserId,
    channelConfig.openclawUserId,
    pickPath(anyApi, ["user", "id"]),
    pickPath(anyApi, ["runtime", "user", "id"]),
    pickPath(anyApi, ["runtime", "identity", "userId"]),
    pickPath(anyApi, ["runtime", "operator", "id"]),
    pickPath(anyApi, ["installContext", "openclawUserId"]),
    pickPath(anyApi, ["installContext", "user", "id"]),
  );

  if (resolved) return resolved;

  const fallback = firstString(process.env.USER, process.env.LOGNAME) ?? "local";
  const openclawUserId = `openclaw-${fallback}`;
  log(`[schejo] WARN: cannot read openclaw_user_id from runtime; using ${openclawUserId}`);
  return openclawUserId;
}

function resolveOpenClawUserIdFromConfig(cfg: OpenClawConfig): string {
  const pluginConfig = resolvePluginConfigFromConfig(cfg);
  const channelConfig = resolveChannelConfig(cfg);

  const resolved = firstString(
    process.env.SCHEJO_OPENCLAW_USER_ID,
    pluginConfig.openclawUserId,
    channelConfig.openclawUserId,
  );

  if (resolved) return resolved;

  const fallback = firstString(process.env.USER, process.env.LOGNAME) ?? "local";
  const openclawUserId = `openclaw-${fallback}`;
  log(`[schejo] WARN: cannot read openclaw_user_id from channel runtime; using ${openclawUserId}`);
  return openclawUserId;
}

function endpoint(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\/+/, ""), normalizedBase).toString();
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function clip(text: string, maxLength = 500): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function extractJsonCodeBlock(raw: string): string | undefined {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return match?.[1]?.trim();
}

function extractBalancedJsonObjects(raw: string): string[] {
  const candidates: string[] = [];
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let idx = start; idx < raw.length; idx += 1) {
      const ch = raw[idx];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }

      if (ch === "\"") {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(raw.slice(start, idx + 1).trim());
          break;
        }
      }
    }
  }

  return candidates;
}

function extractDailyReportJsonCandidates(raw: string): string[] {
  const fenced = extractJsonCodeBlock(raw);
  if (fenced) return [fenced];

  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return [trimmed];

  return extractBalancedJsonObjects(raw);
}

function parseDailyReport(raw: string): { ok: true; report: JsonRecord } | { ok: false; error: string } {
  const candidates = extractDailyReportJsonCandidates(raw);
  if (candidates.length === 0) {
    return { ok: false, error: `no json object in raw=${clip(raw)}` };
  }

  let lastError = "unknown parse error";
  for (const jsonText of candidates) {
    try {
      const parsed: unknown = JSON.parse(jsonText);
      if (!isRecord(parsed)) {
        lastError = "daily report JSON must be an object";
        continue;
      }
      return { ok: true, report: parsed };
    } catch (error) {
      lastError = formatError(error);
    }
  }

  return { ok: false, error: `parse: ${lastError}` };
}

function normalizeDailyReportKeyMetrics(report: JsonRecord, summary?: JsonRecord): JsonRecord {
  if (summary) {
    return {
      resting_hr_bpm: roundMetric(
        coalesceNumber(
          pickPath(summary, ["heart_rate", "resting_bpm"]),
          pickPath(summary, ["heart_rate", "hr_p5"]),
          0,
        ),
      ),
      hrv_sdnn_ms: roundMetric(
        coalesceNumber(pickPath(summary, ["heart_rate", "hrv_sdnn_avg_ms"]), 0),
      ),
      sleep_total_min: roundMetric(
        coalesceNumber(pickPath(summary, ["sleep", "total_asleep_min"]), 0),
      ),
      sleep_efficiency: round2Metric(
        clampMetric(round2Metric(coalesceNumber(pickPath(summary, ["sleep", "sleep_efficiency"]), 0)), 0, 1),
      ),
      steps: roundMetric(coalesceNumber(pickPath(summary, ["activity_24h", "steps"]), 0)),
      exercise_min: roundMetric(
        coalesceNumber(pickPath(summary, ["activity_24h", "exercise_minutes"]), 0),
      ),
      active_kcal: roundMetric(
        coalesceNumber(pickPath(summary, ["activity_24h", "active_energy_kcal"]), 0),
      ),
    };
  }

  const metrics = asRecord(report.key_metrics);
  const normalized: JsonRecord = {};
  for (const key of DAILY_REPORT_KEY_METRIC_KEYS) {
    normalized[key] =
      key === "sleep_efficiency"
        ? clampMetric(round2Metric(metrics[key]), 0, 1)
        : roundMetric(metrics[key]);
  }
  return normalized;
}

function isSevereDataInsufficient(summary?: JsonRecord): boolean {
  if (!summary) return false;
  const noHeartSignal =
    roundMetric(pickPath(summary, ["heart_rate", "hr_sample_count"])) === 0 &&
    roundMetric(pickPath(summary, ["heart_rate", "hrv_sample_count"])) === 0 &&
    readFiniteNumber(pickPath(summary, ["heart_rate", "resting_bpm"])) === undefined;

  return (
    roundMetric(pickPath(summary, ["sleep", "total_in_bed_min"])) < 60 ||
    roundMetric(pickPath(summary, ["activity_24h", "steps"])) < 100 ||
    noHeartSignal
  );
}

function isStrongPositiveDay(summary?: JsonRecord): boolean {
  if (!summary) return false;
  const resting = readFiniteNumber(pickPath(summary, ["heart_rate", "resting_bpm"]));
  const hrv = readFiniteNumber(pickPath(summary, ["heart_rate", "hrv_sdnn_avg_ms"]));
  return (
    roundMetric(pickPath(summary, ["sleep", "total_asleep_min"])) >= 420 &&
    round2Metric(pickPath(summary, ["sleep", "sleep_efficiency"])) >= 0.85 &&
    roundMetric(pickPath(summary, ["activity_24h", "steps"])) >= 10000 &&
    roundMetric(pickPath(summary, ["activity_24h", "exercise_minutes"])) >= 30 &&
    (resting === undefined || resting <= 70) &&
    (hrv === undefined || hrv >= 30)
  );
}

function fallbackDailyReportSummary(summary?: JsonRecord): string {
  if (isSevereDataInsufficient(summary)) {
    return "数据不完整，睡眠、活动或心率数据不足，无法判断整体状态。";
  }
  if (isStrongPositiveDay(summary)) {
    return "睡眠、活动和恢复指标较好，今日整体状态有积极依据。";
  }
  return "今日数据已同步，建议结合睡眠、活动和心率保守判断。";
}

function normalizeDailyReportSummary(value: unknown, summary?: JsonRecord): string {
  let text = normalizeReportText(value, 80, fallbackDailyReportSummary(summary));
  if (isSevereDataInsufficient(summary) && !text.startsWith("数据不完整")) {
    text = fallbackDailyReportSummary(summary);
  }
  if (isStrongPositiveDay(summary) && text.startsWith("数据不完整")) {
    text = fallbackDailyReportSummary(summary);
  }
  return clipText(text, 80);
}

function fallbackHighlights(metrics: JsonRecord): string[] {
  const sleepMin = roundMetric(metrics.sleep_total_min);
  const sleepEfficiency = Math.round(round2Metric(metrics.sleep_efficiency) * 100);
  const steps = roundMetric(metrics.steps);
  const exerciseMin = roundMetric(metrics.exercise_min);
  return [
    `睡眠${sleepMin}分钟，效率${sleepEfficiency}%。`,
    `步数${steps}步，运动${exerciseMin}分钟。`,
  ];
}

function fallbackSuggestions(): string[] {
  return ["今天保持保守活动强度。", "今晚优先保证睡眠。"];
}

function normalizeStringList(
  value: unknown,
  minItems: number,
  maxItems: number,
  maxChars: number,
  fallbacks: string[],
): string[] {
  const source = Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const item of source) {
    const text = readString(item);
    if (!text || containsUnsupportedReportText(text)) continue;
    out.push(clipText(text, maxChars));
    if (out.length >= maxItems) break;
  }

  for (const fallback of fallbacks) {
    if (out.length >= minItems) break;
    const text = clipText(fallback, maxChars);
    if (!containsUnsupportedReportText(text)) out.push(text);
  }

  while (out.length < minItems) {
    out.push(clipText(fallbacks[0] ?? "数据不足，保守判断。", maxChars));
  }

  return out.slice(0, maxItems);
}

// suggestions 保真（ADR 0015 / 契约 §10.4）：array 有 1-3 条非空字符串就逐条原样保留，
// 每条仅 500 字异常上限；不过滤禁词、不 clip 30、不替换正文。只有缺失/非数组/空/全空才 fallback。
// 医疗硬护栏交给 cloud validator 单点（命中则 report status=failed，便于改 prompt），plugin 保真。
function normalizeSuggestions(value: unknown, fallbacks: string[]): string[] {
  const source = Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const item of source) {
    const text = readString(item);
    if (!text) continue;
    out.push(clipText(text, 500));
    if (out.length >= 3) break;
  }

  if (out.length > 0) return out;

  const fallbackOut = fallbacks
    .map((fallback) => clipText(fallback, 500))
    .filter((text) => text.length > 0)
    .slice(0, 3);
  return fallbackOut.length > 0 ? fallbackOut : ["今天保持保守活动强度。"];
}

function normalizeDailyReportQuestion(question: JsonRecord): JsonRecord {
  const context = asRecord(question.context);
  const rawKind = readString(context.kind);
  const kind = rawKind && QUESTION_CONTEXT_KINDS.has(rawKind) ? rawKind : "injury_check";
  const normalizedContext: JsonRecord = {
    kind,
  };
  if (kind === "injury_check") {
    normalizedContext.injury_idx = roundMetric(context.injury_idx);
  }

  const quickAnswers = normalizeStringList(
    question.quick_answers,
    2,
    4,
    6,
    ["好了", "还没好"],
  );

  return {
    question_id: readString(question.question_id) ?? `q-${Date.now()}`,
    text: normalizeReportText(question.text, 60, "你现在感觉怎么样？"),
    quick_answers: quickAnswers,
    free_text_allowed: typeof question.free_text_allowed === "boolean" ? question.free_text_allowed : true,
    context: normalizedContext,
  };
}

function normalizeDailyReportForSubmit(report: JsonRecord, summary?: JsonRecord): JsonRecord {
  const schemaVersion = readString(report.schema_version) === "report-0.3" ? "report-0.3" : "report-0.2";
  const metrics = normalizeDailyReportKeyMetrics(report, summary);
  const normalized: JsonRecord = {
    schema_version: schemaVersion,
    generated_at: isIso8601WithOffset(report.generated_at) ? report.generated_at : currentIso8601WithOffset(),
    summary: normalizeDailyReportSummary(report.summary, summary),
    key_metrics: metrics,
    highlights: normalizeStringList(report.highlights, 2, 4, 30, fallbackHighlights(metrics)),
    suggestions: normalizeSuggestions(report.suggestions, fallbackSuggestions()),
  };

  if (schemaVersion === "report-0.3" && isRecord(report.question)) {
    normalized.question = normalizeDailyReportQuestion(report.question);
  }

  return normalized;
}

function resolveThinSliceFallbackReply(body: string): string | undefined {
  const isSchejoPrefixed =
    body.startsWith(SCHEJO_SKILL_PREFIX) ||
    body.startsWith(SCHEJO_SKILL_PREFIX_WITH_SPACE) ||
    body.startsWith(LEGACY_THIN_SLICE_SKILL_PREFIX);
  if (!isSchejoPrefixed) return undefined;
  // Ping smoke test 仍要字面回显（SKILL.md ping route 契约）。
  if (body.toLowerCase().includes("ping")) return `spike-ack: ${body}`;
  // 真实用户内容 / app intent（如 intent=workout.start_session）超时兜底：绝不把原始 prompt
  // 原样回显给用户（前缀 + JSON 很丑）；给一句中性提示即可。MVP-5 G4 真机暴露。
  return "schejo 这次没及时返回结果，请稍后在 app 里重试。";
}

// plan.request 现场编排整课 plan（综合 profile+readiness+state+伤病推理）常耗 1-2 分钟，超过 60s 抢跑兜底窗口。
// 这类 intent 不武装抢跑定时器——让 dispatch await 到 agent 算完正常 deliver，不在 60s 处先发兜底把真 plan 锁死。
function isWorkoutPlanRequestBody(body: string): boolean {
  return body.includes("intent=workout.plan.request");
}

function cleanupPendingDailyReports(): void {
  const now = Date.now();
  for (const [requestId, entry] of pendingDailyReports.entries()) {
    if (now - entry.createdAt > DAILY_REPORT_PENDING_TTL_MS) {
      pendingDailyReports.delete(requestId);
      log(`[schejo] daily_report_pending_cleanup request_id=${requestId}`);
    }
  }
}

const GOAL_DISPLAY: Record<string, string> = {
  lose_fat: "减脂",
  gain_muscle: "增肌",
  endurance: "提升耐力",
  general_health: "健康维持",
};

const LEVEL_DISPLAY: Record<string, string> = {
  sedentary: "久坐少动",
  beginner: "新手（偶尔训练）",
  intermediate: "进阶（规律训练）",
  advanced: "高阶（系统训练）",
};

const EQUIPMENT_DISPLAY: Record<string, string> = {
  gym: "健身房",
  home_with_equipment: "家中有器械",
  home_no_equipment: "家中无器械",
  outdoor: "户外",
};

const TRAINING_TIME_DISPLAY: Record<string, string> = {
  dawn: "清晨",
  morning: "上午",
  midday: "午间",
  evening: "傍晚",
  night: "夜间",
};

const SEX_DISPLAY: Record<string, string> = {
  male: "男",
  female: "女",
  other: "其他",
};

function hasUserProfile(
  userProfile: JsonRecord | null | undefined,
): userProfile is JsonRecord {
  return Boolean(userProfile) && Object.keys(userProfile as object).length > 0;
}

function formatUserProfileSection(profile: JsonRecord): string {
  const goalArr = Array.isArray(profile.goal) ? (profile.goal as unknown[]) : [];
  const goal = goalArr.map((g) => GOAL_DISPLAY[String(g)] ?? String(g)).join("、") || "未填";

  const levelStr = typeof profile.level === "string" ? profile.level : "";
  const level = LEVEL_DISPLAY[levelStr] ?? "未填";

  const eqArr = Array.isArray(profile.equipment) ? (profile.equipment as unknown[]) : [];
  const equipment = eqArr.map((e) => EQUIPMENT_DISPLAY[String(e)] ?? String(e)).join("、") || "未填";

  const ttArr = Array.isArray(profile.training_time)
    ? (profile.training_time as unknown[])
    : [];
  const trainingTime =
    ttArr.map((t) => TRAINING_TIME_DISPLAY[String(t)] ?? String(t)).join("、") || "未填";

  const injuriesRaw = typeof profile.injuries === "string" ? profile.injuries.trim() : "";
  const injuries = injuriesRaw ? injuriesRaw : "无";

  const basicsRec = isRecord(profile.basics) ? profile.basics : {};
  const birthYear =
    typeof basicsRec.birth_year === "number" ? `${basicsRec.birth_year} 年生` : "出生年未填";
  const sex =
    typeof basicsRec.sex === "string" && SEX_DISPLAY[basicsRec.sex]
      ? SEX_DISPLAY[basicsRec.sex]
      : "性别未填";
  const heightCm =
    typeof basicsRec.height_cm === "number" ? `${basicsRec.height_cm}cm` : "身高未填";
  const weightKg =
    typeof basicsRec.weight_kg === "number" ? `${basicsRec.weight_kg}kg` : "体重未填";

  return [
    "## 用户画像（profile-0.1）",
    `- 目标：${goal}`,
    `- 训练水平：${level}`,
    `- 可用器材：${equipment}`,
    `- 训练时段偏好：${trainingTime}`,
    `- 伤病 / 注意事项：${injuries}`,
    `- 基本：${birthYear} / ${sex} / ${heightCm} / ${weightKg}`,
    "",
    "profile 注入规则（仅当存在 profile 时生效）：",
    "- suggestions 必须显式参考“目标”与“训练水平”，并用人话说出“为什么这条建议适合这位用户”。",
    "- 若“伤病 / 注意事项”非空（不是“无”），suggestions 中至少有 1 条直接回应该伤病（避开禁忌动作 / 用人话提示）。",
    "- 仅允许引用 profile 已知字段；不要为用户编造未提供的目标、动作、组数、强度。",
    "- 训练计划（具体动作 / 强度 / 组数 / 周期）仍属本期范围外，不要给出。",
  ].join("\n");
}

function formatReminderSection(prompt: ReminderForPrompt): string {
  const { reminder, questionId } = prompt;
  if (reminder.kind !== "injury_check") {
    return [
      "## 待复查 reminder",
      `- 类型：${reminder.kind}`,
      `- question_id：${questionId}`,
      "",
      "（仅当存在 reminder 时生效）在 report 顶层 JSON 中额外输出 question 字段，详见下方规则。",
    ].join("\n");
  }
  const description = reminder.description ?? "";
  const nextCheck = reminder.next_check_at ?? "";
  const injuryIdx = reminder.injury_idx ?? 0;
  return [
    "## 待复查 reminder（仅当存在 reminder 时生效）",
    "- 类型：injury_check",
    `- 用户上次报告："${description}"`,
    `- 该复查日期：${nextCheck}`,
    "",
    "注入规则（必须严格遵守）：",
    "- 在 report 顶层 JSON 中额外输出 `question` 字段，结构如下：",
    "  {",
    `    "question_id": "${questionId}",`,
    `    "text": "<不超过 60 字的中文询问，自然口语，应直接引用用户描述，例如\\"你之前提到的${description}怎么样了？\\">",`,
    `    "quick_answers": ["好了", "快好了", "还没好", "老毛病"],`,
    `    "free_text_allowed": true,`,
    `    "context": { "kind": "injury_check", "injury_idx": ${injuryIdx} }`,
    "  }",
    "- question_id / context.kind / context.injury_idx 必须原样输出，不要改值。",
    "- quick_answers 4 选 1 必须原样，不要换字、不要增减项。",
    "- 不要追问细节、不要写多句、不要医学诊断。",
    "- 若本次 reminder 不存在（本段不出现）则 report 不要含 question 字段。",
  ].join("\n");
}

function buildDailyReportPrompt(
  requestId: string,
  summary: JsonRecord,
  userProfile?: JsonRecord | null,
  reminder?: ReminderForPrompt | null,
): string {
  const hasProfile = hasUserProfile(userProfile);
  const forbidLine = hasProfile
    ? "- 禁止建议佩戴设备、检查设备、保持监测连续性；禁止推测设备、压力、疲劳、疼痛、饮食、训练计划。"
    : "- 禁止建议佩戴设备、检查设备、保持监测连续性；禁止推测设备、压力、疲劳、疼痛、饮食、训练目标、训练计划。";

  const schemaLine = reminder
    ? "- report 输出 report-0.3 JSON；只输出 schema_version、generated_at、summary、key_metrics、highlights、suggestions、question；其中 schema_version 写成 \"report-0.3\"。"
    : "- report 输出 report-0.2 JSON；只输出 schema_version、generated_at、summary、key_metrics、highlights、suggestions；schema_version 写成 \"report-0.2\"。";

  const lines: string[] = [
    DAILY_REPORT_PROMPT_PREFIX,
    "",
    `request_id: ${requestId}`,
    "",
    "可信度硬规则：",
    "- 只根据下面 HealthSummary 输出 JSON；禁止编造任何未出现事实。",
    schemaLine,
    "- 缺失/null/样本不足时说数据不完整或无法判断，不能把缺失数据当作好坏。",
    "- key_metrics 只能且必须包含这 7 个 key：resting_hr_bpm, hrv_sdnn_ms, sleep_total_min, sleep_efficiency, steps, exercise_min, active_kcal；禁止任何其它 key。",
    "- key_metrics 的 7 个值必须都是有限数字；缺失/无法判断时填 0，禁止 null、字符串或省略字段。",
    "- 严重缺数据时 summary 必须以“数据不完整”开头，不得判断整体身体状态。",
    "- hr_sample_count < 100 时只能说心率样本较少、心率区间判断有限，不能据此推断佩戴或整体状态。",
    "- steps 只能写“步”；distance_walk_run_m 才能写“米/公里”。",
    forbidLine,
    "- highlights 必须引用真实数字或明确阈值；suggestions 必须对应已有证据，写完整具体、可显式点名 profile（如增肌目标 / 进阶训练者 / 旧伤名），不要压成泛化短句。",
    "- 只能输出 ```json 代码块，不要输出 JSON 外文字。",
  ];

  if (hasProfile) {
    lines.push("", formatUserProfileSection(userProfile));
  }

  if (reminder) {
    lines.push("", formatReminderSection(reminder));
  }

  lines.push("", "[HEALTH_SUMMARY_JSON]", JSON.stringify(summary), "[/HEALTH_SUMMARY_JSON]");

  return lines.join("\n");
}

// 在 daily report turn 入口被调用：load state -> 清过期 signals -> save state (若有清理)
// -> 检查 reminders -> 取第一条 -> 生成 question_id。MVP-4 单 turn 最多 1 个 question。
function prepareReminderForDailyReport(): ReminderForPrompt | null {
  let state = loadState();
  const cleaned = cleanExpiredSignals(state);
  if (cleaned !== state) {
    state = cleaned;
    try {
      saveState(state);
    } catch (error) {
      log(`[schejo] state_save_failed (clean signals): ${formatError(error)}`);
    }
  }
  const reminders = checkReminders(state);
  if (reminders.length === 0) return null;
  return {
    reminder: reminders[0],
    questionId: randomUUID(),
  };
}

async function postJson(url: string, body: JsonRecord): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const responseText = await response.text();
  if (!response.ok) {
    const detail = responseText ? ` ${responseText.slice(0, 300)}` : "";
    throw new Error(`HTTP ${response.status}${detail}`);
  }
}

async function postJsonForBody(url: string, body: JsonRecord): Promise<JsonRecord> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const responseText = await response.text();
  if (!response.ok) {
    const detail = responseText ? ` ${responseText.slice(0, 300)}` : "";
    throw new Error(`HTTP ${response.status}${detail}`);
  }

  if (!responseText.trim()) return {};

  try {
    const parsed = JSON.parse(responseText) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("response JSON must be an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`invalid JSON response: ${formatError(error)}`);
  }
}

async function postReplyToCloud(text: string): Promise<void> {
  if (!runtimeState) {
    throw new Error("runtime is not paired");
  }

  await postJson(endpoint(runtimeState.cloudUrl, "/v1/openclaw-reply"), {
    openclaw_user_id: runtimeState.openclawUserId,
    reply_text: text,
  });
}

function assertHealthReportCloudResult(result: JsonRecord, expectedStatus: "ready" | "failed"): void {
  if (result.ok !== true) {
    throw new Error(`cloud returned ok=${String(result.ok)}`);
  }

  const status = readString(result.status);
  if (status && status !== expectedStatus) {
    const message = readString(result.error_message) ?? readString(result.error) ?? "unknown error";
    throw new Error(`cloud returned status=${status}: ${message}`);
  }
}

async function postHealthReportToCloud(body: JsonRecord): Promise<JsonRecord> {
  if (!runtimeState) {
    throw new Error("runtime is not paired");
  }

  return postJsonForBody(endpoint(runtimeState.cloudUrl, "/v1/health/report"), body);
}

async function deliverReplyText(ctx: object, text: string): Promise<void> {
  logWithContext(ctx, `[schejo] outbound: ${text}`);

  try {
    await postReplyToCloud(text);
  } catch (error) {
    const message = `POST /v1/openclaw-reply: ${formatError(error)}`;
    logWithContext(ctx, `[schejo] reply_post_failed: ${message}; not retrying`);
    throw new Error(message);
  }
}

async function deliverReplyPayload(
  ctx: SchejoGatewayContext,
  payload: OutboundReplyPayload,
): Promise<void> {
  const text = readString(payload.text);
  if (!text) {
    logWithContext(ctx, "[schejo] outbound_empty: no text payload");
    return;
  }

  await deliverReplyText(ctx, text);
}

async function deliverDailyReportReplyPayload(
  ctx: SchejoGatewayContext,
  requestId: string,
  payload: OutboundReplyPayload,
): Promise<DailyReportDeliveryResult> {
  const text = readString(payload.text);
  if (!text) {
    logWithContext(ctx, `[schejo] outbound_empty request_id=${requestId}: no text payload`);
    return {
      status: "failed",
      requestId,
      error: "no text payload",
    };
  }

  const pending = pendingDailyReports.get(requestId);
  if (pending) {
    pending.rawOutput = text;
  }

  logWithContext(
    ctx,
    `[schejo] outbound raw request_id=${requestId} len=${Buffer.byteLength(text)}`,
  );

  const parsed = parseDailyReport(text);
  if (!parsed.ok && pending?.submittedReport) {
    pendingDailyReports.delete(requestId);
    logWithContext(
      ctx,
      `[schejo] report_reply_ignored_after_tool_submit request_id=${requestId}: ${parsed.error}`,
    );
    return {
      status: "ready",
      requestId,
      rawOutput: text,
      report: pending.submittedReport,
    };
  }

  const normalizedReport = parsed.ok
    ? normalizeDailyReportForSubmit(parsed.report, pending?.summary)
    : undefined;
  const statusBody: JsonRecord = parsed.ok
    ? {
        request_id: requestId,
        status: "ready",
        report_json: normalizedReport,
      }
    : {
        request_id: requestId,
        status: "failed",
        error_message: parsed.error,
      };

  if (!parsed.ok) {
    logWithContext(ctx, `[schejo] report_parse_failed request_id=${requestId}: ${parsed.error}`);
  }

  try {
    const cloudResult = await postHealthReportToCloud(statusBody);
    assertHealthReportCloudResult(cloudResult, parsed.ok ? "ready" : "failed");
    pendingDailyReports.delete(requestId);
    logWithContext(
      ctx,
      `[schejo] report_posted request_id=${requestId} status=${statusBody.status}`,
    );
  } catch (error) {
    const message = formatError(error);
    logWithContext(ctx, `[schejo] report_post_failed request_id=${requestId} status=${statusBody.status}: ${message}`);
    return {
      status: "failed",
      requestId,
      rawOutput: text,
      error: `POST /v1/health/report: ${message}`,
    };
  }

  if (!parsed.ok) {
    return {
      status: "failed",
      requestId,
      rawOutput: text,
      error: parsed.error,
    };
  }

  return {
    status: "ready",
    requestId,
    rawOutput: text,
    report: normalizedReport ?? parsed.report,
  };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function parseSseData(frame: string): string | undefined {
  const lines = frame.replace(/\r/g, "").split("\n");
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) return undefined;
  return dataLines.join("\n");
}

async function readSseStream(params: {
  response: Response;
  signal: AbortSignal;
  onEvent: (event: SchejoSseEvent) => Promise<void> | void;
}): Promise<void> {
  if (!params.response.body) {
    throw new Error("SSE response body is empty");
  }

  const reader = params.response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!params.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const frameEnd = buffer.indexOf("\n\n");
        if (frameEnd === -1) break;

        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);

        const data = parseSseData(frame);
        if (!data) continue;

        try {
          await params.onEvent(JSON.parse(data) as SchejoSseEvent);
        } catch (error) {
          log(`[schejo] inbound_error: ${formatError(error)}`);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function resolveDirectDmRuntime(ctx: SchejoGatewayContext): SchejoDirectDmRuntime | undefined {
  if (!ctx.channelRuntime) return undefined;
  return {
    channel: ctx.channelRuntime as unknown as SchejoDirectDmRuntime["channel"],
  };
}

async function dispatchDailyReportRequest(
  ctx: SchejoGatewayContext,
  requestId: string,
  summary: JsonRecord,
  userProfile?: JsonRecord,
): Promise<DailyReportDeliveryResult> {
  const runtime = resolveDirectDmRuntime(ctx);
  if (!runtime) {
    logWithContext(
      ctx,
      `[schejo] inbound_error: channelRuntime not available request_id=${requestId}`,
    );
    return {
      status: "failed",
      requestId,
      error: "channelRuntime not available",
    };
  }

  cleanupPendingDailyReports();
  pendingDailyReports.set(requestId, {
    requestId,
    summary,
    createdAt: Date.now(),
  });

  let delivered = false;
  let deliveryResult: DailyReportDeliveryResult | undefined;
  const reminder = prepareReminderForDailyReport();
  if (reminder) {
    logWithContext(
      ctx,
      `[schejo] daily_report_reminder request_id=${requestId} kind=${reminder.reminder.kind} question_id=${reminder.questionId} injury_idx=${reminder.reminder.injury_idx ?? "n/a"}`,
    );
  }
  const rawBody = buildDailyReportPrompt(requestId, summary, userProfile, reminder);

  await dispatchInboundDirectDmWithRuntime({
    cfg: ctx.cfg,
    runtime,
    channel: CHANNEL_ID,
    channelLabel: "Schejo",
    accountId: ctx.accountId,
    peer: {
      kind: "direct",
      id: DEFAULT_ACCOUNT_ID,
    },
    senderId: DEFAULT_ACCOUNT_ID,
    senderAddress: "schejo-ios",
    recipientAddress: "openclaw",
    conversationLabel: "Schejo iOS Daily Report",
    rawBody,
    messageId: `schejo-report-${requestId}`,
    timestamp: Date.now(),
    commandAuthorized: true,
    provider: CHANNEL_ID,
    surface: CHANNEL_ID,
    extraContext: {
      schejo_request_id: requestId,
      schejo_event_type: "daily_report_request",
    },
    deliver: async (payload) => {
      deliveryResult = await deliverDailyReportReplyPayload(ctx, requestId, payload);
      delivered = true;
    },
    onRecordError: (error) => {
      logWithContext(ctx, `[schejo] daily_report_record_error request_id=${requestId}: ${formatError(error)}`);
    },
    onDispatchError: (error, info) => {
      logWithContext(
        ctx,
        `[schejo] daily_report_dispatch_error request_id=${requestId} ${info.kind}: ${formatError(error)}`,
      );
    },
  });

  if (!delivered) {
    logWithContext(ctx, `[schejo] outbound_missing request_id=${requestId}`);
    return {
      status: "failed",
      requestId,
      error: "no daily report reply delivered",
    };
  }

  return (
    deliveryResult ?? {
      status: "failed",
      requestId,
      error: "daily report delivery result missing",
    }
  );
}

function parseUserAnswerEvent(event: SchejoSseEvent): UserAnswerEvent | null {
  const questionId = readString(event.question_id);
  const answer = readString(event.answer);
  const answeredAt = readString(event.answered_at);
  const contextRaw = event.context;
  if (!questionId || !answer || !answeredAt) return null;
  if (!isRecord(contextRaw)) return null;
  const kind = readString(contextRaw.kind);
  if (kind !== "injury_check" && kind !== "status_change" && kind !== "signal_capture") {
    return null;
  }
  const ctx: UserAnswerEvent["context"] = { kind };
  if (kind === "injury_check") {
    const idx = contextRaw.injury_idx;
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) return null;
    ctx.injury_idx = idx;
  }
  return {
    question_id: questionId,
    answer,
    answered_at: answeredAt,
    context: ctx,
  };
}

function handleUserAnswerEvent(ctx: SchejoGatewayContext, event: SchejoSseEvent): void {
  const parsed = parseUserAnswerEvent(event);
  if (!parsed) {
    logWithContext(ctx, "[schejo] inbound_error: malformed user_answer event");
    return;
  }
  let state: State;
  try {
    state = loadState();
  } catch (error) {
    logWithContext(ctx, `[schejo] state_load_failed: ${formatError(error)}`);
    return;
  }
  const next = processAnswer(state, parsed);
  try {
    saveState(next);
  } catch (error) {
    logWithContext(ctx, `[schejo] state_save_failed: ${formatError(error)}`);
    return;
  }
  logWithContext(
    ctx,
    `[schejo] user_answer_applied question_id=${parsed.question_id} kind=${parsed.context.kind} injury_idx=${parsed.context.injury_idx ?? "n/a"}`,
  );
}

class ActivePullTimeoutError extends Error {
  constructor(pluginRequestId: string) {
    super(`active pull timed out plugin_request_id=${pluginRequestId}`);
    this.name = "ActivePullTimeoutError";
  }
}

function waitForActivePull(pluginRequestId: string): Promise<ActivePullSummary> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingActivePulls.delete(pluginRequestId);
      reject(new ActivePullTimeoutError(pluginRequestId));
    }, ACTIVE_PULL_TIMEOUT_MS);

    pendingActivePulls.set(pluginRequestId, {
      createdAt: Date.now(),
      timeout,
      resolve,
      reject,
    });
  });
}

function cancelPendingActivePull(pluginRequestId: string): void {
  const pending = pendingActivePulls.get(pluginRequestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingActivePulls.delete(pluginRequestId);
}

function resolvePendingActivePull(summary: ActivePullSummary): boolean {
  const pending = pendingActivePulls.get(summary.pluginRequestId);
  if (!pending) return false;

  clearTimeout(pending.timeout);
  pendingActivePulls.delete(summary.pluginRequestId);
  pending.resolve(summary);
  return true;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => readString(item)).filter((item): item is string => Boolean(item));
}

function renderDailyReportForChannel(report: JsonRecord): string {
  const summary = readString(report.summary) ?? "今日健康日报已生成。";
  const highlights = asStringList(report.highlights);
  const suggestions = asStringList(report.suggestions);

  const lines = ["今日健康日报", summary];

  if (highlights.length > 0) {
    lines.push("", "重点");
    lines.push(...highlights.map((item) => `- ${item}`));
  }

  if (suggestions.length > 0) {
    lines.push("", "建议");
    lines.push(...suggestions.map((item) => `- ${item}`));
  }

  return lines.join("\n");
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error(`cannot format date for ${timeZone}`);
  }

  return `${year}-${month}-${day}`;
}

function makeDailyReportPromptId(date = new Date()): string {
  return `daily-${formatDateInTimeZone(date, "Asia/Shanghai")}`;
}

async function requestActiveHealthPull(pluginRequestId: string): Promise<{ requestId: string }> {
  if (!runtimeState) {
    throw new Error("runtime is not paired");
  }

  const response = await postJsonForBody(endpoint(runtimeState.cloudUrl, "/v1/health/request_pull"), {
    openclaw_user_id: runtimeState.openclawUserId,
    plugin_request_id: pluginRequestId,
  });

  const status = readString(response.status);
  const requestId = readString(response.request_id);
  if (status !== "pulling" || !requestId) {
    throw new Error("unexpected /v1/health/request_pull response");
  }

  return { requestId };
}

async function sendDailyReportPrompt(promptId: string): Promise<{ promptId: string }> {
  if (!runtimeState) {
    throw new Error("runtime is not paired");
  }

  const response = await postJsonForBody(endpoint(runtimeState.cloudUrl, "/v1/health/daily_report_prompt"), {
    openclaw_user_id: runtimeState.openclawUserId,
    prompt_id: promptId,
  });

  if (response.ok !== true) {
    throw new Error("unexpected /v1/health/daily_report_prompt response");
  }

  return { promptId: readString(response.prompt_id) ?? promptId };
}

function createSchejoRequestPullTool() {
  return {
    name: "schejo_request_pull",
    label: "Schejo Request Pull",
    description:
      "Request a fresh Schejo health pull from the paired iPhone and wait for the matching HealthSummary payload.",
    parameters: Type.Object({}),
    async execute() {
      if (!runtimeState) {
        return jsonResult({
          status: "failed",
          message: "schejo runtime is not paired",
        });
      }

      const ctx = activeGatewayContext;
      if (!ctx) {
        return jsonResult({
          status: "failed",
          message: "schejo gateway account is not active",
        });
      }

      const pluginRequestId = randomUUID();
      const summaryPromise = waitForActivePull(pluginRequestId);

      try {
        const pull = await requestActiveHealthPull(pluginRequestId);
        log(
          `[schejo] active_pull_requested plugin_request_id=${pluginRequestId} request_id=${pull.requestId}`,
        );

        const inbound = await summaryPromise;
        log(
          `[schejo] active_pull_matched plugin_request_id=${pluginRequestId} request_id=${inbound.requestId} with_profile=${inbound.userProfile ? "true" : "false"}`,
        );

        const toolResult: JsonRecord = {
          status: "ready",
          request_id: inbound.requestId,
          plugin_request_id: pluginRequestId,
          summary: inbound.summary,
        };
        if (inbound.userProfile) {
          toolResult.user_profile = inbound.userProfile;
        }
        return jsonResult(toolResult);
      } catch (error) {
        cancelPendingActivePull(pluginRequestId);

        if (error instanceof ActivePullTimeoutError) {
          return jsonResult({
            status: "timeout",
            plugin_request_id: pluginRequestId,
            message: "90 秒内没有收到 iPhone 回传的健康数据，请稍后再试。",
          });
        }

        return jsonResult({
          status: "failed",
          plugin_request_id: pluginRequestId,
          message: formatError(error),
        });
      }
    },
  };
}

function createSchejoSendDailyReportPromptTool() {
  return {
    name: "schejo_send_daily_report_prompt",
    label: "Schejo Send Daily Report Prompt",
    description:
      "Send a visible APNs alert to the paired iPhone reminding the user to open Schejo and generate today's health report in the foreground. Use for scheduled daily reminders; do not use schejo_request_pull for that path.",
    parameters: Type.Object({
      prompt_id: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, params: unknown) {
      if (!runtimeState) {
        return jsonResult({
          status: "failed",
          message: "schejo runtime is not paired",
        });
      }

      const body = asRecord(params);
      const promptId = readString(body.prompt_id) ?? makeDailyReportPromptId();

      try {
        const result = await sendDailyReportPrompt(promptId);
        log(`[schejo] daily_report_prompt_sent prompt_id=${result.promptId}`);
        return jsonResult({
          status: "ready",
          prompt_id: result.promptId,
          message: "已提醒你打开 Schejo 生成今日健康日报。",
        });
      } catch (error) {
        return jsonResult({
          status: "failed",
          prompt_id: promptId,
          message: formatError(error),
        });
      }
    },
  };
}

const USER_STATE_STATUS_VALUES = [
  "available",
  "sick",
  "injured",
  "busy",
  "traveling",
  "low_motivation",
] as const;

function createSchejoAddInjuryTool() {
  return {
    name: "schejo_add_injury",
    label: "Schejo Add Injury",
    description:
      "Append a new injury entry to plugin-local state-0.1 (ADR 0008). Use when the user reports a fresh body issue. Sets reported_at to today and next_check_at to today+N days (default 14) when status is active.",
    parameters: Type.Object({
      description: Type.String(),
      status: Type.Optional(
        Type.Union([
          Type.Literal("active"),
          Type.Literal("chronic"),
        ]),
      ),
      next_check_at_days: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const body = asRecord(params);
      const description = readString(body.description);
      if (!description) {
        return jsonResult({ status: "failed", message: "description is required" });
      }
      const statusRaw = readString(body.status);
      const status: "active" | "chronic" = statusRaw === "chronic" ? "chronic" : "active";
      const daysRaw = body.next_check_at_days;
      const nextCheckAtDays =
        typeof daysRaw === "number" && Number.isFinite(daysRaw) && daysRaw > 0
          ? Math.round(daysRaw)
          : undefined;
      try {
        const state = loadState();
        const next = addInjury(state, { description, status, nextCheckAtDays });
        saveState(next);
        log(`[schejo] state_add_injury status=${status} next_check_days=${nextCheckAtDays ?? "default"}`);
        return jsonResult({
          status: "ok",
          injuries_count: next.injuries.length,
        });
      } catch (error) {
        return jsonResult({ status: "failed", message: formatError(error) });
      }
    },
  };
}

function createSchejoChangeStatusTool() {
  return {
    name: "schejo_change_status",
    label: "Schejo Change Status",
    description:
      "Change plugin-local user_state.status to one of available / sick / injured / busy / traveling / low_motivation (state-0.1, ADR 0008). Sets since to today. Optional next_check_at_days schedules a follow-up; pass null/omit to skip the follow-up.",
    parameters: Type.Object({
      to: Type.Union(USER_STATE_STATUS_VALUES.map((v) => Type.Literal(v))),
      next_check_at_days: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const body = asRecord(params);
      const toRaw = readString(body.to);
      if (!toRaw || !USER_STATE_STATUS_VALUES.includes(toRaw as UserStateStatus)) {
        return jsonResult({
          status: "failed",
          message: `to must be one of ${USER_STATE_STATUS_VALUES.join(" / ")}`,
        });
      }
      const to = toRaw as UserStateStatus;
      const daysRaw = body.next_check_at_days;
      const nextCheckAtDays: number | null | undefined =
        daysRaw === null
          ? null
          : typeof daysRaw === "number" && Number.isFinite(daysRaw)
            ? Math.round(daysRaw)
            : undefined;
      try {
        const state = loadState();
        const next = changeStatus(state, { to, nextCheckAtDays });
        saveState(next);
        log(`[schejo] state_change_status to=${to} next_check_days=${nextCheckAtDays ?? "null"}`);
        return jsonResult({ status: "ok", user_state: next.user_state });
      } catch (error) {
        return jsonResult({ status: "failed", message: formatError(error) });
      }
    },
  };
}

function createSchejoUpdateStateTool() {
  return {
    name: "schejo_update_state",
    label: "Schejo Update State",
    description:
      "Push a short-lived body signal (state-0.1 signals.body, 72h TTL, ADR 0008). Use when the user mentions a transient signal (pain / fatigue / dizziness / sickness) that doesn't yet warrant a new injury entry.",
    parameters: Type.Object({
      signal_type: Type.String(),
      detail: Type.String(),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const body = asRecord(params);
      const signalType = readString(body.signal_type);
      const detail = readString(body.detail);
      if (!signalType || !detail) {
        return jsonResult({ status: "failed", message: "signal_type and detail are required" });
      }
      try {
        const state = loadState();
        const next = pushBodySignal(state, { type: signalType, detail });
        saveState(next);
        log(`[schejo] state_push_signal type=${signalType}`);
        return jsonResult({ status: "ok", signals_count: next.signals.body.length });
      } catch (error) {
        return jsonResult({ status: "failed", message: formatError(error) });
      }
    },
  };
}

function createSchejoReadStateTool() {
  return {
    name: "schejo_read_state",
    label: "Schejo Read State",
    description:
      "Read-only snapshot of plugin-local state-0.1 (ADR 0008): effective user_state.status, active/chronic injuries, and recent body signals (expired ones dropped). If status=injured has no active/chronic injury and no recent body signal, it is reported as available. Use it to make pre-workout readiness advice injury- and status-aware. Never invent state beyond what this returns.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: unknown) {
      try {
        const state = loadState();
        const snapshot = buildReadStateSnapshot(state);
        log(
          `[schejo] state_read status=${snapshot.user_state.status} raw_status=${state.user_state.status} injuries=${snapshot.injuries.length} signals=${snapshot.signals.length}`,
        );
        return jsonResult({
          status: "ok",
          user_state: snapshot.user_state,
          injuries: snapshot.injuries,
          signals: snapshot.signals,
        });
      } catch (error) {
        return jsonResult({ status: "failed", message: formatError(error) });
      }
    },
  };
}

function createSchejoSubmitReportTool() {
  return {
    name: "schejo_submit_report",
    label: "Schejo Submit Report",
    description:
      "Submit one generated Schejo DailyReport to cloud so the paired iPhone receives it, then return channel-ready text.",
    parameters: Type.Object({
      request_id: Type.String(),
      report_json: Type.Unknown(),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const body = asRecord(params);
      const requestId = readString(body.request_id);
      const report = body.report_json;

      if (!requestId) {
        return jsonResult({
          status: "failed",
          message: "request_id is required",
        });
      }

      if (!isRecord(report)) {
        return jsonResult({
          status: "failed",
          request_id: requestId,
          message: "report_json must be an object",
        });
      }

      try {
        const pending = pendingDailyReports.get(requestId);
        const normalizedReport = normalizeDailyReportForSubmit(report, pending?.summary);
        const cloudResult = await postHealthReportToCloud({
          request_id: requestId,
          status: "ready",
          report_json: normalizedReport,
        });
        assertHealthReportCloudResult(cloudResult, "ready");

        if (pending) {
          pending.submittedReport = normalizedReport;
        }
        log(`[schejo] active_report_posted request_id=${requestId}`);
        return jsonResult({
          status: "ready",
          request_id: requestId,
          channel_text: renderDailyReportForChannel(normalizedReport),
        });
      } catch (error) {
        return jsonResult({
          status: "failed",
          request_id: requestId,
          message: `POST /v1/health/report: ${formatError(error)}`,
        });
      }
    },
  };
}

async function handleInboundEvent(ctx: SchejoGatewayContext, event: SchejoSseEvent): Promise<void> {
  const type = readString(event.type) ?? "ping";

  if (type === "daily_report_request") {
    const requestId = readString(event.request_id);
    const pluginRequestId = readString(event.plugin_request_id);
    const summary = asRecord(event.summary);
    const userProfileRaw = event.user_profile;
    const userProfile = isRecord(userProfileRaw) ? userProfileRaw : undefined;

    if (!requestId) {
      logWithContext(ctx, "[schejo] inbound_error: daily_report_request missing request_id");
      return;
    }

    if (Object.keys(summary).length === 0) {
      logWithContext(
        ctx,
        `[schejo] inbound_error: daily_report_request missing summary request_id=${requestId}`,
      );
      return;
    }

    logWithContext(
      ctx,
      `[schejo] inbound type=daily_report_request request_id=${requestId} summary_bytes=${Buffer.byteLength(
        JSON.stringify(summary),
      )} with_profile=${userProfile ? "true" : "false"}`,
    );

    if (
      pluginRequestId &&
      resolvePendingActivePull({
        pluginRequestId,
        requestId,
        summary,
        userProfile,
      })
    ) {
      logWithContext(
        ctx,
        `[schejo] inbound_matched_active_pull plugin_request_id=${pluginRequestId} request_id=${requestId}`,
      );
      return;
    }

    await dispatchDailyReportRequest(ctx, requestId, summary, userProfile);
    return;
  }

  if (type === "user_answer") {
    handleUserAnswerEvent(ctx, event);
    return;
  }

  if (type !== "ping") {
    logWithContext(ctx, `[schejo] inbound_error: unknown type=${type}`);
    return;
  }

  const body = readString(event.body);
  if (!body) {
    logWithContext(ctx, "[schejo] inbound_error: missing body");
    return;
  }

  logWithContext(ctx, `[schejo] inbound type=ping body=${body}`);

  const fallbackReply = resolveThinSliceFallbackReply(body);
  const runtime = resolveDirectDmRuntime(ctx);
  if (!runtime) {
    if (fallbackReply) {
      logWithContext(ctx, "[schejo] fallback_outbound: channelRuntime not available");
      await deliverReplyText(ctx, fallbackReply);
      return;
    }

    logWithContext(ctx, "[schejo] inbound_error: channelRuntime not available");
    return;
  }

  const messageId = readString(event.id) ?? `schejo-in-${randomUUID()}`;
  const timestamp =
    typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
      ? event.timestamp
      : Date.now();

  let delivered = false;
  let fallbackSent = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

  // plan.request 走「持续生成」：不武装抢跑兜底（见 isWorkoutPlanRequestBody）。dispatch await 到算完正常
  // deliver；真·空产出仍由下方 dispatch 结束后的事后兜底兜住。app 侧持续「生成中」+ 用户重试是安全网。
  // 后台存活 / request_id 关联见 todos/workout-plan-delivery-decouple-followups.md。
  if (fallbackReply && !isWorkoutPlanRequestBody(body)) {
    fallbackTimer = setTimeout(() => {
      if (delivered || fallbackSent) {
        return;
      }

      fallbackSent = true;
      logWithContext(ctx, "[schejo] fallback_outbound: no agent reply delivered");
      void deliverReplyText(ctx, fallbackReply).catch((error) => {
        logWithContext(ctx, `[schejo] fallback_failed: ${formatError(error)}`);
      });
    }, THIN_SLICE_FALLBACK_DELAY_MS);
  }

  try {
    await dispatchInboundDirectDmWithRuntime({
      cfg: ctx.cfg,
      runtime,
      channel: CHANNEL_ID,
      channelLabel: "Schejo",
      accountId: ctx.accountId,
      peer: {
        kind: "direct",
        id: DEFAULT_ACCOUNT_ID,
      },
      senderId: DEFAULT_ACCOUNT_ID,
      senderAddress: "schejo-ios",
      recipientAddress: "openclaw",
      conversationLabel: "Schejo iOS",
      rawBody: body,
      messageId,
      timestamp,
      commandAuthorized: true,
      provider: CHANNEL_ID,
      surface: CHANNEL_ID,
      deliver: async (payload) => {
        if (fallbackSent) {
          logWithContext(ctx, "[schejo] outbound_blocked: fallback already sent");
          return;
        }

        try {
          await deliverReplyPayload(ctx, payload);
          delivered = true;
        } catch (error) {
          if (fallbackReply) {
            logWithContext(ctx, `[schejo] outbound_ignored_for_fallback: ${formatError(error)}`);
            return;
          }
          throw error;
        }
      },
      onRecordError: (error) => {
        logWithContext(ctx, `[schejo] inbound_record_error: ${formatError(error)}`);
      },
      onDispatchError: (error, info) => {
        logWithContext(ctx, `[schejo] inbound_dispatch_error: ${info.kind}: ${formatError(error)}`);
      },
    });
  } finally {
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
    }
  }

  if (!delivered && !fallbackSent && fallbackReply) {
    fallbackSent = true;
    logWithContext(ctx, "[schejo] fallback_outbound: no agent reply delivered");
    await deliverReplyText(ctx, fallbackReply);
  }
}

async function runSseLoop(params: {
  ctx: SchejoGatewayContext;
  code: string;
  cloudUrl: string;
  openclawUserId: string;
  signal: AbortSignal;
}): Promise<void> {
  while (!params.signal.aborted) {
    const streamUrl = endpoint(
      params.cloudUrl,
      `/v1/openclaw-stream?openclaw_user_id=${encodeURIComponent(params.openclawUserId)}`,
    );

    try {
      log(`[schejo] sse_connecting: ${streamUrl}`);
      const response = await fetch(streamUrl, {
        headers: {
          accept: "text/event-stream",
        },
        signal: params.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      log("[schejo] sse_connected");

      // cloud pairings 是 in-memory：cloud restart 之后会清空，但 plugin SSE
      // 会自动重连。借每次 sse_connected 重发 pair_confirm 让 pairing 自愈，
      // 否则 iPhone 端 analyze 会一直撞 not_paired 直到 plugin 重启。
      try {
        await confirmPair({
          code: params.code,
          cloudUrl: params.cloudUrl,
          openclawUserId: params.openclawUserId,
        });
      } catch (error) {
        log(`[schejo] pair_reconfirm_failed: ${formatError(error)}`);
      }

      await readSseStream({
        response,
        signal: params.signal,
        onEvent: (event) => handleInboundEvent(params.ctx, event),
      });

      if (!params.signal.aborted) {
        log("[schejo] sse_disconnected");
      }
    } catch (error) {
      if (!params.signal.aborted) {
        log(`[schejo] sse_error: ${formatError(error)}`);
      }
    }

    if (!params.signal.aborted) {
      await wait(3000, params.signal);
    }
  }
}

async function confirmPair(params: {
  code: string;
  cloudUrl: string;
  openclawUserId: string;
}): Promise<void> {
  runtimeState = {
    cloudUrl: params.cloudUrl,
    openclawUserId: params.openclawUserId,
    pairingCode: params.code,
  };

  await postJson(endpoint(params.cloudUrl, "/v1/pair/confirm"), {
    code: params.code,
    openclaw_user_id: params.openclawUserId,
  });
  log(`[schejo] pair_confirmed code=${params.code}`);
}

async function pairWithConfig(cfg: OpenClawConfig): Promise<void> {
  const code = resolvePairingCodeFromConfig(cfg);
  if (!code) {
    log("[schejo] FATAL: cannot read pairing_code");
    return;
  }

  const cloudUrl = resolveCloudUrlFromConfig(cfg);
  if (!cloudUrl) {
    log("[schejo] FATAL: SCHEJO_CLOUD_URL not set");
    return;
  }

  try {
    await confirmPair({
      code,
      cloudUrl,
      openclawUserId: resolveOpenClawUserIdFromConfig(cfg),
    });
  } catch (error) {
    log(`[schejo] pair_confirm failed: ${formatError(error)}`);
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): SchejoAccount {
  return {
    accountId: accountId ?? DEFAULT_ACCOUNT_ID,
    cloudUrl: resolveCloudUrlFromConfig(cfg) ?? "",
    configured: true,
    enabled: true,
  };
}

function getDmPolicy(): string {
  return "pairing";
}

function getAllowFrom(): Array<string | number> {
  return [];
}

const schejoChannelBase = {
  ...createChannelPluginBase({
    id: CHANNEL_ID,
    meta: {
      label: "Schejo",
      selectionLabel: "Schejo iOS",
      detailLabel: "Schejo iOS app channel",
      docsPath: "/channels/schejo",
      docsLabel: "schejo",
      blurb: "Private iOS body-data channel for the Schejo thin slice.",
      aliases: ["schejo-ios"],
      markdownCapable: true,
      exposure: {
        configured: true,
        setup: true,
        docs: false,
      },
    },
    capabilities: {
      chatTypes: ["direct"],
      reactions: false,
      threads: false,
    },
    config: {
      listAccountIds() {
        return [DEFAULT_ACCOUNT_ID];
      },
      defaultAccountId() {
        return DEFAULT_ACCOUNT_ID;
      },
      resolveAccount,
      inspectAccount(cfg: OpenClawConfig, accountId?: string | null) {
        const account = resolveAccount(cfg, accountId);
        return {
          enabled: account.enabled,
          configured: account.configured,
          accountId: account.accountId,
          cloudUrl: account.cloudUrl,
        };
      },
      isEnabled() {
        return true;
      },
      isConfigured() {
        return true;
      },
      describeAccount(account) {
        return {
          accountId: account.accountId,
          name: "Schejo iOS",
          enabled: true,
          configured: true,
          connected: Boolean(runtimeState),
        };
      },
      resolveDefaultTo() {
        return DEFAULT_ACCOUNT_ID;
      },
    },
    setup: {
      resolveAccountId() {
        return DEFAULT_ACCOUNT_ID;
      },
      applyAccountConfig({ cfg, input }) {
        const next = structuredClone(cfg) as OpenClawConfig & {
          channels?: Record<string, JsonRecord>;
        };
        const cloudUrl = readString(input.url);
        next.channels = {
          ...asRecord(next.channels),
          schejo: {
            ...asRecord(next.channels?.schejo),
            enabled: true,
            pairingCode: readString(input.code),
            ...(cloudUrl ? { cloudUrl } : {}),
          },
        };
        return next;
      },
    },
    security: {
      resolveDmPolicy: () => ({
        policy: getDmPolicy(),
        allowFrom: getAllowFrom(),
        allowFromPath: "channels.schejo.allowFrom",
        approveHint: "在 iPhone app 上重新生成配对码并粘贴安装 prompt",
      }),
    },
  }),
  gateway: {
    async startAccount(ctx) {
      logWithContext(ctx, `[schejo] start_account account=${ctx.accountId}`);
      activeGatewayContext = ctx;
      await pairWithConfig(ctx.cfg);
      if (runtimeState) {
        await runSseLoop({
          ctx,
          code: runtimeState.pairingCode,
          cloudUrl: runtimeState.cloudUrl,
          openclawUserId: runtimeState.openclawUserId,
          signal: ctx.abortSignal,
        });
      } else {
        await waitForAbort(ctx.abortSignal);
      }
      if (activeGatewayContext === ctx) {
        activeGatewayContext = null;
      }
      logWithContext(ctx, `[schejo] stop_account account=${ctx.accountId}`);
    },
    async stopAccount(ctx) {
      logWithContext(ctx, `[schejo] stop_account account=${ctx.accountId}`);
    },
  },
} as SchejoChatChannelParams["base"];

export const schejoChannelPlugin = createChatChannelPlugin<SchejoAccount>({
  base: schejoChannelBase,
  threading: {
    topLevelReplyToMode: "direct",
  },
  outbound: {
    deliveryMode: "direct",
    resolveTarget(params) {
      return {
        ok: true,
        to: params.to ?? DEFAULT_ACCOUNT_ID,
      };
    },
    ...createRawChannelSendResultAdapter({
      channel: CHANNEL_ID,
      async sendText(ctx) {
        const text = ctx.text ?? "";

        if (!runtimeState) {
          logWithContext(ctx, "[schejo] reply_post_failed: runtime is not paired; not retrying");
          const result: SchejoSendResult = {
            ok: false,
            error: "runtime is not paired",
          };
          return result;
        }

        try {
          await deliverReplyText(ctx, text);
        } catch (error) {
          const result: SchejoSendResult = {
            ok: false,
            error: formatError(error),
          };
          return result;
        }

        const result: SchejoSendResult = {
          ok: true,
          messageId: `schejo-${randomUUID()}`,
        };
        return result;
      },
    }),
  },
});

async function pairWithCloud(api: OpenClawPluginApi): Promise<void> {
  const code = resolvePairingCode(api);
  if (!code) {
    log("[schejo] FATAL: cannot read pairing_code");
    return;
  }

  const cloudUrl = resolveCloudUrl(api);
  if (!cloudUrl) {
    log("[schejo] FATAL: SCHEJO_CLOUD_URL not set");
    return;
  }

  const openclawUserId = resolveOpenClawUserId(api);

  try {
    await confirmPair({
      code,
      cloudUrl,
      openclawUserId,
    });
  } catch (error) {
    log(`[schejo] pair_confirm failed: ${formatError(error)}`);
  }
}

export default defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: "Schejo",
  description: "schejo iOS app channel",
  plugin: schejoChannelPlugin,
  registerFull(api) {
    api.registerTool(createSchejoRequestPullTool(), { name: "schejo_request_pull" });
    api.registerTool(createSchejoSendDailyReportPromptTool(), { name: "schejo_send_daily_report_prompt" });
    api.registerTool(createSchejoSubmitReportTool(), { name: "schejo_submit_report" });
    api.registerTool(createSchejoAddInjuryTool(), { name: "schejo_add_injury" });
    api.registerTool(createSchejoChangeStatusTool(), { name: "schejo_change_status" });
    api.registerTool(createSchejoUpdateStateTool(), { name: "schejo_update_state" });
    api.registerTool(createSchejoReadStateTool(), { name: "schejo_read_state" });
    void pairWithCloud(api).catch((error) => {
      log(`[schejo] FATAL: ${formatError(error)}`);
    });
  },
});

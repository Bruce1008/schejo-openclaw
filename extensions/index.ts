import { randomUUID } from "node:crypto";
import {
  createChannelPluginBase,
  createChatChannelPlugin,
  defineChannelPluginEntry,
  type OpenClawConfig,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-core";
import {
  createRawChannelSendResultAdapter,
  type ChannelSendRawResult,
} from "openclaw/plugin-sdk/channel-send-result";

const CHANNEL_ID = "schejo";
const DEFAULT_ACCOUNT_ID = "ios";

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
};

type SchejoSseEvent = {
  body?: unknown;
};

type SchejoChatChannelParams = Parameters<typeof createChatChannelPlugin<SchejoAccount>>[0];

let runtimeState: SchejoRuntimeState | null = null;
let confirmedPairKey: string | null = null;

function log(message: string): void {
  console.error(message);
}

function logWithContext(input: object, message: string): void {
  const ctx = input as SchejoLogContext;
  const emit = ctx.log?.info?.bind(ctx.log) ?? log;
  emit(message);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
  onEvent: (event: SchejoSseEvent) => void;
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
          params.onEvent(JSON.parse(data) as SchejoSseEvent);
        } catch (error) {
          log(`[schejo] inbound_error: invalid SSE data ${formatError(error)}`);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function handleInboundEvent(event: SchejoSseEvent): void {
  const body = readString(event.body);
  if (!body) {
    log("[schejo] inbound_error: missing body");
    return;
  }

  log(`[schejo] inbound: ${body}`);
}

async function runSseLoop(params: {
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
      await readSseStream({
        response,
        signal: params.signal,
        onEvent: handleInboundEvent,
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
  const pairKey = `${params.code}:${params.openclawUserId}:${params.cloudUrl}`;
  runtimeState = {
    cloudUrl: params.cloudUrl,
    openclawUserId: params.openclawUserId,
  };

  log(`[schejo] received_code: ${params.code}`);

  if (confirmedPairKey === pairKey) {
    log("[schejo] pair_confirmed");
    return;
  }

  await postJson(endpoint(params.cloudUrl, "/v1/pair/confirm"), {
    code: params.code,
    openclaw_user_id: params.openclawUserId,
  });
  confirmedPairKey = pairKey;
  log("[schejo] pair_confirmed");
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
      await pairWithConfig(ctx.cfg);
      if (runtimeState) {
        await runSseLoop({
          cloudUrl: runtimeState.cloudUrl,
          openclawUserId: runtimeState.openclawUserId,
          signal: ctx.abortSignal,
        });
      } else {
        await waitForAbort(ctx.abortSignal);
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
        logWithContext(ctx, `[schejo] outbound: ${text}`);

        if (!runtimeState) {
          logWithContext(ctx, "[schejo] reply_post_failed: runtime is not paired; not retrying");
          const result: SchejoSendResult = {
            ok: false,
            error: "runtime is not paired",
          };
          return result;
        }

        try {
          await postJson(endpoint(runtimeState.cloudUrl, "/v1/openclaw-reply"), {
            openclaw_user_id: runtimeState.openclawUserId,
            reply_text: text,
          });
        } catch (error) {
          const message = `POST /v1/openclaw-reply: ${formatError(error)}`;
          logWithContext(ctx, `[schejo] reply_post_failed: ${message}; not retrying`);
          const result: SchejoSendResult = {
            ok: false,
            error: message,
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
    void pairWithCloud(api).catch((error) => {
      log(`[schejo] FATAL: ${formatError(error)}`);
    });
  },
});

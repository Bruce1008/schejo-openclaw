import { randomUUID } from "node:crypto";
import { createChannelPluginBase, createChatChannelPlugin, defineChannelPluginEntry, } from "openclaw/plugin-sdk/channel-core";
const CHANNEL_ID = "schejo";
const DEFAULT_ACCOUNT_ID = "ios";
const DEFAULT_CLOUD_URL = "http://111.230.239.136/schejo";
let runtimeState = null;
function log(message) {
    console.error(message);
}
function asRecord(value) {
    return value && typeof value === "object" ? value : {};
}
function readString(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function pickPath(root, path) {
    let current = root;
    for (const key of path) {
        const record = asRecord(current);
        if (!(key in record))
            return undefined;
        current = record[key];
    }
    return current;
}
function firstString(...values) {
    for (const value of values) {
        const text = readString(value);
        if (text)
            return text;
    }
    return undefined;
}
function resolvePluginConfig(api) {
    const fromApi = asRecord(api.pluginConfig);
    if (Object.keys(fromApi).length > 0)
        return fromApi;
    const cfg = asRecord(api.config);
    return asRecord(pickPath(cfg, ["plugins", "entries", "schejo", "config"]) ??
        pickPath(cfg, ["plugins", "schejo", "config"]));
}
function resolveChannelConfig(cfg) {
    return asRecord(pickPath(cfg, ["channels", "schejo"]));
}
function resolvePairingCode(api) {
    const pluginConfig = resolvePluginConfig(api);
    const channelConfig = resolveChannelConfig(api.config);
    const anyApi = api;
    return firstString(process.env.SCHEJO_PAIRING_CODE, pluginConfig.pairingCode, channelConfig.pairingCode, pickPath(anyApi, ["installContext", "pairingCode"]), pickPath(anyApi, ["installContext", "config", "pairingCode"]), pickPath(anyApi, ["setup", "pairingCode"]));
}
function resolveCloudUrlFromConfig(cfg) {
    const cfgRecord = asRecord(cfg);
    return (firstString(process.env.SCHEJO_CLOUD_URL, pickPath(cfgRecord, ["plugins", "entries", "schejo", "config", "cloudUrl"]), pickPath(cfgRecord, ["plugins", "schejo", "config", "cloudUrl"]), pickPath(cfgRecord, ["channels", "schejo", "cloudUrl"])) ?? DEFAULT_CLOUD_URL);
}
function resolveCloudUrl(api) {
    const pluginConfig = resolvePluginConfig(api);
    const channelConfig = resolveChannelConfig(api.config);
    return (firstString(process.env.SCHEJO_CLOUD_URL, pluginConfig.cloudUrl, channelConfig.cloudUrl) ??
        DEFAULT_CLOUD_URL);
}
function resolveOpenClawUserId(api) {
    const pluginConfig = resolvePluginConfig(api);
    const channelConfig = resolveChannelConfig(api.config);
    const anyApi = api;
    const resolved = firstString(process.env.SCHEJO_OPENCLAW_USER_ID, pluginConfig.openclawUserId, channelConfig.openclawUserId, pickPath(anyApi, ["user", "id"]), pickPath(anyApi, ["runtime", "user", "id"]), pickPath(anyApi, ["runtime", "identity", "userId"]), pickPath(anyApi, ["runtime", "operator", "id"]), pickPath(anyApi, ["installContext", "openclawUserId"]), pickPath(anyApi, ["installContext", "user", "id"]));
    if (resolved)
        return resolved;
    const fallback = firstString(process.env.USER, process.env.LOGNAME) ?? "local";
    const openclawUserId = `openclaw-${fallback}`;
    log(`[schejo] WARN: cannot read openclaw_user_id from runtime; using ${openclawUserId}`);
    return openclawUserId;
}
function endpoint(baseUrl, path) {
    const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    return new URL(path.replace(/^\/+/, ""), normalizedBase).toString();
}
function formatError(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
async function postJson(url, body) {
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
function resolveAccount(cfg, accountId) {
    return {
        accountId: accountId ?? DEFAULT_ACCOUNT_ID,
        cloudUrl: resolveCloudUrlFromConfig(cfg),
        configured: true,
        enabled: true,
    };
}
const schejoChannelBase = createChannelPluginBase({
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
    config: {
        listAccountIds() {
            return [DEFAULT_ACCOUNT_ID];
        },
        defaultAccountId() {
            return DEFAULT_ACCOUNT_ID;
        },
        resolveAccount,
        inspectAccount(cfg, accountId) {
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
            const next = structuredClone(cfg);
            next.channels = {
                ...asRecord(next.channels),
                schejo: {
                    ...asRecord(next.channels?.schejo),
                    enabled: true,
                    pairingCode: readString(input.code),
                    cloudUrl: readString(input.url) ?? DEFAULT_CLOUD_URL,
                },
            };
            return next;
        },
    },
});
export const schejoChannelPlugin = createChatChannelPlugin({
    base: schejoChannelBase,
    threading: {
        topLevelReplyToMode: "direct",
    },
    outbound: {
        base: {
            deliveryMode: "direct",
            resolveTarget(params) {
                return {
                    ok: true,
                    to: params.to ?? DEFAULT_ACCOUNT_ID,
                };
            },
        },
        attachedResults: {
            channel: CHANNEL_ID,
            async sendText(ctx) {
                const text = ctx.text ?? "";
                log(`[schejo] outbound: ${text}`);
                if (!runtimeState) {
                    log("[schejo] reply_post_failed: runtime is not paired");
                    return { messageId: `schejo-${randomUUID()}` };
                }
                try {
                    await postJson(endpoint(runtimeState.cloudUrl, "/v1/openclaw-reply"), {
                        openclaw_user_id: runtimeState.openclawUserId,
                        reply_text: text,
                    });
                }
                catch (error) {
                    log(`[schejo] reply_post_failed: ${formatError(error)}`);
                }
                return { messageId: `schejo-${randomUUID()}` };
            },
        },
    },
});
async function pairWithCloud(api) {
    const code = resolvePairingCode(api);
    if (!code) {
        log("[schejo] FATAL: cannot read pairing_code");
        return;
    }
    const cloudUrl = resolveCloudUrl(api);
    const openclawUserId = resolveOpenClawUserId(api);
    runtimeState = { cloudUrl, openclawUserId };
    log(`[schejo] received_code: ${code}`);
    try {
        await postJson(endpoint(cloudUrl, "/v1/pair/confirm"), {
            code,
            openclaw_user_id: openclawUserId,
        });
        log("[schejo] pair_confirmed");
    }
    catch (error) {
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

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const TEMPLATE_SCHEMA_VERSION = "recording-templates-0.1";
const TEMPLATE_FILE_NAME = "schejo-recording-templates.json";
const TEMPLATE_MAX = 80;
export const HK_WORKOUT_ACTIVITY_TYPES = [
    "other",
    "badminton",
    "basketball",
    "cycling",
    "functional_strength_training",
    "high_intensity_interval_training",
    "hiking",
    "pilates",
    "running",
    "soccer",
    "swimming",
    "table_tennis",
    "tennis",
    "traditional_strength_training",
    "walking",
    "yoga",
];
export const WORKOUT_LOCATION_TYPES = ["unknown", "indoor", "outdoor"];
const BUILTIN_ALIAS_GROUPS = {
    网球: ["网球", "tennis"],
    徒步: ["徒步", "hiking", "hike", "爬山"],
    跑步: ["跑步", "running", "run"],
    步行: ["步行", "快走", "走路", "walking", "walk"],
    骑行: ["骑行", "骑车", "cycling", "bike", "biking"],
    游泳: ["游泳", "swimming", "swim"],
    羽毛球: ["羽毛球", "badminton"],
    篮球: ["篮球", "basketball"],
    足球: ["足球", "soccer", "football"],
    乒乓球: ["乒乓球", "table tennis", "table_tennis", "pingpong", "ping pong"],
    瑜伽: ["瑜伽", "yoga"],
    普拉提: ["普拉提", "pilates"],
    力量训练: ["力量训练", "健身", "traditional strength training", "strength training", "gym"],
    功能训练: ["功能训练", "自重训练", "functional strength training"],
    HIIT: ["hiit", "HIIT", "间歇", "高强度间歇"],
};
function getTemplatePath() {
    return resolve(process.cwd(), TEMPLATE_FILE_NAME);
}
function nowIso() {
    return new Date().toISOString();
}
function emptyStore() {
    return {
        schema_version: TEMPLATE_SCHEMA_VERSION,
        updated_at: nowIso(),
        templates: [],
    };
}
function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isDataRequirements(value) {
    if (!isObject(value))
        return false;
    return (typeof value.duration === "boolean" &&
        typeof value.heart_rate === "boolean" &&
        typeof value.active_energy === "boolean" &&
        typeof value.distance === "boolean" &&
        typeof value.location === "boolean");
}
function isTemplate(value) {
    if (!isObject(value))
        return false;
    return (typeof value.canonical_activity === "string" &&
        Array.isArray(value.aliases) &&
        value.aliases.every((alias) => typeof alias === "string") &&
        typeof value.hk_workout_activity_type === "string" &&
        HK_WORKOUT_ACTIVITY_TYPES.includes(value.hk_workout_activity_type) &&
        typeof value.location_type === "string" &&
        WORKOUT_LOCATION_TYPES.includes(value.location_type) &&
        typeof value.display_title === "string" &&
        isDataRequirements(value.data_requirements) &&
        typeof value.created_at === "string" &&
        typeof value.updated_at === "string");
}
function isStore(value) {
    if (!isObject(value))
        return false;
    return (value.schema_version === TEMPLATE_SCHEMA_VERSION &&
        typeof value.updated_at === "string" &&
        Array.isArray(value.templates) &&
        value.templates.every(isTemplate));
}
function backupCorruptFile(path, reason) {
    try {
        const backup = `${path}.corrupted-${Date.now()}.bak`;
        renameSync(path, backup);
        console.error(`[schejo] recording_templates_corrupted backup=${backup} reason=${reason}`);
    }
    catch (error) {
        console.error(`[schejo] recording_templates_backup_failed reason=${reason} rename_error=${error instanceof Error ? error.message : String(error)}`);
    }
}
function saveStore(store) {
    const path = getTemplatePath();
    const next = { ...store, updated_at: nowIso() };
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
}
export function loadRecordingTemplates() {
    const path = getTemplatePath();
    if (!existsSync(path))
        return emptyStore();
    try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw);
        if (!isStore(parsed)) {
            backupCorruptFile(path, "shape mismatch");
            return emptyStore();
        }
        return parsed;
    }
    catch (error) {
        backupCorruptFile(path, error instanceof Error ? error.message : String(error));
        return emptyStore();
    }
}
export function normalizeAlias(value) {
    return value
        .trim()
        .toLocaleLowerCase()
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ");
}
function builtinCanonical(value) {
    const normalized = normalizeAlias(value);
    for (const [canonical, aliases] of Object.entries(BUILTIN_ALIAS_GROUPS)) {
        if (aliases.some((alias) => normalizeAlias(alias) === normalized))
            return canonical;
    }
    return null;
}
function expandedAliases(canonicalActivity, aliases) {
    const builtin = builtinCanonical(canonicalActivity);
    const all = [
        canonicalActivity,
        builtin ?? "",
        ...(builtin ? BUILTIN_ALIAS_GROUPS[builtin] ?? [] : []),
        ...aliases,
    ].filter((alias) => alias.trim().length > 0);
    const seen = new Set();
    const result = [];
    for (const alias of all) {
        const key = normalizeAlias(alias);
        if (seen.has(key))
            continue;
        seen.add(key);
        result.push(alias.trim());
    }
    return result.slice(0, 20);
}
export function findRecordingTemplate(activityHint) {
    const store = loadRecordingTemplates();
    const builtin = builtinCanonical(activityHint);
    const keys = new Set([normalizeAlias(activityHint)]);
    if (builtin) {
        keys.add(normalizeAlias(builtin));
        for (const alias of BUILTIN_ALIAS_GROUPS[builtin] ?? [])
            keys.add(normalizeAlias(alias));
    }
    return (store.templates.find((template) => {
        const aliases = [template.canonical_activity, ...template.aliases];
        return aliases.some((alias) => keys.has(normalizeAlias(alias)));
    }) ?? null);
}
export function upsertRecordingTemplate(input) {
    const store = loadRecordingTemplates();
    const now = nowIso();
    const canonical = (builtinCanonical(input.canonical_activity) ?? input.canonical_activity).trim();
    const aliases = expandedAliases(canonical, input.aliases ?? []);
    const aliasKeys = new Set([canonical, ...aliases].map(normalizeAlias));
    const idx = store.templates.findIndex((template) => [template.canonical_activity, ...template.aliases].some((alias) => aliasKeys.has(normalizeAlias(alias))));
    const existing = idx >= 0 ? store.templates[idx] : null;
    const template = {
        canonical_activity: canonical,
        aliases: expandedAliases(canonical, [...(existing?.aliases ?? []), ...aliases]),
        hk_workout_activity_type: input.hk_workout_activity_type,
        location_type: input.location_type,
        display_title: input.display_title.trim() || `记录${canonical}`,
        data_requirements: input.data_requirements,
        created_at: existing?.created_at ?? now,
        updated_at: now,
    };
    const templates = idx >= 0
        ? store.templates.map((item, i) => (i === idx ? template : item))
        : [...store.templates, template];
    const trimmed = templates.length > TEMPLATE_MAX ? templates.slice(templates.length - TEMPLATE_MAX) : templates;
    saveStore({ ...store, templates: trimmed });
    return template;
}

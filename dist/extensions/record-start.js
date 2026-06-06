// G8.5 A/B: deterministic reused-template record-start fast path + fallback exemption.
//
// Motivation: routing every `workout.record.start` through the LLM made reused-template starts
// hostage to brain latency (observed ~4 min), and the 60s thin-slice fallback then dropped the
// late command (`outbound_blocked: fallback already sent`) so the Watch never fired. A reused
// template is a deterministic lookup — the plugin answers it directly, no LLM round-trip.
import { findRecordingTemplate, loadRecordingTemplates, normalizeAlias, } from "./recording-templates.js";
const RECORD_START_INTENT = "intent=workout.record.start";
const RECORD_TEMPLATE_CONFIRM_INTENT = "intent=workout.record.template.confirm";
const PLAN_REQUEST_INTENT = "intent=workout.plan.request";
/** Brace-matched first JSON object in a body (intent line + JSON payload). */
function extractFirstJsonObject(text) {
    const start = text.indexOf("{");
    if (start < 0)
        return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (ch === "\\")
                escaped = true;
            else if (ch === '"')
                inString = false;
        }
        else if (ch === '"') {
            inString = true;
        }
        else if (ch === "{") {
            depth += 1;
        }
        else if (ch === "}") {
            depth -= 1;
            if (depth === 0)
                return text.slice(start, i + 1);
        }
    }
    return null;
}
export function parseRecordStartRequest(body) {
    if (!body.includes(RECORD_START_INTENT))
        return null;
    const json = extractFirstJsonObject(body);
    if (!json)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return null;
    const rec = parsed;
    const activityHint = typeof rec.activity_hint === "string" ? rec.activity_hint.trim() : "";
    if (!activityHint)
        return null;
    const trigger = typeof rec.trigger === "string" && rec.trigger.trim() ? rec.trigger.trim() : "adhoc_declare";
    const modificationNote = typeof rec.modification_note === "string" && rec.modification_note.trim()
        ? rec.modification_note.trim()
        : undefined;
    return { activityHint, trigger, modificationNote };
}
function currentIso8601WithOffset() {
    const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
    return shifted.toISOString().replace(/\.\d{3}Z$/, "+08:00");
}
function generateRecordCommandId() {
    const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const date = shifted.toISOString().slice(0, 10);
    const rand = Math.random().toString(16).slice(2, 6).padEnd(4, "0");
    return `wr-${date}-${rand}`;
}
export function buildReusedRecordStartCommand(template, opts) {
    return {
        schema_version: "record-start-0.1",
        command_id: opts?.commandId ?? generateRecordCommandId(),
        generated_at: opts?.now ?? currentIso8601WithOffset(),
        source_intent: opts?.sourceIntent ?? "adhoc_declare",
        template_state: "reused",
        needs_user_confirmation: false,
        canonical_activity: template.canonical_activity,
        aliases: template.aliases,
        activity_label: template.canonical_activity,
        hk_workout_activity_type: template.hk_workout_activity_type,
        location_type: template.location_type,
        display_title: template.display_title,
        data_requirements: template.data_requirements,
    };
}
/**
 * Returns true for intents whose real agent reply must not be pre-empted by the 60s thin-slice
 * fallback (plan generation is slow by design; record-start/template-confirm can be slow on a slow
 * brain and dropping the command/ack is worse than a late deliver). The post-dispatch fallback
 * still covers genuinely empty agent output.
 */
export function shouldDeferFallback(body) {
    return (body.includes(PLAN_REQUEST_INTENT) ||
        body.includes(RECORD_START_INTENT) ||
        body.includes(RECORD_TEMPLATE_CONFIRM_INTENT));
}
/**
 * Match a saved template to a possibly free-text declaration ("我去打网球了"). First try the precise
 * alias lookup; then fall back to substring matching against each saved template's (already
 * builtin-expanded) aliases, so the plugin can do the activity extraction the LLM used to do.
 * Only saved templates participate, and aliases shorter than 2 chars are ignored, to bound false hits.
 */
function findReusableTemplate(activityHint) {
    const exact = findRecordingTemplate(activityHint);
    if (exact)
        return exact;
    const normalizedHint = normalizeAlias(activityHint);
    if (!normalizedHint)
        return null;
    for (const template of loadRecordingTemplates().templates) {
        for (const alias of [template.canonical_activity, ...template.aliases]) {
            const normalizedAlias = normalizeAlias(alias);
            if (normalizedAlias.length >= 2 && normalizedHint.includes(normalizedAlias)) {
                return template;
            }
        }
    }
    return null;
}
/**
 * Deterministic reused-template fast path. Returns a ready-to-deliver `record-start-0.1` command
 * when this is an `adhoc_declare` record-start that matches a saved template; otherwise null
 * (first-time activity or a `template_modify` request -> fall through to the LLM).
 */
export function tryBuildReusedRecordStartCommand(body) {
    const request = parseRecordStartRequest(body);
    if (!request)
        return null;
    if (request.trigger !== "adhoc_declare")
        return null;
    const template = findReusableTemplate(request.activityHint);
    if (!template)
        return null;
    return buildReusedRecordStartCommand(template, { sourceIntent: request.trigger });
}

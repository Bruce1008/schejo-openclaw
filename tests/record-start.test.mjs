// Tests for the deterministic reused-template record-start fast path (G8.5 A) and the
// premature-fallback exemption (G8.5 B). Run via `npm test` (builds dist first, then node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseRecordStartRequest,
  buildReusedRecordStartCommand,
  shouldDeferFallback,
  tryBuildReusedRecordStartCommand,
} from "../dist/extensions/record-start.js";

const PREFIX = "使用schejo skill。";

const tennisTemplate = {
  canonical_activity: "网球",
  aliases: ["网球", "tennis"],
  hk_workout_activity_type: "tennis",
  location_type: "outdoor",
  display_title: "记录网球",
  data_requirements: {
    duration: true,
    heart_rate: true,
    active_energy: true,
    distance: false,
    location: false,
  },
  created_at: "2026-06-05T20:00:00+08:00",
  updated_at: "2026-06-05T20:00:00+08:00",
};

function withTempCwd(run) {
  const dir = mkdtempSync(join(tmpdir(), "schejo-rt-"));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    return run(dir);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeTemplateStore(dir, templates) {
  const store = {
    schema_version: "recording-templates-0.1",
    updated_at: "2026-06-05T20:00:00+08:00",
    templates,
  };
  writeFileSync(join(dir, "schejo-recording-templates.json"), JSON.stringify(store), "utf8");
}

test("parseRecordStartRequest extracts activity_hint and trigger", () => {
  const body = `${PREFIX}intent=workout.record.start\n{"activity_hint":"我去打网球了","trigger":"adhoc_declare"}`;
  const parsed = parseRecordStartRequest(body);
  assert.ok(parsed);
  assert.equal(parsed.activityHint, "我去打网球了");
  assert.equal(parsed.trigger, "adhoc_declare");
});

test("parseRecordStartRequest returns null for non record-start bodies", () => {
  assert.equal(parseRecordStartRequest(`${PREFIX}intent=workout.plan.request\n{}`), null);
  assert.equal(parseRecordStartRequest("just chatting"), null);
  assert.equal(parseRecordStartRequest(`${PREFIX}intent=workout.record.start\n{}`), null); // no activity_hint
});

test("parseRecordStartRequest surfaces template_modify trigger and note", () => {
  const body = `${PREFIX}intent=workout.record.start\n{"activity_hint":"网球","trigger":"template_modify","modification_note":"室内网球，不要位置"}`;
  const parsed = parseRecordStartRequest(body);
  assert.ok(parsed);
  assert.equal(parsed.trigger, "template_modify");
  assert.equal(parsed.modificationNote, "室内网球，不要位置");
});

test("buildReusedRecordStartCommand builds a reused command from a template", () => {
  const cmd = buildReusedRecordStartCommand(tennisTemplate, {
    now: "2026-06-06T00:23:20+08:00",
    commandId: "wr-test-0001",
  });
  assert.equal(cmd.schema_version, "record-start-0.1");
  assert.equal(cmd.command_id, "wr-test-0001");
  assert.equal(cmd.generated_at, "2026-06-06T00:23:20+08:00");
  assert.equal(cmd.source_intent, "adhoc_declare");
  assert.equal(cmd.template_state, "reused");
  assert.equal(cmd.needs_user_confirmation, false);
  assert.equal(cmd.canonical_activity, "网球");
  assert.deepEqual(cmd.aliases, ["网球", "tennis"]);
  assert.equal(cmd.activity_label, "网球");
  assert.equal(cmd.hk_workout_activity_type, "tennis");
  assert.equal(cmd.location_type, "outdoor");
  assert.equal(cmd.display_title, "记录网球");
  assert.deepEqual(cmd.data_requirements, tennisTemplate.data_requirements);
});

test("buildReusedRecordStartCommand defaults command_id (wr-) and generated_at offset", () => {
  const cmd = buildReusedRecordStartCommand(tennisTemplate);
  assert.match(cmd.command_id, /^wr-/);
  assert.match(cmd.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
});

test("shouldDeferFallback is true for slow/actionable intents", () => {
  assert.equal(shouldDeferFallback(`${PREFIX}intent=workout.plan.request\n{}`), true);
  assert.equal(shouldDeferFallback(`${PREFIX}intent=workout.record.start\n{}`), true);
  assert.equal(shouldDeferFallback(`${PREFIX}intent=workout.record.template.confirm\n{}`), true);
});

test("shouldDeferFallback is false for quick/echo intents", () => {
  assert.equal(shouldDeferFallback(`${PREFIX}ping`), false);
  assert.equal(shouldDeferFallback(`${PREFIX}intent=workout.start_session\n{}`), false);
});

test("tryBuildReusedRecordStartCommand returns a reused command when a template is saved", () => {
  withTempCwd((dir) => {
    writeTemplateStore(dir, [tennisTemplate]);
    const body = `${PREFIX}intent=workout.record.start\n{"activity_hint":"tennis","trigger":"adhoc_declare"}`;
    const cmd = tryBuildReusedRecordStartCommand(body);
    assert.ok(cmd);
    assert.equal(cmd.template_state, "reused");
    assert.equal(cmd.hk_workout_activity_type, "tennis");
    assert.equal(cmd.canonical_activity, "网球");
  });
});

test("tryBuildReusedRecordStartCommand matches a free-text declaration to a saved template", () => {
  withTempCwd((dir) => {
    writeTemplateStore(dir, [tennisTemplate]);
    // iPhone sends the raw sentence, not a cleaned keyword — must still hit the template.
    const body = `${PREFIX}intent=workout.record.start\n{"activity_hint":"我去打网球了","trigger":"adhoc_declare"}`;
    const cmd = tryBuildReusedRecordStartCommand(body);
    assert.ok(cmd, "free-text 我去打网球了 should match the 网球 template");
    assert.equal(cmd.template_state, "reused");
    assert.equal(cmd.hk_workout_activity_type, "tennis");
  });
});

test("tryBuildReusedRecordStartCommand returns null with no template and never fast-paths template_modify", () => {
  withTempCwd((dir) => {
    // No template on disk -> first-time activity must fall through to the LLM.
    const unknownBody = `${PREFIX}intent=workout.record.start\n{"activity_hint":"风帆冲浪","trigger":"adhoc_declare"}`;
    assert.equal(tryBuildReusedRecordStartCommand(unknownBody), null);

    // Even with a saved template, a modify request must go to the LLM (regenerate candidate).
    writeTemplateStore(dir, [tennisTemplate]);
    const modifyBody = `${PREFIX}intent=workout.record.start\n{"activity_hint":"网球","trigger":"template_modify","modification_note":"室内"}`;
    assert.equal(tryBuildReusedRecordStartCommand(modifyBody), null);
  });
});

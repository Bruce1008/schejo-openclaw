# Workout Record Start Steps

**Scope** - Use this doc only when the user is starting an activity now and wants Schejo to record it on Apple Watch. This is not a training plan. Do not generate `WorkoutPlan`, do not give exercises/sets/reps, do not write state, and do not generate a report.

G8.5 rule: workout recording templates are stable and user-confirmed. First time for an activity → output a **candidate** template command and ask the iPhone to show confirm/adjust UI. Do **not** save it. After the user confirms, `workout-record-template-confirm.md` saves it. Later synonyms must reuse the saved template (e.g. `徒步` and `hiking` hit the same template).

## Input

Preferred app-generated shape:

```text
使用schejo skill。intent=workout.record.start
{ "trigger": "adhoc_declare", "activity_hint": "我开始打网球了" }
```

Adjustment shape:

```text
使用schejo skill。intent=workout.record.start
{ "trigger": "template_modify",
  "activity_hint": "网球",
  "modification_note": "室内网球，不要记录位置" }
```

The user may also say the same thing in natural language, for example `我开始打网球了` / `准备去徒步` / `现在骑车`. Treat that as `trigger="adhoc_declare"` if they are clearly starting the activity now and are not asking for a plan.

## Output

Return exactly one fenced `json` block with a `WorkoutRecordStartCommand`:

```json
{
  "schema_version": "record-start-0.1",
  "command_id": "wr-2026-06-05-7c1a",
  "generated_at": "<ISO8601 当前时间 +08:00>",
  "source_intent": "adhoc_declare",
  "template_state": "candidate",
  "needs_user_confirmation": true,
  "canonical_activity": "网球",
  "aliases": ["网球", "tennis"],
  "activity_label": "网球",
  "hk_workout_activity_type": "tennis",
  "location_type": "outdoor",
  "display_title": "记录网球",
  "data_requirements": {
    "duration": true,
    "heart_rate": true,
    "active_energy": true,
    "distance": false,
    "location": false
  }
}
```

Field rules:

| Field | Rule |
|---|---|
| `schema_version` | fixed `record-start-0.1` |
| `command_id` | `wr-<YYYY-MM-DD>-<4 hex>` |
| `generated_at` | ISO8601 current time with `+08:00` |
| `source_intent` | `adhoc_declare` or `template_modify` |
| `template_state` | `candidate` for first-time / adjusted unsaved templates, `reused` when a saved template was found |
| `needs_user_confirmation` | `true` for `candidate`, `false` for `reused` |
| `canonical_activity` | stable activity key, usually Chinese (`徒步`, not a mix of `hiking` and `徒步`) |
| `aliases` | synonyms that should hit the same template later (`["徒步","hiking","hike","爬山"]`) |
| `activity_label` | short user-facing activity, usually Chinese (`网球`, `徒步`, `骑行`) |
| `hk_workout_activity_type` | one of the supported aliases below |
| `location_type` | `unknown` / `indoor` / `outdoor` |
| `display_title` | short title shown on iPhone / Watch, usually `记录<activity_label>` |
| `data_requirements` | booleans only; use this to tell the phone/watch what the activity needs |

Supported `hk_workout_activity_type` aliases:

`other`, `badminton`, `basketball`, `cycling`, `functional_strength_training`, `high_intensity_interval_training`, `hiking`, `pilates`, `running`, `soccer`, `swimming`, `table_tennis`, `tennis`, `traditional_strength_training`, `walking`, `yoga`.

If the activity is clear but not in the supported list, use `other` and keep `activity_label` specific.

## Classification Guide

| User activity | `hk_workout_activity_type` | `location_type` | `distance` | `location` |
|---|---|---|---|---|
| 网球 / tennis | `tennis` | `outdoor` unless they say indoor | false | false |
| 徒步 / hike / hiking | `hiking` | `outdoor` | true | true |
| 跑步 / running | `running` | `outdoor` unless treadmill/indoor | true for outdoor | true for outdoor |
| 走路 / 快走 / walking | `walking` | `outdoor` unless indoor | true for outdoor | true for outdoor |
| 骑行 / cycling | `cycling` | `outdoor` unless indoor bike | true for outdoor | true for outdoor |
| 游泳 / swimming | `swimming` | `unknown` | true | false |
| 羽毛球 | `badminton` | `indoor` unless outdoor stated | false | false |
| 篮球 | `basketball` | `indoor` unless outdoor stated | false | false |
| 足球 | `soccer` | `outdoor` unless indoor stated | true | true |
| 乒乓球 | `table_tennis` | `indoor` | false | false |
| 瑜伽 | `yoga` | `indoor` unless outdoor stated | false | false |
| 普拉提 | `pilates` | `indoor` | false | false |
| 力量训练 / 健身 | `traditional_strength_training` | `indoor` unless outdoor stated | false | false |
| 自重 / 功能训练 | `functional_strength_training` | `indoor` unless outdoor stated | false | false |
| HIIT / 间歇 | `high_intensity_interval_training` | `indoor` unless outdoor stated | false | false |

Always set `duration`, `heart_rate`, and `active_energy` to `true`.

## Route

1. Identify the activity the user is starting now from `activity_hint` or the raw sentence.
2. Call `schejo_find_workout_record_template` once with that activity text.
3. If the tool returns `status="found"`:
   - Output a `record-start-0.1` JSON command copied from the template.
   - Set `template_state="reused"` and `needs_user_confirmation=false`.
   - Do not change the saved template.
4. If the tool returns `status="missing"` or this is `trigger="template_modify"`:
   - Choose / adjust `hk_workout_activity_type`, `location_type`, aliases, and `data_requirements` using the guide and any `modification_note`.
   - Output a candidate `record-start-0.1` JSON command.
   - Set `template_state="candidate"` and `needs_user_confirmation=true`.
   - Do **not** save it here. The iPhone must ask the user to confirm or adjust.

Allowed tool: only `schejo_find_workout_record_template`.

## Forbidden

- No `WorkoutPlan` / `plan-0.2`.
- No exercises, sets, reps, distances, target paces, or training prescriptions.
- Do not call save/write tools. A first-time candidate must not be stored before user confirmation.
- Do not mention HealthKit, OpenClaw, prompt, JSON, schema, or "intent" to the user outside the JSON field values.
- If the user asks for a plan (`给我安排`, `怎么练`, `训练计划`), use `workout-plan.md` instead.

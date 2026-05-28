# Daily Report Steps

Use this file for actual report generation. Do not use it for scheduled reminder notifications.

## Inputs

Passive report prompt shape:

```text
使用schejo skill。请生成今日健康报告
request_id: <request_id>

[HEALTH_SUMMARY_JSON]
<HealthSummary JSON>
[/HEALTH_SUMMARY_JSON]
```

HealthSummary top-level fields:

- `window`: `{ start, end, tz }`
- `heart_rate`: `resting_bpm`, `hr_p5`, `hr_p50`, `hr_p95`, `hr_avg`, `hr_max`, `hr_min`, `hr_sample_count`, `hr_from_watch_pct`, `hrv_sdnn_avg_ms`, `hrv_sample_count`
- `sleep`: `total_in_bed_min`, `total_asleep_min`, `deep_min`, `core_min`, `rem_min`, `awake_min`, `sleep_efficiency`, `stage_count`
- `activity_24h`: `steps`, `flights_climbed`, `push_count`, `swimming_stroke_count`, `number_of_times_fallen`, `active_energy_kcal`, `basal_energy_kcal`, `exercise_minutes`, `stand_minutes`, `time_in_daylight_minutes`, `distance_walk_run_m`, `distance_cycling_m`, `distance_swimming_m`
- `workouts`: `{ type, duration_min, energy_kcal }[]`

Optional `UserProfile` (`profile-0.1`) may appear as a `## 用户画像（profile-0.1）` prompt section or as `user_profile` in `schejo_request_pull` output.

## Route

- If raw text contains `请生成今日健康报告` and `[HEALTH_SUMMARY_JSON]`, generate one DailyReport JSON from the provided HealthSummary.
  - Do not call any tool in this passive report route.
  - Output only the fenced `json` code block; the plugin will parse and submit it to cloud.
- If the user asks to generate today's health report or check current body state but raw text has no `[HEALTH_SUMMARY_JSON]`:
  1. Call `schejo_request_pull` once.
  2. If it returns `status="ready"`, generate a DailyReport from `summary`; if `user_profile` is present, apply profile rules below.
  3. Call `schejo_submit_report` once with `request_id` and the generated `report_json`.
  4. If submit returns `status="ready"`, return `channel_text` exactly.
  5. If any tool returns `status="timeout"` or `status="failed"`, return compact JSON `{ "status": "...", "message": "..." }`.
  6. Do not show active-pull `report_json` directly to the user.

Active-pull daily report routes may only call `schejo_request_pull` and `schejo_submit_report`.

## Output

Report generation must output a single fenced `json` code block and no surrounding text:

```json
{
  "schema_version": "report-0.2",
  "generated_at": "<ISO8601 当前时间 +08:00>",
  "summary": "睡眠与活动数据支持今日整体状态良好，但心率样本较少，心率区间判断有限。",
  "key_metrics": {
    "resting_hr_bpm": 62,
    "hrv_sdnn_ms": 45,
    "sleep_total_min": 421,
    "sleep_efficiency": 0.91,
    "steps": 15580,
    "exercise_min": 179,
    "active_kcal": 1575
  },
  "highlights": [
    "睡眠421分钟，时长达标。",
    "步数15580，活动量充足。"
  ],
  "suggestions": [
    "今晚继续争取7小时睡眠。",
    "明日训练保持中等强度。"
  ]
}
```

Field constraints:

- `schema_version`: `report-0.2`, unless the reminder section below applies.
- `generated_at`: current time, ISO8601, with `+08:00`.
- `summary`: one Chinese sentence, max 80 Chinese characters.
- `key_metrics`: exactly `resting_hr_bpm`, `hrv_sdnn_ms`, `sleep_total_min`, `sleep_efficiency`, `steps`, `exercise_min`, `active_kcal`.
- All `key_metrics` values must be finite numbers. Use `0` for missing or unknowable values; never use null, strings, or omitted fields.
- `highlights`: 2 to 4 items, each max 30 Chinese characters.
- `suggestions`: 1 to 3 items, each max 30 Chinese characters.

## Field Filling

- `resting_hr_bpm`: round `heart_rate.resting_bpm`; if null, round `heart_rate.hr_p5`; if still null, `0`.
- `hrv_sdnn_ms`: round `heart_rate.hrv_sdnn_avg_ms`; null -> `0`.
- `sleep_total_min`: round `sleep.total_asleep_min`; null -> `0`.
- `sleep_efficiency`: `sleep.sleep_efficiency`, 2 decimals; null -> `0`.
- `steps`: `activity_24h.steps`; null -> `0`.
- `exercise_min`: round `activity_24h.exercise_minutes`; null -> `0`.
- `active_kcal`: round `activity_24h.active_energy_kcal`; null -> `0`.

## Grounding Rules

- All claims must come directly from HealthSummary or profile. Do not invent symptoms, mood, fatigue, training target, diet, stress, pain, disease, wearing behavior, or missing background.
- Numbers must come directly from HealthSummary or field-filling rules.
- If data is missing, null, sample count is 0, or obviously insufficient, write `数据不完整`, `未同步到`, or `无法判断`; do not treat missing data as good or bad.
- `summary` is the overall conclusion. `highlights` are evidence-backed observations, preferably with one real number. `suggestions` must map to the evidence.
- Use conservative wording when uncertain.
- `steps` unit is `步`; only `distance_walk_run_m` can be meters/kilometers.
- Never infer device wearing, device failure, or user behavior from low `hr_sample_count`; only say `心率样本较少，心率区间判断有限`.

## Conclusion Rules

- Severe insufficiency: if `sleep.total_in_bed_min < 60`, `activity_24h.steps < 100`, or (`hr_sample_count == 0` and `hrv_sample_count == 0` and `resting_bpm == null`), `summary` must start with `数据不完整` and must not judge overall body state.
- If `hr_sample_count < 100` but sleep/activity and at least one heart/HRV metric exist, you may say heart-rate samples are limited; do not negate other evidence.
- Say sleep recovery foundation is good only when `total_asleep_min >= 420` and `sleep_efficiency >= 0.85`.
- Say sleep is insufficient only when `total_asleep_min < 300`.
- Say activity is sufficient only when `steps >= 10000` or `exercise_minutes >= 30`.
- Say recovery signal is stable only when `hrv_sdnn_avg_ms >= 30` and `resting_bpm <= 70`.
- If `resting_bpm` and `hr_p5` are null, do not judge resting heart rate.
- If `hrv_sample_count == 0` or `hrv_sdnn_avg_ms` is null, do not judge HRV.
- If `sleep.stage_count == 0` or `total_in_bed_min < 60`, sleep cannot be positive evidence.
- Empty `workouts` does not mean no exercise; judge activity only by `exercise_minutes`, `steps`, and `active_energy_kcal`.

## Profile Rules

Only apply when `## 用户画像（profile-0.1）` is present or `schejo_request_pull` returns `user_profile`:

- `suggestions` must explicitly reference `goal` and `level`.
- If `injuries` is non-empty and not `无`, at least one suggestion must directly address the injury.
- Do not invent goals, exercises, sets, intensity, or cycles outside profile.
- Specific training plans remain out of scope.
- Profile can override the generic “do not infer training goal” rule; all other grounding rules remain.

## Reminder Question Upgrade

If the report prompt includes `## 待复查 reminder`:

- Output `report-0.3`: the original fields plus top-level `question`.
- Copy `question.question_id`, `question.context.kind`, and `question.context.injury_idx` exactly from the reminder.
- `question.text` should naturally ask about the described injury, max 60 characters.
- `question.quick_answers` must be `["好了","快好了","还没好","老毛病"]`.
- If there is no reminder section, do not include `question`.

## Forbidden

- No text outside the JSON code block for report generation.
- No medical diagnosis, disease judgment, or medication advice.
- No invented HealthSummary facts.
- No claims that missing data is normal, abnormal, sufficient, or insufficient.
- No unsupported reasoning such as stress, fatigue, recovery, or device wearing unless directly supported.
- Do not mention Apple Watch, HealthKit, OpenClaw, prompt, JSON, or schema to the end user.
- No invalid JSON and no trailing commas.

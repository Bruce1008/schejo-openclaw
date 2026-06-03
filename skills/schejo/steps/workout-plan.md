# Workout Plan Steps

**Scope** — Use this doc only to turn one `intent=workout.plan.request` into one `WorkoutPlan` JSON. Nothing else: not readiness advice (that is `workout-readiness`), not state logging, not a daily report.

## Contract

### Input

```text
使用schejo skill。intent=workout.plan.request
{ "trigger": "readiness_button",
  "activity_hint": null,
  "readiness": { "band": "yellow", "sleep_h": 6.2, "hrv_d": -12, "rhr_d": 3,
                 "dims": { "sleep": "green", "hrv": "yellow", "rhr": "green" } },
  "profile_snapshot": { "goal": ["gain_muscle"], "level": "intermediate",
                        "equipment": ["gym"], "training_time": ["evening"],
                        "injury_note": "半月板有伤" } }
```

| Field | Meaning |
|---|---|
| `trigger` | `readiness_button` / `training_time_alert` / `adhoc_declare`. Copy verbatim into `source_intent`. |
| `activity_hint` | The activity the user declared (e.g. `网球`) when `trigger=adhoc_declare`; else null. |
| `readiness` | `band` + `sleep_h` / `hrv_d` / `rhr_d` + per-dim `dims`. May be null. |
| `profile_snapshot` | `goal[]` / `level` / `equipment[]` / `training_time[]` / optional `injury_note`. `equipment` is the user's training **environment**. |

`state` is not in the prompt — read it with `schejo_read_state`, the only tool allowed here.

### Output — a single fenced `json` block, nothing else

```json
{
  "schema_version": "plan-0.1",
  "plan_id": "wp-2026-06-03-7c1a",
  "generated_at": "<ISO8601 当前时间 +08:00>",
  "source_intent": "readiness_button",
  "readiness_snapshot": { "band": "yellow", "dims": { "sleep": "green", "hrv": "yellow", "rhr": "green" } },
  "profile_snapshot": { "goal": ["gain_muscle"], "level": "intermediate", "equipment": ["gym"], "training_time": ["evening"] },
  "state_snapshot": { "status": "available", "injuries": [ { "description": "半月板有伤", "status": "chronic" } ] },
  "estimated_duration_min": 35,
  "blocks": [
    { "block_id": "b1", "modality": "strength", "activity_type": null,
      "display_title": "下肢力量（避深蹲，护半月板）", "estimated_duration_min": 35,
      "instructions": "膝关节不适即停；不做深蹲 / 弓步加载，改用器械固定轨迹。",
      "params": { "exercise_name": "腿举", "sets": 3, "reps": "10-12", "load_hint": "中等 / RPE7", "rest_sec": 90, "equipment": "腿举机" },
      "transition_to_next": null }
  ],
  "custom_fields": null,
  "template_slot": null,
  "data_requirements": null
}
```

- **Envelope**: `schema_version` `plan-0.1` · `plan_id` `wp-<YYYY-MM-DD>-<4 hex>` (echoed back on 做 / 改 / 跳) · `generated_at` ISO8601 with `+08:00` · `source_intent` = `trigger` · `readiness_snapshot` / `profile_snapshot` / `state_snapshot` echo what shaped the plan (`state_snapshot` = `status` + the injuries that mattered, each `{ "description", "status" }`) · `estimated_duration_min` int, sum of blocks · `blocks` ordered, ≥1 · `custom_fields` / `template_slot` null · `data_requirements` null, unless an ad-hoc activity needs capture (e.g. hiking → `{ "location": true }`).
- **Block**: `block_id` · `modality` · `activity_type` (string | null — names the specific activity for title / sub-copy, never drives rendering) · `display_title` · `estimated_duration_min` int · `instructions` (plain Chinese) · `params` (typed below) · `transition_to_next` (string | null).

`modality` — closed set, never invent another:

| `modality` | for |
|---|---|
| `strength` | resistance work for strength / muscle |
| `cardio_endurance` | steady aerobic (run / bike / elliptical / incline walk) |
| `hiit` | high-intensity intervals |
| `mobility_yoga` | mobility / flexibility / yoga |
| `recreation` | casual or social sport / play |
| `competitive_sport` | competitive / match-intent sport |
| `recovery_rehab` | light restorative or rehab work |
| `outdoor_endurance` | outdoor distance activity (hiking / trail) |

`params` by `modality` (required / optional):

| `modality` | Required | Optional |
|---|---|---|
| `strength` | `exercise_name`(string) / `sets`(int) / `reps`(int or string like "8-12") | `load_hint`(string) / `rest_sec`(int) / `equipment`(string) |
| `cardio_endurance` | `activity`(string) / `duration_min`(int) | `intensity_zone`(string) / `target_hr_range`(string) / `pace_hint`(string) |
| `hiit` | `rounds`(int) / `work_sec`(int) / `rest_sec`(int) / `movements`(string[], non-empty) | — |
| `mobility_yoga` | `poses` **or** `movements`(string[], at least one non-empty) | `hold_sec`(int) / `breathing_hint`(string) |
| `recreation` / `competitive_sport` | `sport_name`(string) | `duration_min`(int) / `intensity_hint`(string) / `recording_mode_hint`(string) |
| `outdoor_endurance` | `activity`(string) | `duration_min`(int) / `distance`(number) / `elevation`(number) / `location_required`(bool) / `gps_hint`(string) |
| `recovery_rehab` | — (none required) | reuse `mobility_yoga` shape, or carry movements in block `instructions` |

Include the required keys; add optionals only when meaningful.

## Rails (hard limits — never cross)

| 约束 | 规则 |
|---|---|
| band | 端侧已算，直接用，**不重算**（权威在端侧） |
| injury | active / chronic 伤处不加载；挑关节友好替代，并在 `display_title` / `instructions` 体现避让 |
| equipment | `params.equipment` 必须在用户 `profile.equipment` 环境可得（语义判断，非字符串子集） |
| medical | 不输出诊断 / 用药 / 医疗处方；强度只用 `*_hint` / zone / range |
| enum | `modality` 等枚举值不自造 |
| grounding | injuries / status / signals 只用 `schejo_read_state` + `injury_note` 读到的，不编 |
| output | 只输出单个 `json`；产不出合规 plan 时输出 `{ "status": "failed", "message": "<短中文>" }`；不提交 cloud、不出日报 |
| user text | `display_title` / `instructions` 不提 HealthKit / Watch / OpenClaw / prompt / JSON / schema / intent |
| scope | 不抢调度权，只产本步 plan |

## Runtime Judgement (design within the Rails)

设计这次 session — 选哪个 `modality`、要不要第二个有序 block（多则设 `transition_to_next`）、动作搭配与强度落点 — 综合权衡，别照「状态 → 方案」查表：

- 权衡输入：`goal` × `band` + 弱维度 × `equipment` × injuries（ad-hoc 再加 `activity_hint`）。
- 优先级：**安全 / 伤病 > band 天花板 > goal 适配 > 偏好**。
- band 天花板：`green` 可进阶 · `yellow` 控量控强度 · `red` 轻量恢复 · `unknown` 保守；弱维度收紧（`sleep` 低 → 控量 · `hrv` 低 → 避冲刺间歇 · `rhr` 高 → 降强度）。
- 通常一个聚焦的主 block；确有助于目标再加一个有序 block。
- ad-hoc：把声明的活动映射到最贴的 `modality`，活动名放 `activity_type`（休闲 ↔ 竞技 → `recreation` ↔ `competitive_sport`）。

## Route

1. `schejo_read_state` 一次 → `status` + injuries + signals；与 `injury_note` 合并成完整伤病图（同部位不重复）。
2. `band` + `dims` 照用。
3. 在 Rails 内按 Runtime Judgement 设计 session。
4. 输出 `WorkoutPlan` JSON。

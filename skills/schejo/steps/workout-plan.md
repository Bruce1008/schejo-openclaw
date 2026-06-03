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

- **Envelope**: `schema_version` `plan-0.1` · `plan_id` `wp-<YYYY-MM-DD>-<4 hex>` (echoed back on do / modify / skip) · `generated_at` ISO8601 with `+08:00` · `source_intent` = `trigger` · `readiness_snapshot` / `profile_snapshot` / `state_snapshot` echo what shaped the plan (`state_snapshot` = `status` + the injuries that mattered, each `{ "description", "status" }`) · `estimated_duration_min` int, sum of blocks · `blocks` ordered, ≥1 · `custom_fields` / `template_slot` null · `data_requirements` null, unless an ad-hoc activity needs capture (e.g. hiking → `{ "location": true }`).
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

| limit | rule |
|---|---|
| band | computed on-device — use as given, **never recompute** (authority lives on-device) |
| injury | never load an active / chronic injured area; pick a joint-friendly alternative and reflect the avoidance in `display_title` / `instructions` |
| equipment | every `params.equipment` must be obtainable in the user's `profile.equipment` environment (semantic judgement, not a string subset) |
| medical | no diagnosis / medication / medical prescription; intensity only as `*_hint` / zone / range |
| enum | never invent `modality` (or any other enum) values |
| grounding | use only the injuries / status / signals read from `schejo_read_state` + `injury_note`; never fabricate |
| output | output only the single `json`; if no compliant plan is possible, output `{ "status": "failed", "message": "<short Chinese reason>" }`; do not submit to cloud or produce a daily report |
| user text | `display_title` / `instructions` must not mention HealthKit / Watch / OpenClaw / prompt / JSON / schema / intent |
| scope | do not take over scheduling; produce only this step's plan |

## Runtime Judgement (design within the Rails)

Design this session — which `modality`, whether a second ordered block is worth it (set `transition_to_next` if so), movement choice and where intensity lands — by weighing it all. Don't look it up from a "state → plan" table:

- Weigh: `goal` × `band` + weak dims × `equipment` × injuries (plus `activity_hint` for ad-hoc).
- Priority: **safety / injury > band ceiling > goal fit > preference**.
- Band ceiling: `green` may progress · `yellow` caps volume / intensity · `red` light / restorative · `unknown` conservative. The weak dim tightens it: low `sleep` → cap volume · low `hrv` → avoid sprint intervals · high `rhr` → ease intensity.
- Usually one focused primary block; add a second ordered block only when it clearly serves the goal.
- Ad-hoc: map the declared activity to the best-fit `modality` and put the activity name in `activity_type` (casual ↔ competitive → `recreation` ↔ `competitive_sport`).

## Route

1. Call `schejo_read_state` once → `status` + injuries + signals; merge with `injury_note` into the full injury picture (don't double-count a body part).
2. Take `band` + `dims` as given.
3. Design the session per *Runtime Judgement*, within the *Rails*.
4. Output the `WorkoutPlan` JSON.

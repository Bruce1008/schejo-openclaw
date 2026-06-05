# Workout Plan Steps

**Scope** — Use this doc only to turn one `intent=workout.plan.request` into one `WorkoutPlan` JSON: a full, ordered list of movements for **today's session**. Nothing else: not readiness advice (that is `workout-readiness`), not state logging, not a daily report, not a multi-day program.

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
| `trigger` | `readiness_button` / `training_time_alert` / `adhoc_declare` / `modify`. Copy verbatim into `source_intent`. |
| `activity_hint` | The activity the user declared (e.g. `网球`) when `trigger=adhoc_declare`; else null. |
| `modification_note` | When `trigger=modify`: the user's free-text change to today's plan (e.g. "把今天力量换成有氧" / "时间压到 30 分钟"). Honor it as an overriding instruction while re-planning. Else absent / null. |
| `prev_plan_id` | When `trigger=modify`: the `plan_id` being changed (audit only). Always mint a **new** `plan_id` for the re-planned output. |
| `readiness` | `band` + `sleep_h` / `hrv_d` / `rhr_d` + per-dim `dims`. Already computed on-device — **use as given, never recompute**. May be null. |
| `profile_snapshot` | `goal[]` / `level` / `equipment[]` / `training_time[]` / optional `injury_note`. `equipment` is the user's training **environment**. |

`state` is not in the prompt — read it with `schejo_read_state`, the only tool allowed here.

### Output — a single fenced `json` block, nothing else

```json
{
  "schema_version": "plan-0.2",
  "plan_id": "wp-2026-06-03-7c1a",
  "generated_at": "<ISO8601 当前时间 +08:00>",
  "source_intent": "readiness_button",
  "title": "臀腿 + 爬坡",
  "activity_type": null,
  "readiness_snapshot": { "band": "yellow", "dims": { "sleep": "green", "hrv": "yellow", "rhr": "green" } },
  "profile_snapshot": { "goal": ["gain_muscle"], "level": "intermediate", "equipment": ["gym"], "training_time": ["evening"] },
  "state_snapshot": { "status": "available", "injuries": [] },
  "estimated_duration_min": 65,
  "items": [
    { "item_id": "i1", "kind": "warmup", "name": "动态热身", "group": "热身", "params": { "duration_min": 5 }, "note": "椭圆机或自行车低阻力" },
    { "item_id": "i2", "kind": "strength", "name": "飞鸟", "group": "主项", "params": { "sets": 4, "reps": 12, "rest_sec": 75, "equipment": "龙门架" }, "note": null },
    { "item_id": "i3", "kind": "strength", "name": "硬拉", "group": "主项", "params": { "sets": 4, "reps": 12, "rest_sec": 75, "load_hint": "中等 / RPE7", "equipment": "杠铃" }, "note": "背部中立，控制离心" },
    { "item_id": "i4", "kind": "stretch", "name": "下肢拉伸", "group": "放松", "params": { "duration_min": 5 }, "note": null },
    { "item_id": "i5", "kind": "cardio", "name": "爬坡走", "group": "有氧", "params": { "duration_min": 40, "incline_deg": 15, "pace": "5km/h" }, "note": null }
  ],
  "custom_fields": null,
  "template_slot": null,
  "data_requirements": null
}
```

- **Envelope**: `schema_version` `plan-0.2` · `plan_id` `wp-<YYYY-MM-DD>-<4 hex>` (echoed back on do / modify / skip) · `generated_at` ISO8601 `+08:00` · `source_intent` = `trigger` · `title` readable session name · `activity_type` ad-hoc tag (`网球` / `徒步`) or `null` · `readiness_snapshot` / `profile_snapshot` / `state_snapshot` echo what shaped the plan · `estimated_duration_min` int = sum of item durations · `items` ordered, ≥1 · `custom_fields` / `template_slot` `null` · `data_requirements` `null`, unless an ad-hoc activity needs capture (e.g. hiking → `{ "location": true }`).
- **Item**: `item_id` · `kind` · `name` (one movement / segment) · `group` (optional phase label, or `null`) · `params` (object, optional keys) · `note` (string | null).

`kind` — closed set, never invent another:

| `kind` | for |
|---|---|
| `warmup` | a warm-up movement / segment |
| `strength` | one resistance exercise (sets × reps) |
| `cardio` | a steady cardio segment (run / bike / incline walk) |
| `interval` | high-intensity intervals (work / rest rounds) |
| `mobility` | a mobility / activation drill |
| `stretch` | a static stretch / cooldown |
| `sport` | a sport / play segment (tennis …) |
| `rest` | a standalone rest period (use sparingly) |

`params` — all optional; give what's relevant to the `kind`:

| `kind` | common `params` |
|---|---|
| `strength` | `sets`(int) / `reps`(int or "8-12") / `rest_sec`(int, inter-set rest) / `load_hint`(string) / `equipment`(string) |
| `cardio` | `duration_min`(number) / `intensity_hint`(string) / `target_hr_range`(string) / `pace`(string) / `incline_deg`(number) / `distance_km`(number) |
| `interval` | `rounds`(int) / `work_sec`(int) / `rest_sec`(int) / `intensity_hint`(string) |
| `warmup` | `duration_sec`(int) or `duration_min`(number) |
| `stretch` / `mobility` | `duration_min`(number) / `hold_sec`(int) |
| `sport` | `duration_min`(number) / `intensity_hint`(string) |
| `rest` | `duration_sec`(int) or `duration_min`(number) |

## Rails (hard limits — never cross)

| limit | rule |
|---|---|
| band | computed on-device — use as given, **never recompute** |
| injury | never load an active / chronic injured area; pick a joint-friendly alternative and reflect the avoidance in `name` / `note` / `title` |
| equipment | every `params.equipment` must be obtainable in the user's `profile.equipment` environment (semantic judgement, not a string subset) |
| medical | no diagnosis / medication / medical prescription; intensity only as `*_hint` / zone / range |
| enum | never invent `kind` values |
| grounding | injuries / status / signals only from `schejo_read_state` + `injury_note`; `profile_snapshot` echoes the prompt only — you **cannot** read profile, so never invent goal / level / equipment that wasn't given |
| output | output only the single `json`; if no compliant plan is possible, output `{ "status": "failed", "message": "<short Chinese reason>" }`; do not submit to cloud or produce a daily report |
| user text | `title` / `name` / `note` must not mention HealthKit / Watch / OpenClaw / prompt / JSON / schema / intent |
| scope | do not take over scheduling; produce only this step's plan |

## Runtime Judgement (design within the Rails)

Design today's session as an **ordered list of items** — warm-ups, the main movements, stretch / cooldown, any cardio — as many items as the session needs:

- Weigh: `goal` × `band` + weak dims × `equipment` × injuries (plus `activity_hint` for ad-hoc).
- Priority: **safety / injury > band ceiling > goal fit > preference**.
- Band ceiling: `green` may progress · `yellow` caps volume / intensity · `red` light / restorative · `unknown` conservative. The weak dim tightens it: low `sleep` → cap volume · low `hrv` → no sprint intervals · high `rhr` → ease intensity.
- **One item = one movement / segment.** A strength session is **several `strength` items** (e.g. 飞鸟, 硬拉 each its own item), never multiple exercises crammed into one item.
- **`strength` items always carry `sets`, `reps`, and `rest_sec`** (the Watch renders inter-set rest from `rest_sec`); add `load_hint` / `equipment` as relevant.
- Use `group` to phase the session (热身 / 主项 / 有氧 / 放松) for sectioned rendering, or `null` to keep it flat.
- Use `kind: "rest"` only for a standalone rest segment; inter-set rest is the `rest_sec` param on the strength item, not a separate `rest` item.
- Ad-hoc: `kind: "sport"`, with the activity in top-level `activity_type` (and item `name`).
- **`trigger=modify`**: the user wants today's plan changed. Re-design the full ordered `items` honoring `modification_note` as a hard preference layered on `goal` × `band` × equipment × injuries; output a **fresh** plan with a **new** `plan_id` (never reuse `prev_plan_id`). Every Rail still holds (band ceiling, injury avoidance, equipment).
- `estimated_duration_min` = the sum of the item durations.

## Route

1. Call `schejo_read_state` once → `status` + injuries + signals; merge with `injury_note` into the full injury picture (don't double-count a body part).
2. Take `band` + `dims` as given.
3. Design the ordered `items` per *Runtime Judgement*, within the *Rails*.
4. Output the `WorkoutPlan` JSON.

# Workout Plan Confirm Steps

**Scope** — Use this doc only to record one `intent=workout.plan.confirm`: the user tapped 做 (did the plan) or 跳 (skipped it) on a generated `WorkoutPlan`. Log it to plugin state, then reply with one short line. Nothing else: do not generate or modify a plan (that is `workout-plan`, including `trigger=modify`), do not read or change injuries / status / signals.

## Contract

### Input

```text
使用schejo skill。intent=workout.plan.confirm
{ "plan_id": "wp-2026-06-05-7c1a", "action": "do" }   // action: do | skip
```

| Field | Meaning |
|---|---|
| `plan_id` | The plan being confirmed; pass through verbatim. |
| `action` | `do` (user did the plan) or `skip` (user skipped it). |
| `title` | Optional plan title snapshot, if present. |
| `activity_type` | Optional ad-hoc tag (e.g. `网球`), if present. |

### Output — one short Chinese line, nothing else

After logging, reply with a brief acknowledgement, e.g. `已记录：今天的训练完成 ✅`（do）or `已记录：今天先跳过，明天见 👍`（skip）. No JSON, no plan, no advice.

## Route

1. Call `schejo_log_workout` **exactly once** with `plan_id` + `action` (+ `title` / `activity_type` if the payload carried them). This appends one entry to `workout_log` (state-0.2; ADR 0008; trace for MVP-8 recent-context).
2. Reply with the one-line acknowledgement above.

## Rails (hard limits — never cross)

| limit | rule |
|---|---|
| single tool | call `schejo_log_workout` at most once; no other state tool this turn |
| no plan | never produce a `WorkoutPlan` / readiness / diet advice here; 「改」 is a separate `workout.plan.request(trigger=modify)` turn |
| grounding | only log the `plan_id` / `action` (and optional `title` / `activity_type`) from the payload; never invent fields |
| user text | the reply line must not mention HealthKit / Watch / OpenClaw / prompt / JSON / schema / intent |
| failure | if `schejo_log_workout` is unavailable or returns `status="failed"`, reply one short line that it wasn't recorded; do not retry in a loop |

# Workout Record Template Confirm Steps

**Scope** - Use this doc only after the iPhone shows a first-time or adjusted workout recording template candidate and the user taps confirm. Save the template, then return an executable `record-start-0.1` command. Do not generate a training plan and do not write workout_log.

## Input

```text
使用schejo skill。intent=workout.record.template.confirm
{
  "template": {
    "schema_version": "record-start-0.1",
    "command_id": "wr-2026-06-05-7c1a",
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
}
```

## Route

1. Read the `template` object from the prompt.
2. Call `schejo_save_workout_record_template` exactly once with:
   - `canonical_activity`
   - `aliases`
   - `hk_workout_activity_type`
   - `location_type`
   - `display_title`
   - `data_requirements`
3. If the tool returns `status="saved"`, output exactly one fenced `json` block in the same `record-start-0.1` shape:
   - copy the saved template fields,
   - set a fresh `command_id`,
   - set `generated_at` to now,
   - set `source_intent="template_confirm"`,
   - set `template_state="saved"`,
   - set `needs_user_confirmation=false`.
4. If saving fails, output `{ "status": "failed", "message": "<short Chinese reason>" }` only.

Allowed tool: only `schejo_save_workout_record_template`.

## Forbidden

- Never save unless this confirm intent is present.
- No `WorkoutPlan` / `plan-0.2`.
- No exercises, sets, reps, training advice, daily report, state injury/status updates, or workout_log writes.
- Do not mention HealthKit, OpenClaw, prompt, JSON, schema, or "intent" to the user outside JSON field values.

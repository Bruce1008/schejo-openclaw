# Workout Reminder Steps

Use this file for `training_time` workout reminders and for the heartbeat turn that sends the reminder.

This route implements the MVP-6 G7 product target: **OpenClaw sends a visible reminder; the user taps it; the iPhone foreground generates a workout plan**. The alert never contains a `WorkoutPlan` and never pre-generates one.

## Setup Intent

Examples:

- `使用schejo skill。按我的训练时间提醒我安排训练。`
- `使用schejo skill。每天傍晚提醒我训练。`

Behavior:

1. Do not call `schejo_request_pull`.
2. Do not call `schejo_send_workout_plan_prompt` during setup unless the user explicitly asks to send one now.
3. Treat this as an OpenClaw scheduling request. The host agent should create or update a daily cron/heartbeat at the requested local time.
4. The heartbeat message should be:

```text
使用schejo skill。发送今日训练提醒。
```

5. If the scheduling tool is available in the host, create/update the cron. If it is not available, return a concise instruction for the user/operator to create it.

`profile.training_time` is owned by the iPhone profile. If the heartbeat setup only receives a broad bucket such as `evening`, map it to a reasonable local-time reminder inside that bucket (for example 18:00) unless the user gave an exact time. Do not claim that Schejo has persisted the profile in plugin state.

## Heartbeat Fired Intent

Example heartbeat message:

```text
使用schejo skill。发送今日训练提醒。
```

Target behavior:

1. Do not call `schejo_request_pull`.
2. Do not generate a `WorkoutPlan`.
3. Call `schejo_send_workout_plan_prompt` once.
4. The tool asks cloud `POST /v1/health/daily_report_prompt` with `prompt_kind: "workout_plan"` to send an APNs alert to the paired iPhone with:
   - `schejo_action: "start_workout_plan"`
   - `prompt_id`: a stable id such as `workout-YYYY-MM-DD`
   - alert text like `到训练时间了，点开安排今日训练`
5. Final reply should be short, e.g. `已提醒你打开 Schejo 安排今日训练。`

Until `schejo_send_workout_plan_prompt` exists in the installed plugin, do not pretend this path is implemented. Return compact JSON:

```json
{"status":"failed","message":"schejo_send_workout_plan_prompt is not available in this plugin version"}
```

## iPhone Tap Behavior

When the user taps the alert, iOS should:

1. Detect `schejo_action == "start_workout_plan"`.
2. Bring the app foreground.
3. Evaluate current readiness locally if needed.
4. Send `intent=workout.plan.request` with `trigger: "training_time_alert"` plus local readiness/profile context.
5. Show the existing workout-plan generating state until the `WorkoutPlan` reply arrives.

Ignoring the alert should do nothing: no plan, no cloud storage, no HealthKit/readiness work in the background, and no iPhone-side timer.

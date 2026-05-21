# Daily Reminder Steps

Use this file for “每天 X 点提醒我看日报/生成日报” and for the heartbeat turn that sends the reminder.

This route changes the old MVP-2 G5 product target from automatic background report generation to: **daily proactive reminder; user taps alert; iPhone foreground generates the report**.

## Setup Intent

Examples:

- `使用schejo skill。每天早上 8 点提醒我看日报。`
- Onboarding selects `08:00` and sends the same prompt text to OpenClaw.

Behavior:

1. Do not call `schejo_request_pull`.
2. Do not collect HealthKit data.
3. Treat this as an OpenClaw scheduling request. The host agent should create or update a daily cron/heartbeat at the requested local time.
4. The heartbeat message should be:

```text
使用schejo skill。发送今日健康日报提醒。
```

5. If the scheduling tool is available in the host, create/update the cron. If it is not available, return a concise instruction for the user/operator to create it.

## Heartbeat Fired Intent

Example heartbeat message:

```text
使用schejo skill。发送今日健康日报提醒。
```

Target behavior after implementation:

1. Do not call `schejo_request_pull`.
2. Call `schejo_send_daily_report_prompt` once.
3. The tool should ask cloud `POST /v1/health/daily_report_prompt` to send an APNs alert to the paired iPhone with:
   - `schejo_action: "start_daily_report"`
   - `prompt_id`: a stable id such as `daily-YYYY-MM-DD`
   - alert text like `今天的 Schejo 日报可以生成了，点开开始分析。`
4. Final reply should be short, e.g. `已提醒你打开 Schejo 生成今日健康日报。`

Until `schejo_send_daily_report_prompt` exists in the installed plugin, do not pretend this path is implemented. Return compact JSON:

```json
{"status":"failed","message":"schejo_send_daily_report_prompt is not available in this plugin version"}
```

## iPhone Tap Behavior

When the user taps the alert, iOS should:

1. Detect `schejo_action == "start_daily_report"`.
2. Bring the app foreground.
3. Show `正在生成日报`.
4. Run the existing foreground manual report path.
5. Show `等待 OpenClaw 返回日报` until `schejo_report` arrives.

HealthKit collection must happen after the user taps the alert, not in a background silent push handler.

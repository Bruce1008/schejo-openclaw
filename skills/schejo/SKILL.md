---
name: schejo
description: Route Schejo health report, daily reminder, health-state, and pre-workout readiness requests for the paired iPhone app. Use when raw text mentions schejo, asks to generate/check today's health report, asks to set or send a daily report reminder, reports short-term health state such as injuries, sickness, travel, busyness, or low motivation, or contains intent=workout.start_session (the 要锻炼 readiness request).
---

# Schejo Skill - Router

This file is the Schejo skill entrypoint. Keep routing here; detailed workflows live in `steps/`.

Before acting, choose exactly one route and read its step file:

- **Daily report generation**: user asks to generate today's health report, check current body state, or raw text contains `请生成今日健康报告` with `[HEALTH_SUMMARY_JSON]`. Read `steps/daily-report.md`.
- **Daily report reminder setup / reminder firing**: user says “每天 X 点提醒我看日报/生成日报”, onboarding sends the equivalent text, or a heartbeat asks Schejo to send a daily report reminder. Read `steps/daily-reminder.md`.
- **State maintenance**: user reports injury, sickness, travel, busyness, low motivation, or short-term discomfort. Read `steps/state.md`.
- **Workout readiness advice**: raw text contains `intent=workout.start_session` (the iPhone 要锻炼 button uploads a readiness band payload). Read `steps/workout-readiness.md`.
- **Ping smoke test**: raw text contains both `schejo` and `ping`; reply exactly `spike-ack: <raw text 原文>`.

## Global Rules

- The iPhone prompt prefix is `使用schejo skill。`; onboarding-generated prompts must include it.
- Do not use `schejo_request_pull` for scheduled daily reminders. Scheduled reminders should notify the user to open the iPhone app; HealthKit collection should happen after the user taps the alert and the app is foreground.
- Only call tools explicitly allowed by the selected step file.
- Do not invent HealthSummary, profile, state, reminder, cron, APNs, or HealthKit facts.
- If the selected route requires a tool that is not available in the current plugin version, say so as compact JSON with `status="failed"` and a clear `message`.

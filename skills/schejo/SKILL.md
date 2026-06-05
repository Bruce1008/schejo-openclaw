---
name: schejo
description: Route Schejo health report, daily reminder, workout reminder, health-state, pre-workout readiness, training-plan requests, and workout recording starts/templates for the paired iPhone app. Use when raw text mentions schejo, asks to generate/check today's health report, asks to set or send a daily report reminder, asks to send a workout/training reminder, reports short-term health state such as injuries, sickness, travel, busyness, or low motivation, contains intent=workout.start_session (the 要锻炼 readiness request), contains intent=workout.plan.request, contains intent=workout.plan.confirm (the 做/跳 confirmation), contains intent=workout.record.start, or contains intent=workout.record.template.confirm.
---

# Schejo Skill - Router

This file is the Schejo skill entrypoint. Keep routing here; detailed workflows live in `steps/`.

Before acting, choose exactly one route and read its step file:

- **Daily report generation**: user asks to generate today's health report, check current body state, or raw text contains `请生成今日健康报告` with `[HEALTH_SUMMARY_JSON]`. Read `steps/daily-report.md`.
- **Daily report reminder setup / reminder firing**: user says “每天 X 点提醒我看日报/生成日报”, onboarding sends the equivalent text, or a heartbeat asks Schejo to send a daily report reminder. Read `steps/daily-reminder.md`.
- **Workout reminder setup / reminder firing**: user says “按训练时间提醒我训练”, asks to send today's workout/training reminder, or a heartbeat asks Schejo to send a workout plan reminder. Read `steps/workout-reminder.md`.
- **State maintenance**: user reports injury, sickness, travel, busyness, low motivation, or short-term discomfort. Read `steps/state.md`.
- **Workout readiness advice**: raw text contains `intent=workout.start_session` (the iPhone 要锻炼 button uploads a readiness band payload). Read `steps/workout-readiness.md`.
- **Workout plan generation**: raw text contains `intent=workout.plan.request`. Read `steps/workout-plan.md`. (This also covers `trigger=modify`, the 改 re-plan.)
- **Workout plan confirm (做 / 跳)**: raw text contains `intent=workout.plan.confirm`. Read `steps/workout-confirm.md`.
- **Workout recording start**: raw text contains `intent=workout.record.start`, or the user says they are starting an activity now (for example “我开始打网球了”) and is not asking for a plan. Read `steps/workout-record-start.md`.
- **Workout recording template confirm**: raw text contains `intent=workout.record.template.confirm`. Read `steps/workout-record-template-confirm.md`.
- **Ping smoke test**: raw text contains both `schejo` and `ping`; reply exactly `spike-ack: <raw text 原文>`.

## Global Rules

- The iPhone prompt prefix is `使用schejo skill。`; onboarding-generated prompts must include it.
- Do not use `schejo_request_pull` for scheduled daily or workout reminders. Scheduled reminders should notify the user to open the iPhone app; HealthKit/readiness collection should happen after the user taps the alert and the app is foreground.
- Only call tools explicitly allowed by the selected step file.
- Do not invent HealthSummary, profile, state, reminder, cron, APNs, or HealthKit facts.
- If the selected route requires a tool that is not available in the current plugin version, say so as compact JSON with `status="failed"` and a clear `message`.

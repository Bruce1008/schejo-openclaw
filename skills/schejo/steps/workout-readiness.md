# Workout Readiness Steps

Use this file when the iPhone "要锻炼" button uploads a pre-workout readiness band. Produce 0-3 directional suggestions before training. Do not generate a daily report here.

This is MVP-5: **directional advice only** (e.g. "今天偏黄，控制总量"), NOT a training plan with exercises / sets / intensity / numbers (that is MVP-6).

## Input

Raw text shape (ADR 0012 stable intent; the band is already computed on-device per ADR 0014):

```text
使用schejo skill。intent=workout.start_session
{ "band": "yellow",
  "sleep_h": 6.2, "hrv_d": -12, "rhr_d": 3,
  "dims": { "sleep": "green", "hrv": "yellow", "rhr": "green" },
  "injury_note": "半月板有伤" }
```

- `band`: overall readiness `green` / `yellow` / `red` / `unknown` (worst-of the dims). **Use it as given; never recompute or override it.**
- `dims`: per-dimension band for `sleep` / `hrv` / `rhr`.
- `sleep_h`: last night sleep hours. `hrv_d` / `rhr_d`: today's % deviation vs personal baseline (HRV lower = worse; resting HR higher = worse).
- `injury_note` (optional, may be absent): the user's free-text injury note from their iPhone profile (stable / chronic self-report, e.g. `半月板有伤`). It is **separate** from the structured `injuries[]` returned by `schejo_read_state` (acute entries with active/chronic status). Treat both as injury context and merge them.

## Route

1. Call `schejo_read_state` once → current `user_state.status`, structured `injuries` (active/chronic), recent `signals`. Combine these with the prompt's `injury_note` (if present) as the full injury context.
2. Read `band` + `dims` from the prompt JSON. Do not recompute the band.
3. Produce **0-3** short directional suggestions per the rules below, then return them as plain text.

Only `schejo_read_state` may be called in this route. Do not call report or state-write tools.

## Advice Rules

- Match overall tone to `band`:
  - `green`: 可正常训练，状态允许适度进阶。
  - `yellow`: 适度训练，控制总量 / 强度，别冲极限。
  - `red`: 以恢复为主，建议轻量活动或休息，不安排大强度。
  - `unknown`: 数据还在积累，先按自身感觉来、别强上大强度；可提示继续佩戴设备补齐基线。
- Call out the weak dimension(s) driving the band:
  - `sleep` 黄/红（睡眠不足）→ 控制总量、别加码强度。
  - `hrv` 黄/红（HRV 偏低、恢复不足）→ 避免大强度间歇 / 高心率冲刺。
  - `rhr` 黄/红（静息心率偏高、疲劳或应激）→ 降强度、留意身体反应。
- Injury / status aware (from `injury_note` + `schejo_read_state`):
  - `injury_note`（profile 自述，稳定 / 慢性）→ 视为长期注意项：避开会加重该部位的动作、循序渐进；与下方 state 急性伤病合并，同一部位**不要重复两次**。
  - Any `active` injury → **至少一条**建议回应它（避开受累部位、不要加载该部位）。
  - `chronic` injury → 提醒注意该部位、循序渐进。
  - `user_state.status` = `sick` / `injured` / `low_motivation` 等 → 纳入考虑（如 sick → 以休息为主）。
  - Relevant recent `signals`（如 fatigue / pain）→ 可纳入语气。
- Keep it **directional**: 方向、强度档位、注意事项。No specific exercises, sets, reps, distances, durations, or numeric prescriptions.

## Output

- Plain Chinese text, **0-3 short lines** (一条一句或顿号分隔)；no JSON, no code fence, no headings.
- Concise and actionable; a few sentences total.
- Example (band=yellow, hrv 黄, active 膝伤)：
  `今天整体偏黄，建议中低强度、控制总量。HRV 偏低说明恢复一般，避免大强度间歇冲刺。膝盖有伤，避开会加重膝关节负荷的动作。`

## Forbidden

- Never recompute or override `band` (端侧已算, ADR 0014)。
- No training plan: no exercise names tied to sets / reps / intensity / distance / time numbers (MVP-6).
- No medical diagnosis, disease judgment, or medication advice.
- Do not invent injuries, status, or signals beyond `schejo_read_state` output.
- Do not mention HealthKit, OpenClaw, prompt, JSON, schema, or "intent" to the user.
- Do not output a DailyReport or call report tools here.

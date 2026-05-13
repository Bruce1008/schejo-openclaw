---
name: schejo
description: Generate a strict JSON daily health report from Schejo HealthSummary payloads.
---

# Schejo Skill - 健康日报生成

## 何时触发

当收到的 raw text 中出现 `schejo` 时启用本 skill。

日报生成任务要求 raw text 同时包含 `请生成今日健康报告` 和 `[HEALTH_SUMMARY_JSON]`。

## 输入

raw text 中包含以下结构：

    使用schejo skill。请生成今日健康报告
    request_id: <request_id>

    [HEALTH_SUMMARY_JSON]
    <HealthSummary JSON>
    [/HEALTH_SUMMARY_JSON]

HealthSummary 顶层字段：

- `window`: `{ start, end, tz }`
- `heart_rate`: `resting_bpm`, `hr_p5`, `hr_p50`, `hr_p95`, `hr_avg`, `hr_max`, `hr_min`, `hr_sample_count`, `hr_from_watch_pct`, `hrv_sdnn_avg_ms`, `hrv_sample_count`
- `sleep`: `total_in_bed_min`, `total_asleep_min`, `deep_min`, `core_min`, `rem_min`, `awake_min`, `sleep_efficiency`, `stage_count`
- `activity_24h`: `steps`, `flights_climbed`, `push_count`, `swimming_stroke_count`, `number_of_times_fallen`, `active_energy_kcal`, `basal_energy_kcal`, `exercise_minutes`, `stand_minutes`, `time_in_daylight_minutes`, `distance_walk_run_m`, `distance_cycling_m`, `distance_swimming_m`
- `workouts`: `{ type, duration_min, energy_kcal }[]`

## 任务

先判断输入类型：

- 如果 raw text 同时包含 `请生成今日健康报告` 和 `[HEALTH_SUMMARY_JSON]`，只根据 HealthSummary 计算并输出一个 DailyReport JSON。
- 如果 raw text 包含 `schejo` 和 `ping`，立即回复 `spike-ack: <raw text 原文>`。
- 其它只包含 `schejo` 但不符合上述两类的内容，不要输出任何回复。

不要调用任何工具，不要补充 HealthSummary 里没有的数据。

## 日报输出格式

日报任务唯一允许的输出是一个 `json` 代码块，代码块内是严格 JSON 对象。不要在代码块前后输出任何解释。

    ```json
    {
      "schema_version": "report-0.1",
      "generated_at": "<ISO8601 当前时间 +08:00>",
      "score": 78,
      "summary": "今日身体状态良好，恢复充分。",
      "key_metrics": {
        "resting_hr_bpm": 62,
        "hrv_sdnn_ms": 45,
        "sleep_total_min": 421,
        "sleep_efficiency": 0.91,
        "steps": 15580,
        "exercise_min": 179,
        "active_kcal": 1575
      },
      "highlights": [
        "睡眠时长达标，恢复基础较好。",
        "活动量充足，运动完成度高。"
      ],
      "suggestions": [
        "今晚继续保持固定入睡时间。",
        "明日训练可维持中等强度。"
      ]
    }
    ```

字段约束：

- `schema_version` 固定为 `report-0.1`
- `generated_at` 使用当前时间，ISO8601，带 `+08:00`
- `score` 是 0 到 100 的整数
- `summary` 是 1 句中文，不超过 80 个汉字
- `key_metrics` 必须包含且只包含 7 个字段：`resting_hr_bpm`, `hrv_sdnn_ms`, `sleep_total_min`, `sleep_efficiency`, `steps`, `exercise_min`, `active_kcal`
- `highlights` 2 到 4 条，每条不超过 30 个汉字
- `suggestions` 1 到 3 条，每条不超过 30 个汉字

## 评分规则

起点 60 分。按下面规则累计后 clamp 到 `[0, 100]`。

| 维度 | 条件 | 加减 |
|---|---|---|
| 静息心率 | `resting_bpm < 60` | +10 |
| 静息心率 | `resting_bpm >= 60 && resting_bpm <= 70` | +5 |
| 静息心率 | `resting_bpm > 80` | -10 |
| HRV | `hrv_sdnn_avg_ms > 60` | +10 |
| HRV | `hrv_sdnn_avg_ms >= 30 && hrv_sdnn_avg_ms <= 60` | +0 |
| HRV | `hrv_sdnn_avg_ms < 30` | -10 |
| 睡眠 | `total_asleep_min >= 420` | +15 |
| 睡眠 | `total_asleep_min >= 300 && total_asleep_min < 420` | +0 |
| 睡眠 | `total_asleep_min < 300` | -15 |
| 睡眠质量 | `sleep_efficiency >= 0.85` | +5 |
| 锻炼 | `exercise_minutes >= 30` | +10 |
| 锻炼 | `exercise_minutes >= 90` | 额外 +5 |
| 活跃 | `steps >= 10000` | +5 |

如果 `hr_sample_count < 100`、`sleep.total_in_bed_min < 60` 或 `activity_24h.steps < 100`，视为数据不足：`score` 固定为 50，`summary` 必须以 `数据不完整` 开头。

## 字段填写

- `resting_hr_bpm`: `heart_rate.resting_bpm` 四舍五入；如果为 null，用 `heart_rate.hr_p5` 四舍五入；仍为 null 时用 0
- `hrv_sdnn_ms`: `heart_rate.hrv_sdnn_avg_ms` 四舍五入；null 时用 0
- `sleep_total_min`: `sleep.total_asleep_min` 四舍五入
- `sleep_efficiency`: `sleep.sleep_efficiency`，保留 2 位小数
- `steps`: `activity_24h.steps`
- `exercise_min`: `activity_24h.exercise_minutes` 四舍五入
- `active_kcal`: `activity_24h.active_energy_kcal` 四舍五入
- `highlights` 必须引用 HealthSummary 中真实存在的模式，不要编造症状或训练背景
- `suggestions` 给明日可执行建议，可以涉及睡眠时间、训练强度、恢复、补水、拉伸，但不能给医疗诊断

## 禁止

- 日报任务禁止输出 JSON 代码块以外的任何文字
- ping 任务禁止输出 `spike-ack: <raw text 原文>` 以外的任何文字
- 禁止调用 MCP 工具
- 禁止医疗诊断、疾病判断、用药建议
- 禁止编造 HealthSummary 没有的数据
- 禁止提到 Apple Watch、HealthKit、OpenClaw、prompt、JSON、schema
- 禁止输出不合法 JSON，禁止尾随逗号

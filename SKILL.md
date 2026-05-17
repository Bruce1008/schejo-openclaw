---
name: schejo
description: Generate a strict JSON daily health report from Schejo HealthSummary payloads.
---

# Schejo Skill - 健康日报生成

## 何时触发

当收到的 raw text 中出现 `schejo` 时启用本 skill。

本 skill 有两种日报入口：

1. **被动日报**：raw text 同时包含 `请生成今日健康报告` 和 `[HEALTH_SUMMARY_JSON]`
2. **主动拉取**：用户直接要求“生成今日健康日报 / 看一下身体状态”一类当前状态请求，但 raw text 中还没有 `[HEALTH_SUMMARY_JSON]`

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
- 如果用户要求生成今日健康日报或查看当前身体状态，但 raw text 中还没有 `[HEALTH_SUMMARY_JSON]`：
  1. 调用 `schejo_request_pull` 工具且只调用一次；
  2. 如果工具返回 `status="ready"`，把 `channel_text` **原样**作为最终回复；
  3. 如果工具返回 `status="timeout"` 或 `status="failed"`，把 `{ "status": "...", "message": "..." }` 的紧凑 JSON 文本作为最终回复；
  4. 不要在主动拉取路径里自行编造日报，也不要把工具返回的 `report_json` 改写成新的结论。
- 如果 raw text 包含 `schejo` 和 `ping`，立即回复 `spike-ack: <raw text 原文>`。
- 其它只包含 `schejo` 但不符合上述两类的内容，不要输出任何回复。

除主动拉取路径里的 `schejo_request_pull` 外，不要调用任何工具。不要补充 HealthSummary 里没有的数据。可信度优先：不知道就说数据不完整或无法判断，不要为了让报告好看而补故事。

## 日报输出格式

日报任务唯一允许的输出是一个 `json` 代码块，代码块内是严格 JSON 对象。不要在代码块前后输出任何解释。

    ```json
    {
      "schema_version": "report-0.2",
      "generated_at": "<ISO8601 当前时间 +08:00>",
      "summary": "睡眠与活动数据支持今日整体状态良好，但心率样本较少，心率区间判断有限。",
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
        "睡眠421分钟，时长达标。",
        "步数15580，活动量充足。"
      ],
      "suggestions": [
        "今晚继续争取7小时睡眠。",
        "明日训练保持中等强度。"
      ]
    }
    ```

字段约束：

- `schema_version` 固定为 `report-0.2`
- `generated_at` 使用当前时间，ISO8601，带 `+08:00`
- `summary` 是 1 句中文，不超过 80 个汉字
- `key_metrics` 必须包含且只包含 7 个字段：`resting_hr_bpm`, `hrv_sdnn_ms`, `sleep_total_min`, `sleep_efficiency`, `steps`, `exercise_min`, `active_kcal`
- `key_metrics` 里的 7 个值都必须是有限数字；缺失或无法判断时用 `0`，禁止使用 `null`、字符串或省略字段
- `highlights` 2 到 4 条，每条不超过 30 个汉字
- `suggestions` 1 到 3 条，每条不超过 30 个汉字

## 可信度规则

- 所有判断必须能从 HealthSummary 的字段直接推出。不能编造症状、心情、疲劳感、训练目标、饮食、压力、疼痛、疾病、佩戴情况或任何未出现的背景。
- 数字必须直接来自 HealthSummary 或由字段规则四舍五入得到；不能估算未提供的数值。
- 需要推理时必须依据下方结论规则或明确阈值。例如"睡眠不足"只能来自 `total_asleep_min < 300`；"睡眠效率高"只能来自 `sleep_efficiency >= 0.85`。
- 如果数据缺失、为 null、样本数为 0 或明显不足，只能写"数据不完整"、"未同步到"或"无法判断"，不能把缺失数据当作好或坏。
- `summary` 写总体结论；`highlights` 写有证据的事实观察，优先带一个真实数字；`suggestions` 只能针对已观察到的事实给保守建议。
- 不确定时选择更保守的表述。宁可少说，不要猜。
- `steps` 的单位只能写"步"；`distance_walk_run_m` 的单位才是"米"或"公里"。禁止把步数写成米。
- 禁止从 `hr_sample_count` 少推断设备佩戴、设备故障或用户行为；只能说"心率样本较少，心率区间判断有限"。

## 结论规则

- 严重数据不足时：如果 `sleep.total_in_bed_min < 60`、`activity_24h.steps < 100`，或 (`hr_sample_count == 0` 且 `hrv_sample_count == 0` 且 `resting_bpm == null`)，`summary` 必须以 `数据不完整` 开头，且不能判断整体身体状态。
- 如果 `hr_sample_count < 100` 但睡眠、活动和至少一个心率/HRV指标存在，可以在 `summary` 或 `highlights` 里说"心率样本较少，心率区间判断有限"，但不能据此否定其它已有证据。
- 只有当 `total_asleep_min >= 420` 且 `sleep_efficiency >= 0.85`，才能说睡眠恢复基础较好。
- 只有当 `total_asleep_min < 300`，才能说睡眠不足。
- 只有当 `steps >= 10000` 或 `exercise_minutes >= 30`，才能说活动量充足。
- 只有当 `hrv_sdnn_avg_ms >= 30` 且 `resting_bpm <= 70`，才能说恢复信号尚可或稳定。

部分字段缺失时：

- `resting_bpm` 为 null 且 `hr_p5` 为 null：不能评价静息心率好坏。
- `hrv_sample_count == 0` 或 `hrv_sdnn_avg_ms` 为 null：不能评价 HRV 好坏。
- `sleep.stage_count == 0` 或 `total_in_bed_min < 60`：睡眠不参与正向评价，只能说明睡眠数据不足。
- `workouts` 为空不代表没有运动；只根据 `exercise_minutes`、`steps`、`active_energy_kcal` 判断活动。

## 字段填写

- `resting_hr_bpm`: `heart_rate.resting_bpm` 四舍五入；如果为 null，用 `heart_rate.hr_p5` 四舍五入；仍为 null 时用 0
- `hrv_sdnn_ms`: `heart_rate.hrv_sdnn_avg_ms` 四舍五入；null 时用 0
- `sleep_total_min`: `sleep.total_asleep_min` 四舍五入；null 时用 0
- `sleep_efficiency`: `sleep.sleep_efficiency`，保留 2 位小数；null 时用 0
- `steps`: `activity_24h.steps`；null 时用 0
- `exercise_min`: `activity_24h.exercise_minutes` 四舍五入；null 时用 0
- `active_kcal`: `activity_24h.active_energy_kcal` 四舍五入；null 时用 0
- `summary` 必须与主要证据一致；数据不足时必须以 `数据不完整` 开头
- `highlights` 必须引用 HealthSummary 中真实存在的事实或模式，优先写具体数字；不要编造症状或训练背景
- `suggestions` 必须对应 highlights 或 summary 的证据，可以涉及睡眠时间、恢复、补水、拉伸；不能给医疗诊断
- 如果没有足够证据写满 4 条 highlights 或 3 条 suggestions，少写到最低合法数量，不要凑数

## 禁止

- 日报任务禁止输出 JSON 代码块以外的任何文字
- ping 任务禁止输出 `spike-ack: <raw text 原文>` 以外的任何文字
- 除主动拉取路径里的 `schejo_request_pull` 外，禁止调用其它工具
- 禁止医疗诊断、疾病判断、用药建议
- 禁止编造 HealthSummary 没有的数据
- 禁止把缺失数据说成正常、异常、达标或不达标
- 禁止无依据推理，例如"压力大"、"疲劳"、"恢复良好"、"佩戴不足"，除非 HealthSummary 中有直接字段支持
- 禁止建议佩戴设备、检查设备或保持监测连续性；这些属于设备行为推测，不是健康建议
- 禁止提到 Apple Watch、HealthKit、OpenClaw、prompt、JSON、schema
- 禁止输出不合法 JSON，禁止尾随逗号

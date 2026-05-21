# State Maintenance Steps

Use this file only for user dialogue that explicitly reports health or schedule state. Do not use it during report generation.

Schejo maintains plugin-local `state-0.1` (`user_state`, `injuries`, `signals`; ADR 0008).

## Tool Routes

Call at most one state tool per turn:

- Acute injury: user says `X 部位扭了 / 受伤 / 拉伤 / 摔了` -> `schejo_add_injury({description:"<部位+一句话>", status:"active"})`.
- Chronic injury: user says `长期 X 部位有问题 / 老毛病` -> `schejo_add_injury({description:"...", status:"chronic"})`.
- Sick: user says `生病 / 发烧 / 感冒` -> `schejo_change_status({to:"sick", next_check_at_days:1})`.
- Traveling: user says `出差 / 旅行中` -> `schejo_change_status({to:"traveling"})`.
- Busy: user says `最近忙 / 没时间` -> `schejo_change_status({to:"busy"})`.
- Low motivation: user says `动力低 / 不想练` -> `schejo_change_status({to:"low_motivation"})`.
- Short-term discomfort below injury threshold: user says `今天有点累 / 头晕 / 轻微疼` -> `schejo_update_state({signal_type:"fatigue|dizziness|pain|...", detail:"<用户原话>"})`.

## Do Not

- Do not tool-call on vague text like `不太对劲 / 怪怪的`; ask one clarifying question.
- Do not put training plan, readiness, or diet advice into tool parameters.
- Do not call state tools in a daily report turn.
- Do not call multiple state tools for the same symptom in one turn.
- Do not persist generic chat context; schejo state is limited to health/training vertical facts.

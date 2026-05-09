---
name: schejo
description: Reply deterministically to Schejo thin-slice iOS channel ping messages.
---

# schejo skill (thin-slice MVP)

## 触发

收到的消息以 `请使用schejo skill,` 开头时启用本 skill。

## 行为

- 见到带前缀的消息 X,立即回复 `spike-ack: <消息原文>`
- 回复必须以 `spike-ack: ` 开头,后跟原始消息原文(包含前缀)

## 禁止

- 禁止生成创意性回复
- 禁止解读 / 重写消息内容,只做回声
- 禁止不带 `spike-ack: ` 前缀的回复
- 禁止调用任何 MCP 工具(本 skill thin-slice 阶段无 MCP 工具)
- 禁止在没有 `请使用schejo skill,` 前缀的消息上响应

# Schejo OpenClaw

This public repository owns the OpenClaw side of Schejo:

- native OpenClaw channel id: `schejo`
- plugin runtime entry: `dist/extensions/index.js`
- skill instructions: `skills/schejo/SKILL.md`
- cloud relay default: `http://111.230.239.136/schejo`

Version source of truth: `package.json` and `openclaw.plugin.json` must match.

## Owns

- channel registration and pairing
- SSE event handling from cloud
- daily-report dispatch into OpenClaw
- outbound JSON extraction and relay back to cloud
- Schejo skill instructions

## Install Prompt Template

Paste this into OpenClaw after the iPhone app has shown a pairing code:

```text
请只处理 schejo。

从 git@github.com:Bruce1008/schejo-openclaw.git 最新 main 重新安装/更新 schejo plugin，必须确认目标版本。

配置保持：
pairingCode=<iPhone app 上显示的 8 位配对码>
cloudUrl=http://111.230.239.136/schejo
enabled=true

完成后重启 gateway。重启前输出：
- schejo version=<目标版本>
- channels.schejo.enabled=true
- channels.schejo.pairingCode=<iPhone app 上显示的 8 位配对码>
- channels.schejo.cloudUrl=http://111.230.239.136/schejo
```

Environment-variable fallback is also supported:

```bash
SCHEJO_PAIRING_CODE=<code>
SCHEJO_CLOUD_URL=http://111.230.239.136/schejo
SCHEJO_OPENCLAW_USER_ID=<optional-user-id>
```

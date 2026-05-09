# Schejo OpenClaw Thin Slice

This repository contains the public OpenClaw side of the Schejo thin-slice MVP:

- native OpenClaw channel id: `schejo`
- plugin runtime entry: `dist/extensions/index.js`
- skill instructions: `skills/schejo/SKILL.md`
- cloud relay default: `http://111.230.239.136/schejo`
- current plugin version: `0.1.1`

## Install Prompt Template

Paste this into OpenClaw after the iPhone app has shown a pairing code:

```text
请从 GitHub 安装并启用我的自用 OpenClaw native plugin/channel:

仓库: git:github.com/Bruce1008/schejo-openclaw.git
插件 id: schejo
channel id: schejo

安装/启用时,请把 schejo plugin config 写成:
{
  "pairingCode": "<iPhone app 上显示的 8 位配对码>",
  "cloudUrl": "http://111.230.239.136/schejo"
}

如果当前 OpenClaw runtime 不能自动提供 user id,再把 openclawUserId 设成当前用户 id。
完成后请重启或重新加载 gateway,并确认插件 stderr 出现:
[schejo] received_code: ...
[schejo] pair_confirmed
```

Environment-variable fallback is also supported:

```bash
SCHEJO_PAIRING_CODE=<code>
SCHEJO_CLOUD_URL=http://111.230.239.136/schejo
SCHEJO_OPENCLAW_USER_ID=<optional-user-id>
```

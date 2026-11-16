# WhaleChat · 小鲸鱼聊天室

> 一个只属于你和你的 AI 伴侣的私聊房间。网页打开就能聊，也能装成桌面 / 手机 App。
> 不经过任何第三方聊天平台，消息、图片、语音、记忆全部留在你自己的电脑里。
>
> A private chat room between you and your own AI companion, built on top of
> [DeepSeek Harness](https://www.deepseek.com/harness/) (DSH). Self-hosted, local-first,
> no third-party messaging platform involved.

## 它是什么

WhaleChat 不是一个模型，也不是一个聊天平台。它是**架在 DSH 之上的一间私人聊天室**：

- 你的电脑上跑着 DSH（负责"思考"和调用模型）
- WhaleChat 用一个本地 Node 服务把 DSH 接出来，做成像微信/QQ 一样的聊天界面
- 浏览器、桌面窗口、安卓手机都连这同一个房间
- 聊天记录只写在 `data/` 目录里，不出你的机器

## 功能

- 流式回复、打字中提示
- 表情包面板（本地目录里放图就有）
- 发图片、粘贴截图
- 语音消息：本机 faster-whisper 转写成文字再发（可选，不联网、不花钱）
- 双方头像可换、聊天背景可换（图片存在本地）
- 手机 / 电脑多端同步（同一个房间）
- 6 位短码登录，令牌鉴权
- 可选：局域网 HTTPS（手机录音需要安全上下文）
- 可选：桌面壳（PySide6 / Qt WebEngine）打包成 exe

## 架构

```
浏览器 / PWA / 手机 WebView / 桌面壳
        │  HTTP + SSE
        ▼
   server.mjs（本地 Node 服务，本仓库）
        │  DSH HTTP API：sessions/create、sessions/prompt、events/mux
        ▼
   DSH 桌面版（本机运行，负责模型与工具）
        │
        ▼
   你配置的模型服务（DeepSeek / 兼容网关）
```

WhaleChat 本身**不包含模型**，也不代理你的 API key；模型调用全部由 DSH 完成。

## 环境要求

| 组件 | 是否必须 | 说明 |
| --- | --- | --- |
| [DeepSeek Harness](https://www.deepseek.com/harness/) 桌面版 | 必须 | 提供会话与模型调用；需要先装好并登录 |
| Node.js ≥ 20 | 必须 | 运行 `server.mjs` |
| Python + faster-whisper | 可选 | 只有要用语音转写时才需要 |
| PySide6 | 可选 | 只有要打包桌面窗口时才需要 |

## 快速开始

```bash
# 1. 装依赖
npm install

# 2. 启动（默认 0.0.0.0:3222）
npm start
```

启动后终端会打印类似：

```
电脑：http://127.0.0.1:3222/?k=<你的令牌>
手机：http://<你的内网IP>:3222/  （6 位短码 123456）
```

浏览器打开那条链接即可。第一次启动会自动创建 `data/token.txt` 和 `data/pin.txt`。

> DSH 桌面版每次启动端口会变，服务会自动扫描本机端口找到它；
> 也可以在 `data/config.json` 里写死 `{"baseUrl": "http://127.0.0.1:xxxxx"}`。

## 配置

`data/config.json`（不存在会自动创建/使用默认值）：

```json
{
  "baseUrl": "http://127.0.0.1:3080",
  "provider": "deepseek-account",
  "model": "deepseek-flash",
  "asrPython": "python",
  "visionProvider": "deepseek-account",
  "visionModel": "deepseek-flash"
}
```

| 字段 | 说明 |
| --- | --- |
| `baseUrl` | DSH 地址；留空则自动发现 |
| `provider` / `model` | 文字聊天用的模型（默认走 DSH 的模型选择） |
| `visionProvider` / `visionModel` | 发图片时临时切换的视觉模型 |
| `asrPython` | 语音转写用的 Python 解释器路径 |

环境变量：`WHALE_PORT`、`WHALE_HOST`、`WHALE_ASR_PYTHON`、`WHALE_REBUILD_AGENTS`。
`QQ_BRIDGE_DIR` 是可选的集成点（复用另一套角色卡/黑话/共享记忆），不设置就是独立运行。

## 人格与记忆

房间的人格来自 `data/content/`：

- `角色.md` —— 角色卡（必填，示例见 `examples/角色.md`）
- `语感.md` —— 说话风格（可选）
- `黑话.json` —— 梗/黑话表（可选，格式见示例）

启动时会把它们拼成 `room/AGENTS.md` 交给 DSH 会话。改完内容后删掉 `room/AGENTS.md`
或设 `WHALE_REBUILD_AGENTS=1` 重启即可重新生成。

记忆分两层：

1. DSH 侧的会话上下文（由 DSH 管理）
2. 可选的长期记忆插件（例如本项目作者自用的"全忆"卡带）——不属于本仓库，按需接入

## 手机使用

- 同一局域网下，手机浏览器打开 `http://<电脑IP>:3222/`，输 6 位短码
- 想录音：手机浏览器只在 HTTPS 下给麦克风。可以自己生成自签证书放进 `data/certs/`
  （`cert.pem` / `key.pem`），服务会自动在 3443 端口起一个 HTTPS
- 想装成 App：用 WebView 壳加载上面的地址即可（本仓库的 `app/app_qt.py` 是桌面壳示例）

## 安全与隐私

- 所有聊天记录、图片、语音、令牌都在本机 `data/`，不上传任何第三方
- 服务默认监听 `0.0.0.0`，仅建议在**可信局域网**使用；公网暴露请自行加反向代理与鉴权
- `data/`、`room/` 已在 `.gitignore` 中，**不要**把带聊天记录或令牌的目录提交到仓库
- 语音转写在本机完成（faster-whisper），不调用云服务

## 已知限制

- 强依赖 DSH 桌面版，且 DSH 端口会变化（已做自动发现，但仍可能有延迟）
- 没有端到端加密：局域网内传输是明文 HTTP（需要的话自行套 TLS）
- 多人/多房间未实现，定位是"两个人一间房"
- 安卓/桌面打包脚本不在本仓库内，只提供壳的示例

## 贡献

欢迎 Issue / PR。提交前请确认没有把 `data/`、令牌、API key、私人聊天记录带进 diff。

## License

[MIT](LICENSE)

## 免责声明

本项目与腾讯、DeepSeek 官方均无隶属关系。"DeepSeek Harness" 是其各自权利人的商标/产品。
使用本项目时请遵守你所在地区的法律法规，以及你所使用模型服务的条款。

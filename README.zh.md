[English](README.md) · [简体中文](README.zh.md)

# dsh-plugin-subscription-oauth

**用你已付费的 AI 订阅作为 DeepSeek Harness 的模型提供方 —— 无需 API Key。**

在 **设置 → 订阅** 里对每个服务登录一次，其模型即进入会话模型选择器，并在连接旁实时显示套餐额度。令牌只保存在本机，所有请求都通过服务自己的 API 发起。

[![npm](https://img.shields.io/npm/v/dsh-plugin-subscription-oauth.svg)](https://www.npmjs.com/package/dsh-plugin-subscription-oauth)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

## 支持的服务

| 服务 | 可用模型 | 登录方式 |
| --- | --- | --- |
| **Kimi Code** | `kimi-for-coding`、`k3`（1M）、`k3-256k` —— 直接来自端点自己的模型列表 | OAuth 设备流（显示代码，浏览器确认） |
| **Grok (X Premium)** | 账号自己的模型列表所报告的一切（如 `grok-4.7`），**⚡ lightspeed** 快速变体 | 浏览器 OAuth（自动回调） |
| **Google Antigravity** | Claude Sonnet/Opus、Gemini Flash、GPT-OSS，带推理档 —— 来自账号自己的列表 | Google 账号 OAuth |
| **GLM (BigModel)** | 编码主机列出的一切（如 `glm-5.3`、`glm-5.3-flash`） | ZCode 浏览器登录（轮询） |
| **Volcengine Ark** | 套餐自己的编程模型 | 火山引擎 SSO |
| **Xiaomi MiMo** | MiMo 自己的模型列表，读取失败时回退到应用内置的两个模型 | 小米账号（扫码 / 密码） |
| **WorkBuddy (国内版)** | Hy、GLM、Kimi、DeepSeek、MiniMax 模型 | 浏览器 OAuth（腾讯） |

每个服务也会汇入 **`auto`** 路由，它横跨全部：选 `auto`，harness 会按顺序尝试你已启用的模型，直到有响应。

## 功能

- **每个服务登录一次** —— 无需找、贴、轮换 API Key。插件运行服务自己的 OAuth/设备流，令牌保存在磁盘（`~/.dsh/plugins/kimi-oauth/auth.json`，权限 `0600`）。
- **实时套餐额度** —— 设置卡片和输入框 chip 显示每个账号的剩余额度（Kimi 的 5 小时 / 每周窗口 + 额度，Grok 每周额度，Antigravity 的 Gemini + Claude 分组，GLM/Ark/MiMo/WorkBuddy 的额度），带进度条和重置时间。
- **模型选择器集成** —— 每个服务的模型带上下文窗口和推理档出现在选择器里；可按服务隐藏或排序。
- **模型目录来自服务本身，而不是本插件** —— 每个路由只读取一次服务自己的模型列表，并把它缓存为该路由的目录，因此服务端新增、改名或下线的模型无需插件更新即可出现（或消失）。重新读取的时机是登录成功和设置页的**刷新模型**；浏览选择器不会发出任何请求。
- **⚡ 快速 / lightspeed 变体** —— 对有快速变体的模型（如 Grok 4.7 → `grok-4.7-build-fast`），模型选择器旁的闪电按钮一键切换；它作为推理档实现，基础模型始终可选。
- **多账号池** —— 一个服务可登录多个账号；某账号额度用尽时自动切到下一个。
- **Auto 回退** —— `auto` 在首选模型被拒（改名、限流、额度尽）时改用下一个已启用模型，且流开始后不再回退。

## 安装

```sh
dsh plugin --profile web add dsh-plugin-subscription-oauth
```

然后重启 DeepSeek Harness，打开 **设置 → 订阅**。

安装指定版本，或直接从仓库安装：

```sh
dsh plugin --profile web add dsh-plugin-subscription-oauth@0.10.2
dsh plugin --profile web add github:EricFL1998/dsh-subscription-oauth
```

## 怎么用

1. **打开 设置 → 订阅。** 每个服务一张卡片；已登录的排在前面，`auto` 在最前。
2. **连接** 某个服务。会弹出浏览器窗口（或设备代码）开始该服务自己的登录。在那里完成即可 —— 卡片会自动更新。
3. **选模型。** 该服务的模型现在出现在输入框模型选择器里，chip 显示实时额度。
4. **展开卡片** 管理账号（设默认、退出、刷新令牌）、开关哪些模型显示、排序、手动添加本版本不认识的模型 id、查看凭证文件 / 端点。

> **提示：** 想换某个服务的账号，先退出登录，再重新连接 —— 浏览器登录跟随的是该服务页面当前登录的账号。

## 它注册了什么

| 界面 | 出现内容 |
| --- | --- |
| `ctx.llm` | `kimi`、`grok`、`antigravity`、`glm`、`ark`、`mimo`、`workbuddy` 和 `auto` 路由（模型、推理、流式） |
| 设置 | **订阅** 区块：每个服务一张卡片 |
| 模型选择器 | 每个服务自己的模型，外加横跨全部的 **`auto`** |
| 输入框 chip | 当前服务的实时套餐额度 |

## 隐藏某个服务

想让某个服务的模型不进选择器但又不卸载，在 profile 的 `cordis.patch.yml` 里把它从路由列表去掉即可：

```yml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
plugins:
  dsh-plugin-subscription-oauth:
    providers: [kimi, grok, antigravity, glm, ark, mimo, workbuddy]
```

去掉不想要的即可。默认为全部已实现的路由。

## 安全

- 凭证保存在本机 `~/.dsh/plugins/kimi-oauth/auth.json`（权限 `0600`，原子写入），每个服务一段。
- 插件只连接各服务自己的域名和 OAuth 端点 —— 无遥测，无第三方中转。
- 仅你自己的订阅；不在机器间共享任何内容。

## 开发

完整的 wire 协议、令牌生命周期、故障排查和测试方法见 [开发者 README](README.dev.md)。

## License

[MIT](LICENSE)

[English](README.md) · [简体中文](README.zh.md)

# dsh-plugin-subscription-oauth

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/EricFL1998/dsh-subscription-oauth)
[![npm](https://img.shields.io/npm/v/dsh-plugin-subscription-oauth.svg)](https://www.npmjs.com/package/dsh-plugin-subscription-oauth)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

**把你已经付费的 AI 订阅当作 DeepSeek Harness 中的 LLM 提供方使用——无需 API
密钥。** 每个提供方只需在 **Settings → Subscriptions**（订阅）中登录一次，该账户的
模型就会加入会话的模型选择器，其套餐配额显示在连接旁边。

```sh
dsh plugin --profile web add dsh-plugin-subscription-oauth
```

同一个包也可以直接从仓库安装，这不需要 registry：

```sh
dsh plugin --profile web add github:EricFL1998/dsh-subscription-oauth
```

| | |
| --- | --- |
| **能力** | 模型与推理 / Model & inference — 它注册 LLM 提供方路由 |
| **许可证** | [MIT](LICENSE) |
| **适用版本** | DeepSeek Harness `0.2.0-rc.2`（`@deepseek-ai/dsh-llm`），Node ≥ 20 |
| **平台** | Windows、macOS 和 Linux；除 Node 本身外没有任何平台特定内容 |
| **账户** | 仅限你自己的订阅——凭证留在你的机器上 |
| **网络** | 提供方自己的主机以及下面列出的 OAuth 端点；没有遥测，没有第三方中转 |

| 路由 | 提供方 | 登录 | 传输 |
| --- | --- | --- | --- |
| `kimi` | Kimi Code | OAuth **设备流**（RFC 8628） | OpenAI **Responses** — `https://api.kimi.com/coding/v1/responses` |
| `grok` | Grok (X Premium) | OIDC **授权码 + PKCE**，回调走回环地址 | OpenAI **Responses** — `https://api.x.ai/v1/responses` |
| `antigravity` | Google Antigravity | Google **授权码 + PKCE**（`/oauth-callback`），外加 Cloud AI Companion 项目发现 | Cloud Code Assist `v1internal` — `streamGenerateContent?alt=sse` |
| `glm` | GLM (BigModel) | ZCode 的**浏览器登录加轮询流程**（中国区） | OpenAI **Responses** — `https://open.bigmodel.cn/api/coding/paas/v4/responses` |
| `ark` | 火山方舟 | 火山引擎 **SSO**（授权码 + PKCE，回调走回环地址） | OpenAI **Responses** — `https://ark.cn-beijing.volces.com/api/coding/v3/responses` |
| `auto` | Auto | 无——它自己不持有任何账户 | 委托给它所选模型所属的那条路由 |

Kimi 的设备流就是 `opencodex` 所用的那一个；Grok 的流程是它的 CLI 所用的那一个
（`auth.x.ai` 发现、客户端 `b1a00492-…`、端口 `56121`、scope `grok-cli:access`）；
Antigravity 的流程是 Google 的桌面 OAuth 客户端（`accounts.google.com`、端口
`51121`，scope 包括 `cclog` 和 `experimentsandconfigs`），账户的项目通过
`loadCodeAssist` 发现。

**GLM 采用 ZCode 的登录方式**，而不是用 API 密钥：插件向 `zcode.z.ai` 请求一个登录
流程，在浏览器中打开 `bigmodel.cn/login`，并轮询该流程直到订阅的令牌返回。不需要
任何东西接收 `zcode://oauth/callback` 重定向，也不涉及应用 secret，因为回调是在
服务端完成的，而该流程由插件自己生成的一个 secret 进行认证。额度读取自 BigModel
自己的 `/api/monitor/usage/quota/limit`，它计量一个滚动的五小时窗口和一个每周窗口。

## 它注册了什么

| 层面 | 出现的内容 |
| --- | --- |
| `ctx.llm` | `kimi`、`grok`、`antigravity`、`glm` 和 `auto` 提供方路由（模型、推理强度、流式输出） |
| Settings | 一个 **Subscriptions** 区域：每个提供方一张卡片——登录、退出登录、默认账户、令牌刷新、套餐配额、模型目录、管理对话框 |
| 模型选择器 | 每个提供方自己的模型，外加**作为独立路由的 `auto`**，横跨它们。成员资格来自提供方自己的模型列表：每个路由只读取一次并缓存为该路由的目录（`~/.dsh/plugins/kimi-oauth/model-catalog.json`），因此选择器不会发出请求，服务端新增或下线模型也无需插件更新。Kimi 提供 `kimi-for-coding`、`k3`（1M）与 `k3-256k`；Grok 在 `grok-4.6`、`grok-4.5` 之上加入其实时目录所报告的任何模型；Antigravity 列出其端点所报告内容（`fetchAvailableModels`）中可供 agent 调用的子集，过滤掉 tabs、commit-message 和 transcription 相关层面；GLM 在 `glm-5.3` 系列之上加入其编码主机所列出的一切 |

凭证存放在 `~/.dsh/plugins/kimi-oauth/auth.json`（模式 `0600`，原子写入，每个提供方
一个区段）。该目录保留了本插件在只服务 Kimi Code 时所用的名称：它保存着**活跃的
登录信息**，所以保持原样而不改名，每个挂载过早期版本的 profile 都能在它当初留下的
位置找到自己的账户。本机的 Kimi 设备 id 存放在它旁边的 `kimi-device-id` 中；它在
重启之间保持稳定，因为服务会把用量与之关联。

### 令牌有效期，以及卡片为什么可能显示 "expired"

Kimi Code 的访问令牌有效期为 **15 分钟**；刷新令牌有效期为 **30 天**。Grok 的访问
令牌类似。每当访问令牌距离失效不足五分钟时，每个请求都会自动刷新，而 Settings 卡片
会在你查看它时主动刷新——所以它显示的是实时到期时间，只有在刷新确实失败、账户需要
重新登录时才会出现 "token expired"。访问令牌到期是正常的，并不意味着登录已经失效。

## 设置页面

| 所有路由折叠时 | 一张订阅卡片展开时 | 一张卡片连同其目录 |
| --- | --- | --- |
| ![折叠的提供方列表](docs/images/providers-folded.png) | ![带套餐配额的 GLM 卡片](docs/images/glm-card-open.png) | ![带目录的 Kimi 卡片](docs/images/kimi-card-open.png) |

页面以 **`auto`** 开头，它是同时触达其他所有路由的方式；它所代表的路由按配置顺序
依次排列。每条路由是一个**折叠行**——状态圆点、名称、路由键、一行连接摘要，以及一个
**Edit** 按钮——因此该区域读起来就是一份提供方列表，并按需展开其中一个。**每次访问
都从折叠状态开始**——展开的卡片是一次访问中的一个动作，而不是一个被保存的设置——所以
重新打开 Settings 总是看到同样紧凑的列表。展开的卡片内部是账户行（★ 设置默认账户，
`退出登录`/`Sign out` 移除一个）、模型目录和套餐配额。控件沿用宿主自己的设置表单语汇
——6 px 圆角（`--dsw-radius-sm`）、透明填充、细边框，以及主题的 hover/active/focus
token——它们在一个作用域样式表中声明，因此页面保持那种外观，而不会退回到浏览器的
默认按钮样式。

**Models** 标题本身是一个独立折叠项，**每次访问都折叠**：点击它可打开目录。
**每个模型都有自己的开关**（一个 toggle，而不是 checkbox），它决定会话的模型选择器
是否提供该模型。该选择以隐藏列表的形式存储在宿主上
（`~/.dsh/plugins/kimi-oauth/preferences.json`），因此它能跨重启保留，并且每个会话都
能看到它；后来某次目录刷新新增的模型会自动出现，而不是以隐藏状态出现。被隐藏的模型
以变暗的方式列出，并且仍然**可解析**——已经选中它的现有会话继续正常工作——所以隐藏
是选择器可见性上的选择，而不是撤销。标题中的 `· 已隐藏 N 个` 统计被隐藏的数量。

**Add model** 会发布一个本构建从未听说过的 id，因此插件构建之后发布的模型可以立即
使用。该 id 只检查形态，不比对列表——端点才是它所提供内容的唯一权威——并且它按路由
存储，以保守的元数据发布，并在列表中带一个 `×`，以便打错的条目可以再次移除。**拖动
一行**可通过它的 ⠿ 抓手（或在抓手获得焦点时按 ↑ / ↓）来重新排序列表；该顺序就是选择
器对该路由所遵循的顺序。

**`auto` 是一个自成一路的提供方**（路由 `auto`），而不是每个提供方内部的某个模型：
它在一个列表中代表 harness 所服务的*每一个*提供方的已启用模型，每一行都带有拥有它的
提供方徽标。这既包括本插件注册的路由，**也**包括它没有注册的路由——内置的 DeepSeek
提供方以及你自己添加的任何提供方——因为它枚举 harness 名册
（`ctx.llm.listProviders()` / `listModels()`）并通过它分发，而不是只查看自己的路由。
它同时位于 Settings 区域和模型选择器的首位，因为它是唯一能触达每条路由的条目。它没有
账户，所以它的卡片不提供连接或管理——只有列表。一个开关可以把某个模型移出 Auto
而**不**把它从选择器中隐藏，拖动会重排 Auto 首先尝试的顺序，这些安排单独存储
（`auto.order` / `auto.off`）。把每个模型都关掉，Auto 就根本不会在选择器中出现。

没有已登录账户的提供方不贡献任何行：在某条路由拥有会话之前，`listModels` 什么也不
返回，因此退出登录会同时把该路由的模型从选择器和 Auto 中移除，其卡片会隐藏目录，而
不是提供无法调用的模型。

当提供方拒绝首选模型时（被重命名或已消失、被限流、额度耗尽，或传输失败），Auto 会
落到下一个模型。具体的模型 id 从不回退——它会分派到正是那个模型。一旦某个流已经产生
任何输出，这一轮就属于那个模型，所以之后的失败会被报告出来，而不是被第二个模型的文本
掩盖过去。每次回退都会记录日志（`model X unavailable … falling back to Y`）。

**Plan and usage** 显示订阅层级以及提供方声明的每一项额度，并带有计量条和重置时间：
Kimi 的滚动 5 小时窗口、每周窗口和包含额度（`GET /coding/v1/usages`）；Grok 的每周
包含额度（`cli-chat-proxy.grok.com/v1/billing?format=credits`，外加来自令牌自身
`tier` 声明的套餐层级）；以及 Antigravity 的**四个**桶——Gemini 和 Claude，各含滚动
与每周——读取自 `v1internal:retrieveUserQuotaSummary`，回退到 `fetchAvailableModels`
的按模型 `quotaInfo`（每个家族中消耗最多的模型，按 id、显示名称和层级分类，因此一行
`Opus` 会被算作 Claude）。什么都不声明的提供方会如实说明，而不是编造一个数字。

每条路由都以距离重置还有多远来表述重置：一小时以内用**分钟**（`40 分钟后重置`），
一天以内用**小时**（`4 小时后重置`），再远则用日期（`重置时间 2026/10/17 13:54`）
——读者在判断是否还有余量时依据的是这个计数，而当重置在一周之后时他们需要的是日期。
由于页面以较慢的间隔重新读取这些数字，只要页面打开着，计数就会跟着更新。

**Manage** 打开一个对话框，其中有按账户的令牌刷新、凭证文件路径，以及解析后的端点。

当设备授权处于待处理状态时，卡片会显示代码、其到期时间，以及打开或复制它的按钮，
并且状态圆点变为琥珀色。回环类提供方（Grok）则显示一个登录链接，并等待浏览器重定向。

## 安装

```sh
dsh plugin --profile web add dsh-plugin-subscription-oauth
```

`web` 是提供 Settings 页面的 profile；如果你运行的是 `desktop`（或任何其他 profile
名称），就改用那一个。

CLI 会把它的参数转发给 pnpm，因此固定版本、git URL 和本地路径的写法都一样：

```sh
dsh plugin --profile web add dsh-plugin-subscription-oauth@0.2.2
dsh plugin --profile web add github:EricFL1998/dsh-subscription-oauth
dsh plugin --profile web add /path/to/dsh-plugin-subscription-oauth
```

之后重启 `dsh web`（或桌面应用），以便加载新的 bundle。本地目录以 `link:` 方式安装，
因此之后在检出目录中执行 `npm run build` 就足以发布一项改动；再次重启即可生效。

宿主包（`@deepseek-ai/dsh-llm` 及其余的包）是**可选** peer：harness 在运行时提供
它们，因此安装本插件不会获取它正运行于其中的宿主的第二份副本。

### 发布（维护者）

`prepublishOnly` 会重新构建 `lib/`——TypeScript 输出加上浏览器 bundle——因此发布的
tarball 绝不会带有过期的客户端：

```sh
npm version patch   # or minor/major
npm publish
```

对于只需要模型路由（不需要 Settings 页面）的无头组合：

```sh
dsh --profile headless --patch /path/to/dsh-plugin-subscription-oauth/overlay.yml "your task"
```

其中 `overlay.yml` 是一个单条目补丁，指向
`/path/to/dsh-plugin-subscription-oauth/lib/index.js`。先从 web profile 登录一次
——令牌文件是共享的。

## 从选择器中隐藏内置提供方

插件无法注销另一个 bundle 的路由（`ctx.llm` 没有注销 API），因此隐藏内置提供方是一项
profile 补丁改动。要隐藏 **DeepSeek API-key** 路由及其模型，同时保留 **DeepSeek
account**（登录）路由：

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    models: []
```

`models` 会替换适配器的默认目录，因此 `deepseek-official` 报告没有模型，选择器会
隐藏这个空组（`Empty groups are hidden`）；该路由仍保持注册，所以已经保存了其某个
模型 id 的会话继续正常工作。不要动 `llm-deepseek-account`，以保留账户路由。重启该
profile（或让 HMR 重新加载）以使改动生效。

## 使用

1. 打开 **Settings → Subscriptions**（订阅），在你想要的卡片上按 **Connect**。
2. 完成卡片显示的登录：Kimi Code 以及（在被应答时）一个你在浏览器中批准的设备码；
   Grok 和 Antigravity 会打开一个登录页面并等待重定向。当一次尝试处于待处理状态时，
   该区域会自行更新。
3. 在任意会话中打开模型选择器，并选择该提供方下的一个模型——或者让它保持在
   **Auto**，让已启用的模型按顺序被尝试。

未登录？该提供方不会出现在选择器中，请求会以 `INVALID_CREDENTIAL` 失败并指向
Settings 页面。其他一切都不受影响。

支持多个账户：再次连接即可添加另一个。★ 默认账户服务请求；使用
**Use by default** 来切换。

## 配置

```yaml
- id: llm-subscription-oauth
  name: dsh-plugin-subscription-oauth
  config:
    providers: [kimi, grok, antigravity]  # routes to register; all are default
    enabled: true
    discovery: true                  # consult each endpoint's live model list
    streamIdleTimeoutMs: 300000      # abandon a silent stream after this
    defaultModel: kimi-for-coding    # model the picker preselects on the Kimi route
    extraModels: []                  # Kimi ids to publish without shipped metadata
    # oauthHost: https://auth.kimi.com
    # apiBase: https://api.kimi.com/coding/v1
```

只有 Kimi 路由接受 `oauthHost`/`apiBase`/`defaultModel`/`extraModels`：Grok 和
Antigravity 的端点由它们自己的客户端固定，其模型列表来自实时目录。从 `providers`
中省略某条路由，只是让它保持未注册。

`oauthHost` 和 `apiBase` 也可以来自环境变量（`KIMI_CODE_OAUTH_HOST` /
`KIMI_OAUTH_HOST`、`KIMI_CODE_API_BASE` / `KIMI_API_BASE`）；显式的配置值优先。
`apiBase` 既接受裸 base，也接受完整的 `.../responses` URL。

## 工作原理

该包是一个标准的 DeepSeek Harness 插件：`lib/index.js` 导出 `apply(ctx)`，它为每条
路由注册一个 `ctx.llm` 适配器，并通过 `ctx.slots` 挂载 Settings 区域。
`lib/client.js` 是浏览器那一半——即该区域本身，由 harness 的 bundle 加载器加载。
harness 进程之外没有任何东西在运行，卸载该 bundle 会移除它添加的每一条路由。

**登录**是针对 `auth.kimi.com` 的 RFC 8628 设备授权授予。插件请求一个设备码，显示
它，并以 `authorization_pending` / `slow_down` / `access_denied` / `expired_token`
处理方式轮询令牌端点，直到浏览器批准。令牌按账户存储，以 Kimi 的 JWT 内部的
`user_id`（或 `sub`）声明为键。

**Grok** 用它自己的 CLI 所用的流程登录：在 `auth.x.ai` 进行 OIDC 发现，在回环回调
（`127.0.0.1:56121/callback`）上进行带 PKCE 的授权码交换，以及一个保持客户端身份的
刷新授予。**Antigravity** 是 Google 的桌面 OAuth 客户端，位于 `127.0.0.1:51121`，
其 scope 包括 `cloud-platform`；只有当 `loadCodeAssist` 报告该账户的 Cloud AI
Companion 项目后，登录才算完成，因为之后每次 `v1internal` 调用都以它为作用域。

**请求**携带三层身份：

* bearer 访问令牌，在到期前刷新（提前 5 分钟），每个账户共享一个进行中的刷新；
* Kimi 的 `X-Msh-*` 客户端身份（`KimiCLI/<version>`、平台、设备 id）——服务按这个
  家族接纳请求；
* harness 的归属标识。由于 Kimi 按 CLI 产品令牌接纳请求，而 harness 要求在每个
  提供方请求上带有它自己的归属标识，两者被合并为一个 RFC 9110 `User-Agent` 值，
  而不是作为两个互相竞争的头字段发送。

**传输**采用 OpenAI Responses：`instructions` + `input` 条目，`function_call` /
`function_call_output` 保持相邻（端点要求如此），`stream: true`、`store: false`，
`prompt_cache_key` 取自会话 id 以获得缓存亲和性，`reasoning.effort` 由 harness 的
effort id 映射而来。已存储的推理绝不作为文本重放——端点会在服务端保留订阅账户的
思考内容并加密，因此每一轮都立足于它自己可见的内容。

Kimi 在订阅编码模型上锁定温度和采样惩罚，因此调用方提供的 `temperature` 会被丢弃，
而不是在上游被拒绝。

## 故障排除

| 症状 | 原因 |
| --- | --- |
| `<provider> login expired; sign in again…` | 刷新令牌被拒绝；再次连接 |
| 选择器中没有模型 | 未登录，或该路由没有被重新宣告——检查 **Settings → Subscriptions** |
| Antigravity 完全没有模型 | 该账户的 `fetchAvailableModels` 什么也没返回；该路由不附带精选列表，所以登录后按 **Refresh** |
| `model not found` | 该 id 不在你的套餐所提供的范围内；使用 **Refresh** |
| 代码卡片一直不消失 | 该尝试仍在待处理或已过期；按 **Cancel** 并再次连接 |
| `model discovery failed … using the built-in catalog` | 实时列表无法访问；随附的目录仍然可用（Kimi 和 Grok 附带一个，Antigravity 没有） |
| 行无法拖动 | 该布局在 Settings 中被关闭，或拖动是从 checkbox 上开始的——抓住 ⠿ 抓手 |

## 安全说明

### 它存储什么，以及存在哪里

| 路径 | 内容 | 模式 |
| --- | --- | --- |
| `~/.dsh/plugins/kimi-oauth/auth.json` | 每个提供方一个区段：访问令牌、刷新令牌、到期时间、账户 id、套餐 | `0600`，原子写入 |
| `~/.dsh/plugins/kimi-oauth/preferences.json` | 模型可见性、你的排序，以及 Auto 的链——没有秘密 | `0600` |
| `~/.dsh/plugins/kimi-oauth/kimi-device-id` | Kimi 的 API 所期望的稳定设备 id | `0600` |

该目录保留了本插件在只服务 Kimi Code 时所用的名称：它保存着**活跃的登录信息**，
所以改名会让所有人退出登录。`~/.dsh` 之外不存储任何东西，除提供方自身之外也不向
任何地方上传任何东西。

### 它与什么通信

| 路由 | 联系的主机 | 原因 |
| --- | --- | --- |
| `kimi` | `auth.kimi.com`、`api.kimi.com` | 设备流登录，然后是编码 API |
| `grok` | `auth.x.ai`、`api.x.ai`、`cli-chat-proxy.grok.com` | OIDC 登录、Responses API、套餐的额度数字 |
| `antigravity` | `accounts.google.com`、`oauth2.googleapis.com`、`cloudcode-pa.googleapis.com` | Google 登录、账户的项目，然后是 Cloud Code Assist（包括其配额核算） |
| `glm` | `bigmodel.cn`、`zcode.z.ai`、`open.bigmodel.cn` | 由 ZCode 中介的浏览器登录，然后是编码套餐 API 及其额度 |
| `ark` | `signin.volcengine.com`、`ark.cn-beijing.volces.com`、`ark.cn-beijing.volcengineapi.com` | 火山引擎 SSO，然后是编码套餐 API（数据面）与签名的控制面——后者用于铸造 API Key 并读取额度 |

没有分析、没有更新 ping，也不经由任何其他人的服务器中转：每个请求都发往拥有该账户
的主机。任何请求体、提示词或令牌都不会被记录到日志。

### 值得了解的边界

* 令牌文件以模式 `0600` 写入；UI 中只显示账户 id、邮箱、主机和设备 id——绝不显示
  令牌。
* Kimi 和 GLM 的流程完全不需要在本机上监听：Kimi 采用轮询，而 GLM 的浏览器回调由
  提供方在服务端完成。Grok 和 Antigravity **仅**在一次登录尝试处于待处理状态时持有
  一个回环监听器，位于 `127.0.0.1:56121` 和 `127.0.0.1:51121`，并且一旦该尝试结束
  或失效就会关闭。回环目的地绝不经过代理。
* 出站请求遵循 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 和 `NO_PROXY`。
* 登录是授权本机使用该账户——提供方自己的同意页面就是同意步骤，它绝不会替你完成。
* 插件无法注销另一个 bundle 的提供方（`ctx.llm` 没有注销 API），因此本插件绝不隐藏
  你原本就有的任何东西；如果那正是你想要的，请参见
  [从选择器中隐藏内置提供方](#从选择器中隐藏内置提供方)。
* **已知限制**：按设计不支持 OpenAI 兼容的 API 密钥（这是一个订阅类插件）；GLM 的
  流程没有刷新授予，因此失效的登录会要求你重新登录，而不是静默续期；Antigravity
  不附带精选模型列表，并且依赖其端点作出应答。

## 开发

```sh
npm install        # development baseline: published DSH 0.2.0-rc.2 packages
npm run build      # tsc (lib/) + tsdown (lib/client.js browser bundle)
npm test           # node --test over the compiled unit specs
npm run typecheck  # tsc --noEmit
```

`tools/probe-kimi-oauth.mjs` 执行一次实时检查，确认 Kimi 接受随附的客户端 id 和身份
头；它会启动一次设备授权并立即放弃，因此不会触碰任何账户（先执行
`npm run build`）。

### 在没有宿主的情况下审阅设置 UI

`tools/preview-entry.tsx` 用一个打桩的 RPC 调用方挂载真实的区域，因此一项设计改动
可以单独截图。查询标志驱动各种状态：`?dark=1`、`?grok=1`、`?ag=1`、`?busy=1`、
`?hide=1`、`?collapse=1`、`?manage=1`。

```sh
npm run preview                                 # bundles probe/preview.js
# then open probe/preview.html in a browser, or screenshot it headlessly:
msedge --headless=new --user-data-dir=%TEMP%\shot --window-size=620,1900 \
  --screenshot=shot.png "file:///<checkout>/probe/preview.html?dark=1&grok=1&ag=1"
```

harness 有意不为自己的任何 `button` 设置样式：外壳通过一个插件标记不携带的 CSS 类
为其控件提供外观，因此一个会装饰裸按钮的预览恰恰会掩盖这个页面曾有的那个回归。

查询标志：`dark=1`（深色主题）、`compact=1`（模型列表折叠）、`busy=1`（设备授权
待处理）、`manage=1`（管理对话框打开）。`probe/` 只保存生成的预览输出，并且被
gitignore；提交的截图位于 `docs/images/`。

在 `npm run build` 之后，重启 `dsh web` 以应用改动。

## License

MIT

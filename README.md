[English](README.md) · [简体中文](README.zh.md)

# dsh-plugin-subscription-oauth

**Use the AI subscriptions you already pay for as LLM providers in DeepSeek Harness — no API key.**

Sign in once per provider from **Settings → Subscriptions** and that provider's models join the session model picker, with its plan quota shown live next to the connection. Tokens stay on your machine; every request streams through the provider's own API.

[![npm](https://img.shields.io/npm/v/dsh-plugin-subscription-oauth.svg)](https://www.npmjs.com/package/dsh-plugin-subscription-oauth)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

## Supported providers

| Provider | What you get | Sign-in |
| --- | --- | --- |
| **Kimi Code** | `kimi-for-coding`, `k3`, `k3[1m]`, `k3-256k` + live catalog | OAuth device flow (show code, confirm in browser) |
| **Grok (X Premium)** | `grok-4.7`, `grok-4.6`, … + live catalog, **⚡ lightspeed** fast variant | Browser OAuth (auto-redirect) |
| **Google Antigravity** | Claude Sonnet/Opus, Gemini Flash, GPT-OSS, with reasoning tiers | Google account OAuth |
| **GLM (BigModel)** | `glm-5.3`, `glm-5.3-flash`, `glm-5.2`, `glm-5.1`, `glm-5` | ZCode browser sign-in (polled) |
| **Volcengine Ark** | Ark coding models + live catalog | Volcengine SSO |
| **Xiaomi MiMo** | MiMo Pro, MiMo Flash | Xiaomi account (QR / password) |
| **WorkBuddy (国内版)** | Hy, GLM, Kimi, DeepSeek, MiniMax models | Browser OAuth (Tencent) |

Every provider also feeds the **`auto`** route, which spans them all: pick `auto` and the harness walks your enabled models in order until one answers.

## Features

- **One sign-in per provider** — no API keys to find, paste, or rotate. The plugin runs the provider's own OAuth/device flow and keeps the token on disk (`~/.dsh/plugins/kimi-oauth/auth.json`, mode `0600`).
- **Live plan usage** — the Settings card and the composer chip show each account's remaining quota (Kimi's 5-hour / weekly windows + credit, Grok's weekly credit, Antigravity's Gemini + Claude buckets, GLM/Ark/MiMo/WorkBuddy credits), with a meter and reset time.
- **Model picker integration** — each provider's models appear in the session picker with context windows and reasoning tiers; hide or re-order them per provider.
- **⚡ Fast / lightspeed variants** — for models that have one (e.g. Grok 4.7 → `grok-4.7-build-fast`), a bolt button beside the model selector switches to the fast variant; it reads as a reasoning rung so the base model always stays selectable.
- **Cross-account pool** — sign in to several accounts on one provider; the plugin draws on the next account when one's allowance runs out.
- **Auto fallback** — `auto` moves to the next enabled model when a provider refuses the preferred one (renamed, rate-limited, out of quota), and stops falling back once a stream has started.

## Install

```sh
dsh plugin --profile web add dsh-plugin-subscription-oauth
```

Then restart DeepSeek Harness and open **Settings → Subscriptions** (订阅).

To install a specific version, or straight from the repository:

```sh
dsh plugin --profile web add dsh-plugin-subscription-oauth@0.10.2
dsh plugin --profile web add github:EricFL1998/dsh-subscription-oauth
```

## How to use

1. **Open Settings → Subscriptions.** You see one card per provider; signed-in providers sort to the front, `auto` leads.
2. **Connect** a provider. A browser window (or a device code) starts the provider's own sign-in. Finish it there — the card updates by itself.
3. **Pick a model.** The provider's models now appear in the composer model picker, and the chip shows live usage.
4. **Expand a card** to manage accounts (set default, sign out, refresh token), toggle which models appear, re-order them, add a model id this build doesn't know yet, and see the credential file / endpoints.

> **Tip:** to use a different account on a provider, sign out first, then connect again — the browser sign-in follows whichever account the provider's page is signed in with.

## What it registers

| Surface | What appears |
| --- | --- |
| `ctx.llm` | the `kimi`, `grok`, `antigravity`, `glm`, `ark`, `mimo`, `workbuddy` and `auto` provider routes (models, reasoning, streaming) |
| Settings | a **Subscriptions** section: one card per provider |
| Model picker | each provider's own models, plus **`auto`** spanning them all |
| Composer chip | live plan usage for the provider in force |

## Hiding a provider

To keep a provider's models out of the picker without uninstalling, drop it from the route list in your profile's `cordis.patch.yml`:

```yml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
plugins:
  dsh-plugin-subscription-oauth:
    providers: [kimi, grok, antigravity, glm, ark, mimo, workbuddy]
```

Omit the ones you don't want. The list defaults to every implemented route.

## Security

- Credentials are stored locally at `~/.dsh/plugins/kimi-oauth/auth.json` (mode `0600`, written atomically), one section per provider.
- The plugin talks only to the providers' own hosts and OAuth endpoints — no telemetry, no third-party relay.
- Your subscriptions only; nothing is shared across machines.

## Develop

See the [developer README](README.dev.md) for the full wire protocol, token lifetimes, troubleshooting, and how to run the test suite.

## License

[MIT](LICENSE)

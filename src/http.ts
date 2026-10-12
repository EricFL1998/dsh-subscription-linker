/**
 * Outbound HTTP for the Kimi routes.
 *
 * The plugin respects the conventional proxy environment variables so a user
 * behind a corporate relay can still reach `auth.kimi.com`. `NO_PROXY` is
 * honoured, and a loopback destination is never proxied.
 *
 * @module dsh-plugin-subscription-oauth/http
 */

import type { Dispatcher } from 'undici'

/** Fetch-compatible callable used across the plugin (injectable for tests). */
export type FetchFn = typeof fetch

/** One cached dispatcher per proxy URL. */
const agents = new Map<string, Dispatcher>()

/** Hosts that always bypass a proxy. */
const ALWAYS_DIRECT = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** Read the first non-empty value among the given environment names. */
function envValue(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]
    if (value !== undefined && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** Whether `host` matches one `NO_PROXY` entry (exact host or dotted suffix). */
function matchesNoProxy(host: string, noProxy: string): boolean {
  const target = host.toLowerCase()
  for (const raw of noProxy.split(',')) {
    const entry = raw.trim().toLowerCase().replace(/^\./, '')
    if (entry === '') continue
    if (entry === '*') return true
    if (target === entry || target.endsWith(`.${entry}`)) return true
  }
  return false
}

/** Proxy URL that applies to `url`, or undefined for a direct connection. */
function proxyFor(url: URL, env: NodeJS.ProcessEnv): string | undefined {
  const host = url.hostname.toLowerCase()
  if (ALWAYS_DIRECT.has(host)) return undefined
  const noProxy = envValue(env, 'NO_PROXY', 'no_proxy')
  if (noProxy !== undefined && matchesNoProxy(host, noProxy)) return undefined
  if (url.protocol === 'https:') return envValue(env, 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy')
  return envValue(env, 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy')
}

/** Lazily create (and cache) the dispatcher for one proxy URL. */
async function dispatcherFor(proxyUrl: string): Promise<Dispatcher> {
  const cached = agents.get(proxyUrl)
  if (cached !== undefined) return cached
  const { ProxyAgent } = await import('undici')
  const agent = new ProxyAgent(proxyUrl)
  agents.set(proxyUrl, agent)
  return agent
}

/** The absolute URL of a fetch input, or undefined when it cannot be parsed. */
function requestUrl(input: RequestInfo | URL): URL | undefined {
  try {
    if (input instanceof URL) return input
    if (typeof input === 'string') return new URL(input)
    return new URL(input.url)
  } catch {
    return undefined
  }
}

/**
 * Fetch an absolute URL, honouring the proxy environment.
 *
 * Falls back to a direct request when no proxy applies or when the dispatcher
 * cannot be constructed, so a malformed proxy setting degrades to a direct
 * attempt instead of breaking every call.
 *
 * @param input - absolute request URL (a `Request` is inspected for its URL).
 * @param init - standard request options.
 * @param env - environment to read proxy settings from.
 * @returns the response.
 */
export async function proxiedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  const url = requestUrl(input)
  if (url === undefined) return fetch(input, init)
  const proxyUrl = proxyFor(url, env)
  if (proxyUrl === undefined) return fetch(input, init)
  try {
    const dispatcher = await dispatcherFor(proxyUrl)
    return await fetch(input, { ...init, dispatcher } as RequestInit)
  } catch {
    return fetch(input, init)
  }
}

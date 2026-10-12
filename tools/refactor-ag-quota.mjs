// One-off: the quota probe must reach Google's own accounting hosts, and the
// per-model fallback must report weekly buckets when it has them.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'src/providers/antigravity.ts'
let text = readFileSync(file, 'utf8')

// 1. `callInternal` accepts an explicit origin list, so a quota probe can try
//    Google's hosts before the configured request base.
const inputFrom = `  input: { fetchFn: FetchFn, baseUrl?: string, userAgent?: string },
  signal?: AbortSignal,
): Promise<T> {
  const origins = input.baseUrl === undefined ? [ANTIGRAVITY_BASE_URL, ANTIGRAVITY_PROD_URL] : [input.baseUrl]`
if (!text.includes(inputFrom)) throw new Error('callInternal origin anchor missing')
text = text.replace(inputFrom, `  input: { fetchFn: FetchFn, baseUrl?: string, userAgent?: string, origins?: readonly string[] },
  signal?: AbortSignal,
): Promise<T> {
  const origins = input.origins
    ?? (input.baseUrl === undefined ? [ANTIGRAVITY_BASE_URL, ANTIGRAVITY_PROD_URL] : [input.baseUrl])`)

// 2. `fetchAntigravityModels` forwards the origin list.
text = text.replace(`  fetchFn: FetchFn
  baseUrl?: string
  userAgent?: string
  signal?: AbortSignal
}): Promise<{ entries: CatalogEntry[], quotas: Map<string, { remainingFraction?: number, resetTime?: string }> }> {`,
`  fetchFn: FetchFn
  baseUrl?: string
  userAgent?: string
  signal?: AbortSignal
  /** Origins to try in order, when the caller must not inherit one request base. */
  origins?: readonly string[]
}): Promise<{ entries: CatalogEntry[], quotas: Map<string, { remainingFraction?: number, resetTime?: string }> }> {`)

// 3. The usage read: Google's accounting first, the configured base last, and the
//    reason it had to fall back reported rather than swallowed.
const usageFrom = `  async usage(accessToken: string, projectId: string, plan?: string) {
    const fetchFn = this.options.fetchFn ?? proxiedFetch
    const runtime = {
      fetchFn,
      ...this.options.baseUrl === undefined ? {} : { baseUrl: this.options.baseUrl },
    }
    // The account summary states both families with a rolling and a weekly bucket;
    // it is the source the service actually meters, so it wins when present.
    try {
      const summary = await callInternal<unknown>('retrieveUserQuotaSummary', { project: projectId }, accessToken, runtime)
      const windows = parseAntigravityQuotaSummary(summary)
      if (windows.length > 0) return { windows, ...plan === undefined ? {} : { plan } }
    } catch (error: unknown) {
      this.options.onWarn?.(\`Antigravity quota summary unavailable (\${errorChain(error)}); falling back to per-model figures\`)
    }
    const { quotas } = await fetchAntigravityModels({
      accessToken,
      projectId,
      fetchFn,
      ...this.options.baseUrl === undefined ? {} : { baseUrl: this.options.baseUrl },
    })
    const source = quotas.size > 0 ? quotas : this.quotas
    const windows = antigravityWindows(source)
    if (windows.length === 0) return undefined
    return { windows, ...plan === undefined ? {} : { plan } }
  }`
if (!text.includes(usageFrom)) throw new Error('usage anchor missing')
text = text.replace(usageFrom, `  async usage(accessToken: string, projectId: string, plan?: string) {
    const fetchFn = this.options.fetchFn ?? proxiedFetch
    // Google's accounting lives on its own hosts. A configured request base is a
    // routing choice for completions — often a proxy — and need not implement
    // \`v1internal:retrieveUserQuotaSummary\`, so the accounting hosts come first and
    // the configured base is the last resort rather than the only attempt.
    const origins = [
      ANTIGRAVITY_BASE_URL,
      ANTIGRAVITY_PROD_URL,
      ...this.options.baseUrl === undefined ? [] : [this.options.baseUrl],
    ]
    const runtime = { fetchFn, origins }
    const { windows, usageError } = await this.readUsage(accessToken, projectId, runtime)
    if (windows.length === 0 && usageError === undefined) return undefined
    return {
      ...windows.length === 0 ? {} : { windows },
      ...plan === undefined ? {} : { plan },
      ...usageError === undefined ? {} : { usageError },
    }
  }

  /**
   * Read the account summary, then the per-model figures.
   *
   * @param accessToken - bearer for the account.
   * @param projectId - the account's project.
   * @param runtime - fetch plus the origins to try.
   * @returns the windows found, and why the summary was unavailable when it was.
   */
  private async readUsage(
    accessToken: string,
    projectId: string,
    runtime: { fetchFn: FetchFn, origins: readonly string[] },
  ): Promise<{ windows: UsageWindow[], usageError?: string }> {
    let summaryError: string | undefined
    try {
      const summary = await callInternal<unknown>(
        'retrieveUserQuotaSummary',
        { project: projectId },
        accessToken,
        runtime,
      )
      const windows = parseAntigravityQuotaSummary(summary)
      // The summary is the authoritative accounting; per-model figures are only a
      // substitute, so they are not merged into a summary that answered.
      if (windows.length > 0) return { windows }
      summaryError = 'the account summary stated no quota bucket'
    } catch (error: unknown) {
      summaryError = errorChain(error)
    }
    try {
      const { quotas } = await fetchAntigravityModels({
        accessToken,
        projectId,
        fetchFn: runtime.fetchFn,
        origins: runtime.origins,
      })
      const source = quotas.size > 0 ? quotas : this.quotas
      return { windows: antigravityWindows(source), usageError: \`per-model figures (\${summaryError})\` }
    } catch (error: unknown) {
      this.options.onWarn?.(\`Antigravity usage unavailable: summary \${summaryError}; models \${errorChain(error)}\`)
      return { windows: this.antigravityWindowsFromCache(), usageError: summaryError }
    }
  }

  /** The windows the last catalog read reported, if any. */
  private antigravityWindowsFromCache(): UsageWindow[] {
    return antigravityWindows(this.quotas)
  }`)

writeFileSync(file, text)
console.log('patched', file)

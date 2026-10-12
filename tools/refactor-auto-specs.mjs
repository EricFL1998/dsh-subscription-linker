// One-off: the per-route `auto` entry moved into its own provider, so the specs
// that still expect it inside each route's catalog are updated here.
import { readFileSync, writeFileSync } from 'node:fs'

/** Apply every replacement, reporting any that did not match. */
function patch(file, pairs) {
  let text = readFileSync(file, 'utf8')
  for (const [from, to] of pairs) {
    if (!text.includes(from)) {
      console.log(`  MISS ${file}: ${from.slice(0, 70)}`)
      continue
    }
    text = text.split(from).join(to)
  }
  writeFileSync(file, text)
  console.log(`patched ${file}`)
}

// ---------------------------------------------------------------------------
// kimi-adapter: no synthetic entry, and no per-route auto chain.
// ---------------------------------------------------------------------------
patch('test/kimi-adapter.spec.ts', [
  ["describe('KimiAdapter auto and model order'", "describe('KimiAdapter model order'"],
  [`  test('lists auto first, then the curated catalog in its own order', async () => {
    const adapter = new KimiAdapter(options())
    assert.deepEqual(
      (await adapter.listModels('kimi')).map((model) => model.id),
      ['auto', 'kimi-for-coding', 'k3', 'k3[1m]', 'k3-256k'],
    )
  })

`, ''],
  [`  test('auto tries the first enabled model the catalog lists', async () => {
    const { fetchFn, body } = recorder()
    const adapter = new KimiAdapter(options({
      fetchFn,
      // The first *enabled* model is what auto starts with.
      hiddenModels: async () => new Set(['kimi-for-coding']),
    }))
    await collect(adapter.stream(request({ model: 'auto' })))
    assert.equal(body().model, 'k3')
  })

`, ''],
  [`  test('auto falls through to the next model when one is unavailable', async () => {
    const seen: string[] = []
    const warnings: string[] = []
    const fetchFn: typeof fetch = async (_input, init) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model
      seen.push(model)
      return model === 'kimi-for-coding'
        ? new Response('rate limited', { status: 429, headers: { 'retry-after': '5' } })
        : sseResponse([{ type: 'response.completed', response: {} }])
    }
    const adapter = new KimiAdapter(options({
      fetchFn,
      onWarn: (message) => warnings.push(message),
    }))
    const chunks = await collect(adapter.stream(request({ model: 'auto' })))
    assert.deepEqual(seen, ['kimi-for-coding', 'k3'])
    assert.equal(chunks.at(-1)?.type, 'finish')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /kimi-for-coding unavailable.*falling back to k3/)
  })

`, ''],
  [`  test('auto skips a model the endpoint no longer serves', async () => {
    const seen: string[] = []
    const fetchFn: typeof fetch = async (_input, init) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model
      seen.push(model)
      return model === 'kimi-for-coding'
        ? new Response('{"error":{"message":"model not found"}}', { status: 404, headers: { 'content-type': 'application/json' } })
        : sseResponse([{ type: 'response.completed', response: {} }])
    }
    const adapter = new KimiAdapter(options({ fetchFn }))
    await collect(adapter.stream(request({ model: 'auto' })))
    assert.deepEqual(seen, ['kimi-for-coding', 'k3'])
  })

`, ''],
  [`  test('a bad request is reported rather than re-sent to another model', async () => {
    const seen: string[] = []
    const fetchFn: typeof fetch = async (_input, init) => {
      seen.push((JSON.parse(String(init?.body)) as { model: string }).model)
      return new Response('{"error":{"message":"invalid input"}}', { status: 400, headers: { 'content-type': 'application/json' } })
    }
    const adapter = new KimiAdapter(options({ fetchFn }))
    await assert.rejects(collect(adapter.stream(request({ model: 'auto' }))), (error: unknown) =>
      error instanceof LlmError && /invalid input/.test(error.message))
    // Only the preferred model was asked, because the request itself was wrong.
    assert.deepEqual(seen, ['kimi-for-coding'])
  })

`, `  test('a bad request is reported, not retried elsewhere', async () => {
    const seen: string[] = []
    const fetchFn: typeof fetch = async (_input, init) => {
      seen.push((JSON.parse(String(init?.body)) as { model: string }).model)
      return new Response('{"error":{"message":"invalid input"}}', { status: 400, headers: { 'content-type': 'application/json' } })
    }
    const adapter = new KimiAdapter(options({ fetchFn }))
    await assert.rejects(collect(adapter.stream(request())), (error: unknown) =>
      error instanceof LlmError && /invalid input/.test(error.message))
    assert.deepEqual(seen, ['kimi-for-coding'])
  })

`],
  [`  test('an empty chain is refused instead of dispatching nowhere', async () => {
    const adapter = new KimiAdapter(options({
      hiddenModels: async () => new Set(['kimi-for-coding', 'k3', 'k3[1m]', 'k3-256k']),
    }))
    await assert.rejects(collect(adapter.stream(request({ model: 'auto' }))), (error: unknown) =>
      error instanceof LlmError)
  })

`, ''],
  [`  test('a concrete model never falls back to another', async () => {
    const seen: string[] = []
    const fetchFn: typeof fetch = async (_input, init) => {
      seen.push((JSON.parse(String(init?.body)) as { model: string }).model)
      return new Response('slow down', { status: 429 })
    }
    const adapter = new KimiAdapter(options({ fetchFn }))
    await assert.rejects(collect(adapter.stream(request({ model: 'k3' }))))
    assert.deepEqual(seen, ['k3'])
  })

`, `  test('a refusal is reported rather than answered by another model', async () => {
    const seen: string[] = []
    const fetchFn: typeof fetch = async (_input, init) => {
      seen.push((JSON.parse(String(init?.body)) as { model: string }).model)
      return new Response('slow down', { status: 429 })
    }
    const adapter = new KimiAdapter(options({ fetchFn }))
    await assert.rejects(collect(adapter.stream(request({ model: 'k3' }))))
    assert.deepEqual(seen, ['k3'])
  })

`],
  [`  test('auto skips hidden models and falls back to a concrete id', async () => {
    const { fetchFn, body } = recorder()
    const adapter = new KimiAdapter(options({
      fetchFn,
      hiddenModels: async () => new Set(['kimi-for-coding']),
    }))
    await collect(adapter.stream(request({ model: 'auto' })))
    assert.equal(body().model, 'k3')
  })

`, ''],
  [`  test('auto reports the metadata of the model it starts with', async () => {
    const adapter = new KimiAdapter(options())
    const resolved = await adapter.resolveModel('kimi', 'auto')
    assert.equal(resolved.id, 'auto')
    assert.equal(resolved.name, 'Auto')
    // The first catalog entry, kimi-for-coding, carries the 1M window.
    assert.equal(resolved.context?.contextWindow, KIMI_LONG_CONTEXT_WINDOW)
    // auto itself is never a wire id.
    assert.equal((await adapter.listModels('kimi'))[0]?.id, 'auto')
  })

`, ''],
  ["      ['auto', 'kimi-for-coding', 'k3', 'k3[1m]', 'k3-256k'],", "      ['kimi-for-coding', 'k3', 'k3[1m]', 'k3-256k'],"],
  ["      ['auto', 'kimi-for-coding', 'k3', 'k3[1m]', 'k3-256k', 'k3-next'],", "      ['kimi-for-coding', 'k3', 'k3[1m]', 'k3-256k', 'k3-next'],"],
])

// ---------------------------------------------------------------------------
// grok: its two auto tests are removed by hand below, and the expected lists
// simply lose the synthetic entry.
// ---------------------------------------------------------------------------
patch('test/grok.spec.ts', [
  ["    assert.deepEqual(models.map((model) => model.id), ['auto', ...GROK_MODELS.map((entry) => entry.id)])",
    "    assert.deepEqual(models.map((model) => model.id), GROK_MODELS.map((entry) => entry.id))"],
  ["      ['auto', 'grok-4.6', 'grok-4.5', 'grok-5'],", "      ['grok-4.6', 'grok-4.5', 'grok-5'],"],
  ["      ['auto', 'grok-4.6'],", "      ['grok-4.6'],"],
])

// ---------------------------------------------------------------------------
// antigravity: no shipped catalog at all, so its picker list is empty.
// ---------------------------------------------------------------------------
patch('test/antigravity.spec.ts', [
  [`    // Antigravity ships no curated list: an account's catalog is plan-dependent.
    assert.deepEqual((await adapter.listModels('antigravity')).map((model) => model.id), ['auto'])`,
    `    // Antigravity ships no curated list: an account's catalog is plan-dependent,
    // so before discovery the picker has nothing to offer.
    assert.deepEqual(await adapter.listModels('antigravity'), [])`],
  ["    assert.deepEqual((await adapter.listModels('antigravity')).map((model) => model.id), ['auto', 'gemini-3-pro', 'claude-sonnet-4'])",
    "    assert.deepEqual((await adapter.listModels('antigravity')).map((model) => model.id), ['gemini-3-pro', 'claude-sonnet-4'])"],
])

// ---------------------------------------------------------------------------
// controller: routes no longer publish a synthetic entry.
// ---------------------------------------------------------------------------
patch('test/controller.spec.ts', [
  ["describe('the auto entry and model visibility'", "describe('model visibility and order'"],
  ["    assert.deepEqual(status.models.map((model) => model.id), ['auto', 'model-a'])\n", "    assert.deepEqual(status.models.map((model) => model.id), ['model-a'])\n"],
  [`  test('auto is listed first, pinned, and reports the first model it would try', async () => {
    const { controller: subject } = withModels()
    const status = await subject.status()
    assert.deepEqual(status.models.map((model) => model.id), ['auto', 'model-a', 'model-b', 'model-c'])
    assert.equal(status.models[0]?.pinned, true)
    assert.equal(status.models[0]?.visible, true)
    assert.equal(status.models[0]?.contextWindow, 1_000)
  })`,
    `  test('lists every model of the route, in catalog order', async () => {
    const { controller: subject } = withModels()
    const status = await subject.status()
    assert.deepEqual(status.models.map((model) => model.id), ['model-a', 'model-b', 'model-c'])
    assert.equal(status.models[0]?.visible, true)
    assert.equal(status.models[0]?.contextWindow, 1_000)
  })`],
  [`  test('models keep the catalog order after a visibility change', async () => {
    const { controller: subject, prefs } = withModels()
    await subject.setModelVisible('model-b', false)
    assert.deepEqual([...(await prefs.hiddenIds('test'))], ['model-b'])
    const status = await subject.status()
    assert.deepEqual(status.models.map((model) => model.id), ['auto', 'model-a', 'model-b', 'model-c'])
    assert.equal(status.models.find((model) => model.id === 'model-b')?.visible, false)
    // auto skips the hidden model, so it advertises the next one.
    assert.equal(status.models[0]?.contextWindow, 1_000)
  })`,
    `  test('a hidden model stays listed, dimmed, and re-enableable', async () => {
    const { controller: subject, prefs } = withModels()
    await subject.setModelVisible('model-b', false)
    assert.deepEqual([...(await prefs.hiddenIds('test'))], ['model-b'])
    const status = await subject.status()
    assert.deepEqual(status.models.map((model) => model.id), ['model-a', 'model-b', 'model-c'])
    assert.equal(status.models.find((model) => model.id === 'model-b')?.visible, false)
  })`],
  [`  test('hiding the first model moves what auto advertises', async () => {
    const { controller: subject } = withModels()
    await subject.setModelVisible('model-a', false)
    assert.equal((await subject.status()).models[0]?.contextWindow, 2_000)
  })`, ''],
  [`  test('auto can be switched off and back on', async () => {
    const { controller: subject, prefs } = withModels()
    const off = await subject.setModelVisible('auto', false)
    assert.deepEqual([...(await prefs.hiddenIds('test'))], ['auto'])
    assert.equal(off.models[0]?.visible, false)
    // The chain it walks is untouched, so a session that saved \`auto\` keeps working.
    assert.deepEqual(off.models.slice(1).map((model) => model.id), ['model-a', 'model-b', 'model-c'])

    const on = await subject.setModelVisible('auto', true)
    assert.equal(on.models[0]?.visible, true)
    assert.deepEqual([...(await prefs.hiddenIds('test'))], [])
  })`, ''],
  [`  test('a dropped order is stored, and auto follows it', async () => {
    const { controller: subject, prefs } = withModels()
    const status = await subject.setModelOrder(['model-c', 'model-a', 'model-b'])
    assert.deepEqual(await prefs.orderOf('test'), ['model-c', 'model-a', 'model-b'])
    assert.deepEqual(status.models.map((model) => model.id), ['auto', 'model-c', 'model-a', 'model-b'])
    // auto now starts with whatever the user dragged to the top.
    assert.equal(status.models[0]?.contextWindow, 3_000)
  })`,
    `  test('a dropped order is stored and reported', async () => {
    const { controller: subject, prefs } = withModels()
    const status = await subject.setModelOrder(['model-c', 'model-a', 'model-b'])
    assert.deepEqual(await prefs.orderOf('test'), ['model-c', 'model-a', 'model-b'])
    assert.deepEqual(status.models.map((model) => model.id), ['model-c', 'model-a', 'model-b'])
  })`],
  [`  test('an order naming only the enabled models keeps the rest ranked after them', async () => {
    const { controller: subject, prefs } = withModels()
    // \`model-b\` is hidden, so the page would not have sent it.
    await subject.setModelVisible('model-b', false)
    await subject.setModelOrder(['model-c'])
    assert.deepEqual(await prefs.orderOf('test'), ['model-c', 'model-a', 'model-b'])
  })`,
    `  test('an order naming only the enabled models keeps the rest ranked after them', async () => {
    const { controller: subject, prefs } = withModels()
    // \`model-b\` is hidden, so the page would not have sent it.
    await subject.setModelVisible('model-b', false)
    await subject.setModelOrder(['model-c'])
    assert.deepEqual(await prefs.orderOf('test'), ['model-c', 'model-a', 'model-b'])
  })`],
])

// ---------------------------------------------------------------------------
// plugin: `auto` is a fourth route.
// ---------------------------------------------------------------------------
patch('test/plugin.spec.ts', [
  ["    assert.deepEqual(registrations.map((entry) => entry.providers), [['kimi'], ['grok'], ['antigravity']])",
    "    assert.deepEqual(registrations.map((entry) => entry.providers), [['kimi'], ['grok'], ['antigravity'], ['auto']])"],
  [`  test('an unknown route id is reported rather than silently dropped', () => {`,
    `  test('the auto provider can be left out', () => {
    const { ctx, registrations } = stubContext()
    apply(ctx, { auto: false })
    assert.deepEqual(registrations.map((entry) => entry.providers), [['kimi'], ['grok'], ['antigravity']])
  })

  test('an unknown route id is reported rather than silently dropped', () => {`],
])

// Verify the Ark volc-sso endpoints the binary described actually exist.
// Nothing is authorized here: these are unauthenticated probes of the OAuth surface.
const CLIENT_ID = 'trn:signin:::devtools/same-device'
const authorize = new URL('https://signin.volcengine.com/authorize/oauth/authorize')
authorize.searchParams.set('response_type', 'code')
authorize.searchParams.set('client_id', CLIENT_ID)
authorize.searchParams.set('redirect_uri', 'http://127.0.0.1:51789/oauth/callback')
authorize.searchParams.set('state', 'probe-state')
authorize.searchParams.set('code_challenge', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
authorize.searchParams.set('code_challenge_method', 'S256')

for (const [label, url, init] of [
  ['authorize (GET, follow off)', authorize.toString(), { method: 'GET', redirect: 'manual' }],
  ['token (POST, bogus code)', 'https://signin.volcengine.com/authorize/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'probe-not-a-code',
      client_id: CLIENT_ID,
      redirect_uri: 'http://127.0.0.1:51789/oauth/callback',
      code_verifier: 'probe-verifier',
    }).toString(),
  }],
  ['portal host (cloudidentity-oauth)', 'https://cloudidentity-oauth.cn-beijing.volces.com/', { method: 'GET' }],
]) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })
    const body = (await response.text()).slice(0, 220).replace(/\s+/g, ' ')
    console.log(`${String(response.status).padEnd(4)} ${label}\n      ${body}\n`)
  } catch (error) {
    console.log(`ERR  ${label}\n      ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

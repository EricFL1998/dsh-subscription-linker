// Live check of the GLM flow module against the real broker: one init, one poll.
// Creates a throwaway login flow; holds no credential and expires on its own.
import { pollGlmFlow, startGlmFlow } from '../lib/auth/glm-flow.js'

const flow = await startGlmFlow()
console.log('flow id:', flow.flowId)
console.log('authorize:', flow.authorizeUrl)
console.log('poll interval ms:', flow.pollIntervalMs)
console.log('expires in ms:', flow.expiresAt - Date.now())

const pending = await pollGlmFlow({}, flow)
console.log('first poll:', pending === undefined ? 'pending (as expected)' : 'tokens returned?!')

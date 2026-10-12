// Feed the parsers the real control-plane bodies captured from the service.
import { parseArkFreeUsage, parseArkPlanUsage } from '../lib/auth/ark-control.js'

// Captured from a live `ListModelChargeItems` call (LLM modality, page size 5).
const freeUsage = {
  ResponseMetadata: { Action: 'ListModelChargeItems', Region: 'cn-beijing', Service: 'ark', Version: '2024-01-01' },
  Result: {
    Items: [
      { FoundationModelName: 'doubao-seed-2-1-lite', DisplayName: 'Doubao-Seed-2.1-lite', InferenceFreeUsage: { Consumed: 0, Total: 500000 } },
      { FoundationModelName: 'deepseek-v4-1-flash', DisplayName: 'DeepSeek-V4.1-Flash', InferenceFreeUsage: { Consumed: 0, Total: 500000 } },
      { FoundationModelName: 'glm-5-3-flash', DisplayName: 'GLM-5.3-Flash', InferenceFreeUsage: { Consumed: 0, Total: 500000 } },
      { FoundationModelName: 'no-free-tier-model', DisplayName: 'None' },
    ],
  },
}
console.log('free usage:', JSON.stringify(parseArkFreeUsage(freeUsage)))

// Captured from a live `GetCodingPlanUsage` call on an account with no plan.
const noPlan = {
  ResponseMetadata: { Action: 'GetCodingPlanUsage', Region: 'cn-beijing', Service: 'ark', Version: '2024-01-01' },
  Result: { HasReward: false, Status: 'Reclaimed', UpdateTimestamp: 1791786829 },
}
console.log('no plan:', JSON.stringify(parseArkPlanUsage(noPlan)))

// The subscribed shape, as the CLI's own help documents it.
const subscribed = {
  ResponseMetadata: { Action: 'GetCodingPlanUsage', Region: 'cn-beijing', Service: 'ark', Version: '2024-01-01' },
  Result: {
    subscribed: true,
    coding_usage: {
      periods: [
        { label: '5h', used: 250, total: 1000, percent: 25, reset_at: '2024-05-30T05:26:40+08:00' },
        { label: 'weekly', used: 12500, total: 50000, percent: 25, reset_at: '2024-06-06T00:26:40+08:00' },
        { label: 'monthly', used: 50000, total: 200000, percent: 25, reset_at: '2024-06-29T05:06:40+08:00' },
      ],
    },
  },
}
console.log('subscribed:', JSON.stringify(parseArkPlanUsage(subscribed)))

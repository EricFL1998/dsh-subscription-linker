// One-off: copy for the dead-login badge.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'src/client/locales.ts'
let text = readFileSync(file, 'utf8')

const pairs = [
  ["  defaultBadge: 'Default',",
    `  defaultBadge: 'Default',
  accountNeedsLogin: 'Sign in again',
  accountNeedsLoginHint: 'The provider refused this account's grant, so its token cannot be renewed',`],
  ["  defaultBadge: '默认',",
    `  defaultBadge: '默认',
  accountNeedsLogin: '需重新登录',
  accountNeedsLoginHint: '服务方已拒绝该账号的授权，令牌无法自动续期',`],
]

for (const [from, to] of pairs) {
  if (!text.includes(from)) throw new Error(`locale anchor missing: ${from}`)
  text = text.replace(from, to)
}
writeFileSync(file, text)
console.log('patched', file)

// One-off: surface the dead login in the card, and lift it on a fresh sign-in.
import { readFileSync, writeFileSync } from 'node:fs'

{
  const file = 'src/auth/provider-controller.ts'
  let text = readFileSync(file, 'utf8')
  const from = `  async login(account?: string): Promise<ProviderLoginStart> {
    const attempt = await this.options.flow.start()
    this.lastError = undefined`
  if (!text.includes(from)) throw new Error('login anchor missing')
  text = text.replace(from, `  async login(account?: string): Promise<ProviderLoginStart> {
    const attempt = await this.options.flow.start()
    this.lastError = undefined
    // A new sign-in replaces the credential, so a previous refusal no longer
    // describes what is stored.
    this.refused.clear()`)

  const logoutFrom = `  async logout(account?: string): Promise<ProviderStatus> {`
  if (text.includes(logoutFrom)) {
    const at = text.indexOf(logoutFrom)
    const end = text.indexOf('\n', at) + 1
    text = text.slice(0, end) + '    this.refused.delete(account ?? \'\')\n' + text.slice(end)
  }
  writeFileSync(file, text)
  console.log('patched', file)
}

{
  const file = 'src/client/SubscriptionsSection.tsx'
  let text = file ? readFileSync(file, 'utf8') : ''
  const from = `                  {account.isDefault && <span style={styles.badge}>{t('defaultBadge')}</span>}`
  if (!text.includes(from)) throw new Error('badge anchor missing')
  text = text.replace(from, `${from}
                  {/* The provider refused this grant: only a new sign-in helps. */}
                  {account.needsLogin === true && (
                    <span style={styles.badge} title={t('accountNeedsLoginHint')}>{t('accountNeedsLogin')}</span>
                  )}`)
  writeFileSync(file, text)
  console.log('patched', file)
}

{
  const file = 'src/client/locales.ts'
  let text = readFileSync(file, 'utf8')
  text = text.replace("  defaultBadge: 'Default',",
    `  defaultBadge: 'Default',
  accountNeedsLogin: 'Sign in again',
  accountNeedsLoginHint: 'The provider refused this account\\'s grant, so its token cannot be renewed',`)
  text = text.replace("  defaultBadge: '默认',",
    `  defaultBadge: '默认',
  accountNeedsLogin: '需重新登录',
  accountNeedsLoginHint: '服务方已拒绝该账号的授权，令牌无法自动续期',`)
  writeFileSync(file, text)
  console.log('patched', file)
}

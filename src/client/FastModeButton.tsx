/**
 * The composer's quick-mode button.
 *
 * The route's own fast/lightspeed variant is not a row in the model picker: it shares its
 * base model's visibility and is reached from here. The composer renders
 * `conversation.input.right` immediately before its model seat, so this button sits at
 * the model selector's left — the control a reader looks for when they want the same
 * model, faster.
 *
 * Off, the selection is the base model and pressing the button selects the fast variant.
 * On, the selection *is* the fast variant, so the button reports active and pressing it
 * returns to the base — which is why `model-variants` answers from both sides of the pair
 * rather than only from the base id.
 *
 * The button renders nothing when the model has no fast variant, when the route is not
 * one this plugin serves, or when the host exposes no way to change the selection: an
 * absent control is honest, a disabled one is noise.
 *
 * @module dsh-plugin-subscription-oauth/client/FastModeButton
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'

import type { SubscriptionsCall } from './subscriptions-rpc.js'
import type { ModelSelectionProjection } from './UsageChip.js'
import { providerOf } from './UsageChip.js'
import { fastModeCss } from './styles.js'

/** Injected props the button is registered with. */
export interface FastModeButtonInjected {
  /** The plugin's own RPC caller, for the one `model-variants` read. */
  call: SubscriptionsCall
  /** Whether the provider is one this plugin serves. */
  isOwnProvider: (provider: string) => boolean
  /**
   * The session's model directory, when the host exposes one.
   *
   * Written when the button switches between a model and its fast variant. Absent on a
   * host without it, in which case the button renders nothing.
   */
  modelDirectory?: {
    /** Select one model; resolves when the picker has accepted it. */
    select?: (selection: { provider: string, model: string }) => Promise<unknown>
  } | undefined
}

/**
 * The quick-mode control, for the composer's row of standard controls.
 *
 * @param props - injected RPC caller, directory, and the session standard kit.
 * @returns the button, or null when this model has no fast variant.
 */
export function FastModeButton({ call, isOwnProvider, modelDirectory, useProjection }: FastModeButtonInjected & SessionStandardProps): ReactNode {
  const [pair, setPair] = useState<{ wireId: string, baseId?: string } | undefined>(undefined)
  const selection = useProjection('modelSelection', (value) => (value as ModelSelectionProjection))
  const provider = providerOf(selection)
  const model = selection?.next?.model ?? selection?.lastUsed?.model

  useEffect(() => {
    if (provider === undefined || model === undefined || !isOwnProvider(provider)) {
      setPair(undefined)
      return
    }
    let live = true
    void call('model-variants', { provider, id: model })
      .then((result) => {
        if (!live) return
        setPair(result?.fast === undefined
          ? undefined
          : { wireId: result.fast, ...result.fastBase === undefined ? {} : { baseId: result.fastBase } })
      })
      .catch(() => { if (live) setPair(undefined) })
    return () => { live = false }
  }, [provider, model, isOwnProvider, call])

  if (pair === undefined || provider === undefined || modelDirectory?.select === undefined) return null
  const active = pair.wireId === model
  const target = active ? pair.baseId : pair.wireId
  // Active without a base to return to would be a control that cannot switch anything off.
  if (target === undefined || target === model) return null

  return (
    <>
      <style>{fastModeCss}</style>
      <button
        type="button"
        className="dsh-subscription-fast-mode"
        data-active={active}
        aria-pressed={active}
        title={active ? 'Fast mode is on; switch back to the standard model' : 'Switch to the fast variant of this model'}
        aria-label={active ? 'Fast mode is on' : 'Switch to fast mode'}
        onClick={(event) => {
          event.stopPropagation()
          void modelDirectory.select?.({ provider, model: target })
        }}
      >
        <span className="dsh-subscription-fast-mode-bolt" aria-hidden="true">⚡</span>
        <span className="dsh-subscription-fast-mode-label">Fast</span>
      </button>
    </>
  )
}

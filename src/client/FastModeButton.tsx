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
  // A switch that the host refuses must not look like a dead button: the reason is kept
  // and shown, because the only alternative is a control that silently does nothing.
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)
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

  // A switch that landed clears the reason, so the marker follows the truth on screen.
  useEffect(() => { setFailure(undefined) }, [model])

  if (pair === undefined || provider === undefined || modelDirectory?.select === undefined) return null
  const active = pair.wireId === model
  const target = active ? pair.baseId : pair.wireId
  // Active without a base to return to would be a control that cannot switch anything off.
  if (target === undefined || target === model) return null

  const base = active ? 'Fast mode is on; switch back to the standard model' : 'Switch to the fast variant of this model'
  const title = failure === undefined ? base : `${base}\nThe switch was refused: ${failure}`

  return (
    <>
      <style>{fastModeCss}</style>
      <button
        type="button"
        className="dsh-subscription-fast-mode"
        data-active={active}
        data-pending={pending}
        data-failed={failure !== undefined}
        aria-pressed={active}
        aria-busy={pending}
        title={title}
        aria-label={active ? 'Fast mode is on' : 'Switch to fast mode'}
        onClick={(event) => {
          event.stopPropagation()
          setPending(true)
          setFailure(undefined)
          void Promise.resolve(modelDirectory.select?.({ provider, model: target }))
            .then((result) => {
              // The directory reports its own outcome: a refused selection carries why.
              const outcome = result as { ok?: boolean, error?: { code?: string, message?: string } } | undefined
              const refused = outcome?.ok === false
              setFailure(refused
                ? outcome.error?.message ?? outcome.error?.code ?? 'the host refused the selection'
                : undefined)
              if (refused) console.warn(`[subscription-oauth] fast mode ${provider}/${target} refused:`, outcome.error)
            })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error)
              setFailure(message)
              console.warn(`[subscription-oauth] fast mode ${provider}/${target} failed:`, error)
            })
            .finally(() => { setPending(false) })
        }}
      >
        <span className="dsh-subscription-fast-mode-bolt" aria-hidden="true">⚡</span>
        <span className="dsh-subscription-fast-mode-label">{failure === undefined ? 'Fast' : 'Fast ⚠'}</span>
      </button>
    </>
  )
}

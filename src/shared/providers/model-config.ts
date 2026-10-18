import type { ProviderModelInfo } from '../types'

/** Fill capabilities added to a built-in model after its settings were persisted. */
export function mergeProviderModelCapabilities(
  storedModel: ProviderModelInfo | undefined,
  defaultModel: ProviderModelInfo | undefined
): ProviderModelInfo | undefined {
  if (!storedModel) return defaultModel
  if (storedModel.capabilities !== undefined || defaultModel?.capabilities === undefined) return storedModel

  return {
    ...storedModel,
    capabilities: defaultModel.capabilities,
  }
}

/**
 * Models absent from the models.dev registry (custom endpoints, freshly released vendor models
 * such as GLM-5.3-Flash) used to resolve with no capabilities at all. Every capability-gated
 * feature then silently switched itself off — including session-attachment RAG, whose toolset
 * is only mounted when `isSupportToolUse('read-file')` is true, leaving an indexed knowledge
 * base as an empty FILE_CONTENT in the prompt.
 *
 * OpenAI-compatible chat endpoints accept `tools` in practice, so treat such models as
 * tool-capable by default. An explicit `capabilities` list on the stored model — including an
 * empty array, which is how a user opts out — always wins.
 */
export function withDefaultToolUseCapability(
  model: ProviderModelInfo,
  storedModel: ProviderModelInfo | undefined
): ProviderModelInfo {
  if (storedModel?.capabilities !== undefined) return model
  if (model.capabilities && model.capabilities.length > 0) return model
  if (model.type && model.type !== 'chat') return model
  return { ...model, capabilities: ['tool_use'] }
}

import type { Message, SessionAttachmentQueryPlan } from '@shared/types'
import { getLogger } from '@/lib/utils'
import platform from '@/platform'

const log = getLogger('session-attachment-retrieval')

/** Hard cap on the injected retrieval block so a single turn cannot blow up the prompt. */
const MAX_BLOCK_CHARS = 6000
const DEFAULT_MAX_HITS = 8

export function collectSessionRetrievalAttachmentIds(messages: Message[]): number[] {
  const ids = new Set<number>()
  for (const message of messages) {
    for (const file of message.files ?? []) {
      if (
        file.ragMode === 'session-retrieval' &&
        file.sessionAttachmentAvailability !== 'blocked' &&
        typeof file.sessionAttachmentId === 'number'
      ) {
        ids.add(file.sessionAttachmentId)
      }
    }
  }
  return [...ids]
}

function extractLatestUserQuery(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user' || message.generating) continue
    const text = message.contentParts
      .filter((part) => part.type === 'text')
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n')
      .trim()
    if (text) return text
  }
  return undefined
}

function formatRetrievalBlock(params: {
  query: string
  hits: Awaited<ReturnType<ReturnType<typeof platform.getSessionAttachmentRagController>['query']>>
}): string | undefined {
  const { query, hits } = params
  if (hits.length === 0) return undefined

  const lines: string[] = []
  let used = 0
  let index = 0
  for (const hit of hits) {
    index += 1
    const section = hit.sectionPath ? ` · ${hit.sectionPath}` : ''
    const header = `[${index}] ${hit.filename}${section} (score ${hit.score.toFixed(2)})`
    const body = hit.text.replace(/\s+\n/g, '\n').trim()
    const entry = `${header}\n${body}\n`
    if (used + entry.length > MAX_BLOCK_CHARS) break
    lines.push(entry)
    used += entry.length
  }
  if (lines.length === 0) return undefined

  return [
    '',
    '<RETRIEVED_CONTEXT>',
    `These passages were retrieved locally from the session's indexed attachments for the current question (query: "${query.slice(0, 200)}").`,
    'Treat them as the authoritative source for canon facts; prefer them over general knowledge, and do not invent details missing here.',
    '',
    ...lines,
    '</RETRIEVED_CONTEXT>',
    '',
  ].join('\n')
}

/**
 * Retrieval is normally tool-driven (`query_session_attachment`), which silently does nothing when
 * the selected model has no tool-use capability. This helper guarantees a retrieval step for such
 * models by running the same local query up front and appending the hits to the last user turn.
 *
 * Returns the number of injected hits (0 when nothing was injected).
 */
export async function injectSessionAttachmentRetrieval(params: {
  promptMessages: Message[]
  allMessages: Message[]
  maxHits?: number
}): Promise<{ injected: number }> {
  const { promptMessages, allMessages, maxHits = DEFAULT_MAX_HITS } = params

  const attachmentIds = collectSessionRetrievalAttachmentIds(allMessages)
  if (attachmentIds.length === 0) return { injected: 0 }

  const query = extractLatestUserQuery(promptMessages) ?? extractLatestUserQuery(allMessages)
  if (!query) return { injected: 0 }

  const plan: SessionAttachmentQueryPlan = {
    recallTopK: 20,
    finalTopK: Math.max(1, Math.min(maxHits, 12)),
    rerank: { enabled: false },
  }

  try {
    const controller = platform.getSessionAttachmentRagController()
    const hits = await controller.query({ attachmentIds, query, plan })
    const block = formatRetrievalBlock({ query, hits })
    if (!block) {
      log.debug('session attachment retrieval returned no hits; skipping injection')
      return { injected: 0 }
    }

    for (let i = promptMessages.length - 1; i >= 0; i -= 1) {
      const message = promptMessages[i]
      if (message.role !== 'user' || message.generating) continue
      message.contentParts = [...message.contentParts, { type: 'text', text: block }]
      log.debug(`injected ${hits.length} retrieved passages into the last user turn (query=${query.slice(0, 40)})`)
      return { injected: hits.length }
    }
  } catch (error) {
    log.warn('session attachment retrieval injection failed', error)
  }
  return { injected: 0 }
}

import type { Message, SessionAttachmentQueryPlan } from '@shared/types'
import { getLogger } from '@/lib/utils'
import { reportTelemetry } from '@/utils/telemetry'
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

const CHAPTER_PATTERN = /(?:当前章节[：:\s]*)?第\s*(\d{1,4})\s*章/
const ANAPHORA_PATTERN = /[他她它此其该]|对方|这人|那人|刚才|前面|上面|其中/
const STORY_ENTITY_STOPWORDS = new Set([
  '什么', '怎么', '如何', '为什么', '为何', '哪些', '哪个', '哪里', '现在', '目前',
  '当前', '多少', '是否', '能否', '可以', '能够', '一个', '一些', '这个', '那个',
  '他们', '她们', '它们', '我们', '你们', '自己', '时候', '情况', '请问', '告诉',
  '介绍', '修为', '境界', '实力', '状态', '章节', '剧情', '原著', '主角', '这里',
  '方源', '古月方源',
])

function getMessagePlainText(message: Message): string {
  return (message.contentParts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n')
    .trim()
}

function extractEntityCandidates(text: string): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()
  const add = (raw: string) => {
    const clean = raw.trim()
    if (clean.length < 2 || clean.length > 10 || STORY_ENTITY_STOPWORDS.has(clean) || seen.has(clean)) {
      return
    }
    seen.add(clean)
    candidates.push(clean)
  }

  const quoted = text.match(/["“「『【]([^"”」』】\n]{2,10})["”」』】]/g)
  if (quoted) {
    for (const q of quoted) {
      add(q.slice(1, -1))
    }
  }

  const domainHits = text.match(
    /[\u4e00-\u9fa5]{1,4}(?:仙尊|魔尊|尊者|仙蛊|蛊虫|蛊师|本命蛊|蛊|福地|洞天|山寨|山|宗|阁|殿|传承)/g
  )
  if (domainHits) {
    for (const m of domainHits) {
      add(m)
    }
  }

  if (candidates.length < 5 && typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    try {
      const segmenter = new (Intl as unknown as {
        Segmenter: new (
          locale: string,
          options: { granularity: string }
        ) => { segment: (input: string) => Iterable<{ segment: string; isWordLike?: boolean }> }
      }).Segmenter('zh-CN', { granularity: 'word' })
      for (const { segment, isWordLike } of segmenter.segment(text.slice(0, 600))) {
        if (isWordLike && /^[\u4e00-\u9fa5]{2,5}$/.test(segment)) {
          add(segment)
          if (candidates.length >= 5) break
        }
      }
    } catch {
      // Ignore environments without Intl.Segmenter zh-CN support
    }
  }

  return candidates.slice(0, 5)
}

export function extractRecentStoryContext(
  messages: Message[],
  latestQuery: string
): { currentChapter?: number; activeEntities: string[]; enrichedQuery: string } {
  let currentChapter: number | undefined
  const directChapter = latestQuery.match(CHAPTER_PATTERN)
  if (directChapter) {
    const parsed = parseInt(directChapter[1], 10)
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 2500) {
      currentChapter = parsed
    }
  }

  const recentTurns: string[] = []
  let scanned = 0
  for (let i = messages.length - 1; i >= 0 && scanned < 6; i -= 1) {
    const msg = messages[i]
    if (msg.generating || (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'system')) {
      continue
    }
    const text = getMessagePlainText(msg)
    if (!text) continue
    scanned += 1
    if (currentChapter === undefined) {
      const m = text.match(CHAPTER_PATTERN)
      if (m) {
        const parsed = parseInt(m[1], 10)
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 2500) {
          currentChapter = parsed
        }
      }
    }
    if (recentTurns.length < 2 && msg.role !== 'system' && text !== latestQuery) {
      recentTurns.push(text)
    }
  }

  let activeEntities: string[] = []
  if (latestQuery.length < 24 || ANAPHORA_PATTERN.test(latestQuery)) {
    activeEntities = extractEntityCandidates(recentTurns.join('\n'))
  }

  const enrichedQuery =
    activeEntities.length > 0 && !activeEntities.some((e) => latestQuery.includes(e))
      ? `${activeEntities.slice(0, 2).join(' ')} ${latestQuery}`
      : latestQuery

  return { currentChapter, activeEntities, enrichedQuery }
}

function extractLatestUserQuery(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user' || message.generating) continue
    const text = getMessagePlainText(message)
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

  const { currentChapter, activeEntities, enrichedQuery } = extractRecentStoryContext(
    allMessages.length > 0 ? allMessages : promptMessages,
    query
  )

  const plan: SessionAttachmentQueryPlan = {
    recallTopK: 20,
    finalTopK: Math.max(1, Math.min(maxHits, 12)),
    rerank: { enabled: false },
    ...(currentChapter !== undefined || activeEntities.length > 0
      ? {
          storyFilter: {
            ...(currentChapter !== undefined ? { currentChapter } : {}),
            ...(activeEntities.length > 0 ? { activeEntities } : {}),
          },
        }
      : {}),
  }

  try {
    const controller = platform.getSessionAttachmentRagController()
    const hits = await controller.query({ attachmentIds, query: enrichedQuery, plan })
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
    reportTelemetry({
      kind: 'rag_query_error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      context: { attachmentIds, phase: 'retrieval_injection', platform: platform.type },
    })
  }
  return { injected: 0 }
}

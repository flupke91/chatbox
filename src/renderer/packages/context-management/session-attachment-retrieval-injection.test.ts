import type { Message } from '@shared/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}))

vi.mock('@/platform', () => ({
  default: {
    type: 'mobile',
    getSessionAttachmentRagController: () => ({
      query: queryMock,
    }),
  },
}))

vi.mock('@/utils/telemetry', () => ({
  reportTelemetry: vi.fn(),
}))

import {
  extractRecentStoryContext,
  injectSessionAttachmentRetrieval,
} from './session-attachment-retrieval-injection'

function msg(id: string, role: 'user' | 'assistant', text: string, files?: Message['files']): Message {
  return {
    id,
    role,
    contentParts: [{ type: 'text', text }],
    files,
  }
}

describe('extractRecentStoryContext & injectSessionAttachmentRetrieval', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryMock.mockResolvedValue([
      {
        attachmentId: 7,
        parentId: 12,
        filename: 'gur-kb.json',
        sectionPath: 'items_and_gu:酒虫',
        score: 0.91,
        text: '酒虫：一转稀罕蛊虫，能提炼小半成高阶真元。',
      },
    ])
  })

  it('extracts chapter number from prior turns and carries entities on pronoun follow-up', () => {
    const history: Message[] = [
      msg('1', 'user', '当前章节：第15章。请介绍“酒虫”的来源和花酒行者。', [
        {
          id: 'f1',
          name: 'gur-kb.json',
          fileType: 'application/json',
          ragMode: 'session-retrieval',
          sessionAttachmentId: 7,
        },
      ]),
      msg('2', 'assistant', '第15章中，“酒虫”原本藏在花酒行者遗留的残骸旁。'),
      msg('3', 'user', '它有什么功效？'),
    ]

    const ctx = extractRecentStoryContext(history, '它有什么功效？')
    expect(ctx.currentChapter).toBe(15)
    expect(ctx.activeEntities).toContain('酒虫')
    expect(ctx.enrichedQuery).toContain('酒虫')
  })

  it('passes extracted storyFilter into controller.query and appends RETRIEVED_CONTEXT block', async () => {
    const allMessages: Message[] = [
      msg('1', 'user', '当前在第198章，白凝冰爆发十绝体自爆。', [
        {
          id: 'f1',
          name: 'gur-kb.json',
          fileType: 'application/json',
          ragMode: 'session-retrieval',
          sessionAttachmentId: 7,
        },
      ]),
      msg('2', 'assistant', '第198章青茅山危局中，白凝冰化作冰霜爆发。'),
      msg('3', 'user', '之后他用什么蛊脱身？'),
    ]
    const promptMessages: Message[] = [msg('3', 'user', '之后他用什么蛊脱身？')]

    const res = await injectSessionAttachmentRetrieval({ promptMessages, allMessages })
    expect(res.injected).toBe(1)
    expect(queryMock).toHaveBeenCalledWith({
      attachmentIds: [7],
      query: expect.stringContaining('之后他用什么蛊脱身？'),
      plan: expect.objectContaining({
        storyFilter: expect.objectContaining({
          currentChapter: 198,
        }),
      }),
    })
    expect(promptMessages[0].contentParts).toHaveLength(2)
    expect((promptMessages[0].contentParts[1] as { text: string }).text).toContain('<RETRIEVED_CONTEXT>')
  })
})

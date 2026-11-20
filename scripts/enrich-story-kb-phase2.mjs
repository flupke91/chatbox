/**
 * 蛊真人 KB 阶段二 —— 对照小说原文精校与补全（确定性，零 LLM 调用）
 *
 * 输入：patch/goal/gur-kb-chatbox-slim.json（阶段一定版，14.49 MiB / 33,800 卡）
 *       G:\workplace\gur-backfill\大爱-2.txt（原文，只读）
 * 输出：patch/goal/gur-kb-chatbox-v2.json（阶段二产物，阶段一文件保持不动）
 *       patch/goal/phase2-audit-report.json（审计报告，不入 KB）
 *
 * 用法：
 *   node scripts/enrich-story-kb-phase2.mjs             # 生成 v2 + 审计报告
 *   node scripts/enrich-story-kb-phase2.mjs --verify    # 生成 + 17 项门禁 + 端到端回归
 *   node scripts/enrich-story-kb-phase2.mjs --verify-only
 *
 * 环境变量：
 *   KB_INPUT    默认 patch/goal/gur-kb-chatbox-slim.json
 *   NOVEL_PATH  默认 G:\workplace\gur-backfill\大爱-2.txt
 *   KB_OUTPUT   默认 patch/goal/gur-kb-chatbox-v2.json
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const INPUT_REL = 'patch/goal/gur-kb-chatbox-slim.json'
const OUTPUT_REL = 'patch/goal/gur-kb-chatbox-v2.json'
const REPORT_REL = 'patch/goal/phase2-audit-report.json'
const NOVEL_DEFAULT = 'G:\\workplace\\gur-backfill\\大爱-2.txt'
const KB_VERSION = 'kb-2026-11-20-chatbox-v2-novel-verified'
const ENRICHED_FROM = 'kb-2026-11-20-chatbox-slim-v1'
const EXPECTED_CHAPTERS = 2337
const SAMPLE_SEED = 20261120

const SECTIONS = [
  'calibrated_cards',
  'entities',
  'character_states',
  'items_and_gu',
  'events',
  'rules',
  'factions',
  'locations',
  'relationships',
  'terms',
  'claims',
  'foreshadows',
  'conflicts',
  'timeline',
]
const CONTENT_SECTIONS = SECTIONS.filter((s) => s !== 'timeline' && s !== 'conflicts')

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function uniq(arr) {
  return [...new Set(arr)]
}

function pad4(n) {
  return String(n).padStart(4, '0')
}

function chapterIdOf(ordinal) {
  return `ch${pad4(ordinal + 1)}`
}

function normSpace(text) {
  return String(text ?? '').replace(/\s+/g, '')
}

function isPlainAsciiToken(value) {
  return /^[a-zA-Z0-9_.\-…]+$/.test(value)
}

function isDirtyAlias(alias) {
  if (!alias) return true
  if (alias.length <= 1 || alias.length > 12) return true
  if (/[，。；？！：:()（）【】\[\]|]|CH_\d|见第/.test(alias)) return true
  if (/^[a-zA-Z0-9_.\-]+$/.test(alias)) return true
  return false
}

function cleanKeys(keys) {
  const out = []
  const seen = new Set()
  for (const raw of keys ?? []) {
    const key = String(raw ?? '').trim()
    if (!key) continue
    if (isPlainAsciiToken(key)) continue
    if (key.length <= 1) continue
    if (/[\n\r:：|｜]/.test(key)) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

// ---------------------------------------------------------------------------
// Step 1 —— 解析原文
// ---------------------------------------------------------------------------

/** 章末作者杂谈 / 站内公告段落特征（只用于「成段剥离」，不碰正文里的正常词组）。 */
const NOTE_BLOCK_RES = [
  /^(?:ps|Ps|PS)\s*[:：]/,
  /^[（(]\s*ps\s*[:：]/i,
  /^备注\s*[:：]/,
  /^还有一个通知/,
  /^感谢[\s\S]{0,40}(?:打赏|支持|月票)/,
  /(?:求月票|呼唤月票|月票.{0,8}(?:加更|爆更)|(?:加更|爆更).{0,8}月票)/,
  /(?:书友群|QQ群|微信群|微信公众号|qdread)/,
  /(?:打赏|评价票)/,
  /加入书签/,
  /第\d+\s*\/\s*\d+\s*页/,
]

const NOISE_LINE_RES = [/^[-—]{5,}$/, /^\(?\s*未完待续[。.]?\s*\)?$/, /^（?未完待续。?）?$/]

function isNoiseBlock(block) {
  const text = block.trim()
  if (!text) return true
  if (NOISE_LINE_RES.some((re) => re.test(text))) return true
  return NOTE_BLOCK_RES.some((re) => re.test(text))
}

/** 从章末向前逐段剥离杂谈/公告，返回 cleanBodyText（只从尾部截断，保证 offset 与 rawFullText 对齐）。 */
function stripTrailingAuthorNotes(raw) {
  const parts = []
  const sepRe = /\r?\n(?:[ \t]*\r?\n)+/g
  let pos = 0
  let m
  while ((m = sepRe.exec(raw))) {
    parts.push({ start: pos, end: m.index })
    pos = sepRe.lastIndex
  }
  parts.push({ start: pos, end: raw.length })

  let cut = raw.length
  for (let i = parts.length - 1; i >= 0; i--) {
    if (isNoiseBlock(raw.slice(parts[i].start, parts[i].end))) {
      cut = parts[i].start
    } else {
      break
    }
  }
  return { clean: raw.slice(0, cut), removed: raw.length - cut }
}

function parseNovel(novelPath, kb) {
  const text = fs.readFileSync(novelPath, 'utf8')
  const HEAD_RE = /^[ \t]*第[零一二三四五六七八九十百千万两\d]+节[^\r\n]*$/gm
  const heads = []
  for (const m of text.matchAll(HEAD_RE)) heads.push({ index: m.index, title: m[0].trim() })
  if (heads.length !== EXPECTED_CHAPTERS) {
    throw new Error(`原文切分得到 ${heads.length} 章，期望 ${EXPECTED_CHAPTERS}`)
  }

  const chapters = heads.map((head, ordinal) => {
    const start = head.index
    const end = ordinal + 1 < heads.length ? heads[ordinal + 1].index : text.length
    const raw = text.slice(start, end)
    const stripped = stripTrailingAuthorNotes(raw)
    return {
      ordinal,
      start,
      end,
      title: head.title,
      rawFullText: raw,
      cleanBodyText: stripped.clean,
      authorNoteChars: stripped.removed,
    }
  })

  // 时间线 235 条标题必须逐字对齐
  const timeline = kb.timeline ?? []
  let matched = 0
  const misses = []
  for (const card of timeline) {
    const m = /^第\d+章\s+(.*)$/.exec(String(card.name ?? ''))
    const ordinal = Number((card.ch ?? [0])[0])
    const want = m ? m[1].replace(/\s+/g, '') : null
    const have = chapters[ordinal]?.title.replace(/\s+/g, '')
    if (want && have && want === have) matched++
    else misses.push({ id: card._id, name: card.name, actual: have ?? null })
  }
  if (matched !== timeline.length) {
    throw new Error(`timeline 标题对齐 ${matched}/${timeline.length}，未达 100%：${JSON.stringify(misses.slice(0, 5))}`)
  }

  const emptyChapters = chapters.filter((c) => normSpace(c.cleanBodyText).length < 200).map((c) => c.ordinal + 1)

  return {
    text,
    chapters,
    stats: {
      chapterCount: chapters.length,
      timelineMatched: matched,
      timelineTotal: timeline.length,
      authorNoteCharsRemoved: chapters.reduce((sum, c) => sum + c.authorNoteChars, 0),
      emptyChapters,
    },
  }
}

function chapterOf(novel, ordinal) {
  return novel.chapters[ordinal]
}

/** 单双引号归一：只做等长字符替换，保证折叠串的索引能直接映射回原文。 */
function foldQuoteChars(text) {
  return text.replace(/[‘’]/g, (ch) => (ch === '‘' ? '“' : '”'))
}

/** 把一条引文在指定章节里重锚成「逐字连续子串」。返回 { quote, offset } 或 null。 */
function reanchorQuote(novel, ordinal, rawQuote) {
  const chapter = chapterOf(novel, ordinal)
  if (!chapter) return null
  const seg = chapter.rawFullText
  const quote = String(rawQuote ?? '').trim()
  if (!quote) return null

  if (seg.includes(quote)) return { quote, offset: seg.indexOf(quote) }

  // 0) 单双引号差异（‘’ vs “”）：等长折叠后按同一索引切回原文
  const foldedSeg = foldQuoteChars(seg)
  const foldedQuote = foldQuoteChars(quote)
  const fIdx = foldedSeg.indexOf(foldedQuote)
  if (fIdx >= 0) return { quote: seg.slice(fIdx, fIdx + quote.length), offset: fIdx }

  // 1) 空白差异：按去空白后的索引映射回原文偏移
  const collapsed = normSpace(seg)
  const collapsedQuote = normSpace(quote)
  if (collapsedQuote && collapsed.includes(collapsedQuote)) {
    const normStart = collapsed.indexOf(collapsedQuote)
    const map = []
    for (let i = 0; i < seg.length; i++) if (!/\s/.test(seg[i])) map.push(i)
    const startRaw = map[normStart]
    const endRaw = map[normStart + collapsedQuote.length - 1] + 1
    const span = seg.slice(startRaw, endRaw)
    if (span.length <= 320) return { quote: span, offset: startRaw }
  }

  // 2) 拼接省略（…… / ... / …）：逐段定位，取各段在原文中的最小起点到最大终点
  const parts = quote
    .split(/…+|\.{3,}/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 4)
  const hasEllipsis = /…|\.{3,}/.test(quote)
  if (parts.length >= 1 && hasEllipsis) {
    // 单段（引文尾部被省略号截断）：整段 ≥12 字且逐字命中，直接作为引文
    if (parts.length === 1) {
      const at = foldQuoteChars(seg).indexOf(foldQuoteChars(parts[0]))
      if (at >= 0 && parts[0].length >= 12) {
        return { quote: seg.slice(at, at + parts[0].length), offset: at }
      }
    }
    let cursor = 0
    let firstStart = -1
    let lastEnd = -1
    let ok = true
    const located = []
    let normCtx = null
    // 段内可能横跨原文的段落换行（如「水光。\r\n\r\n    “净水蛊…」），需允许空白差异
    const findPart = (part, from) => {
      const fPart = foldQuoteChars(part)
      const exact = foldedSeg.indexOf(fPart, from)
      if (exact >= 0) return { start: exact, end: exact + part.length }
      if (!normCtx) {
        const collapsed = normSpace(seg)
        const map = []
        for (let i = 0; i < seg.length; i++) if (!/\s/.test(seg[i])) map.push(i)
        normCtx = { collapsed, map }
      }
      const nPart = normSpace(part)
      if (!nPart) return null
      let ni = normCtx.collapsed.indexOf(nPart)
      while (ni >= 0) {
        const rawStart = normCtx.map[ni]
        const rawEnd = normCtx.map[ni + nPart.length - 1] + 1
        if (rawStart >= from) return { start: rawStart, end: rawEnd }
        ni = normCtx.collapsed.indexOf(nPart, ni + 1)
      }
      return null
    }
    for (const part of parts) {
      // 先按引文顺序向后找；找不到再全章回找（原文可能把两句前后调换）
      let at = findPart(part, cursor)
      if (!at && located.length) at = findPart(part, 0)
      if (!at) {
        ok = false
        break
      }
      firstStart = firstStart < 0 ? at.start : Math.min(firstStart, at.start)
      lastEnd = Math.max(lastEnd, at.end)
      cursor = Math.max(cursor, at.end)
      located.push({ start: at.start, end: at.end, length: at.end - at.start })
    }
    if (ok && firstStart >= 0) {
      const span = seg.slice(firstStart, lastEnd)
      if (span.length <= 300) return { quote: span, offset: firstStart }
      // 跨度超过上限时，退而取其中最长的一段连续原句（≥12 字），仍保证 100% 逐字
      const longest = [...located].sort((a, b) => b.length - a.length)[0]
      if (longest && longest.length >= 12) {
        return { quote: seg.slice(longest.start, longest.end), offset: longest.start }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Step 2 —— 机器记账卡清理
// ---------------------------------------------------------------------------

const MACHINE_RE =
  /(?:d_by:A\d|rce_ref_key:|source_ref_key:|ambiguity_note:|behaviors_and_traits:|action_result:|mental_state:|physical_state:|counterexample:|counterevidence:|applicability:|goals:actor:|当前\s*chunk|本\s*chunk|未在本\s*chunk)/i

/** 卡片正文以 `ps:` 开头（流水线把 ps 当字段标签，如 ps:direction / ps:exposure_risk）也算机器记账。 */
const MACHINE_HEAD_RE = /^ps\s*[:：]\s*[a-z_]{2,}/i

const REC_PREFIX_RE = /^rec:gur:[0-9a-f]+[：:]\s*/i
const REC_TAIL_RE = /\s*[|｜]\s*rec:gur:[\s\S]*$/i
const NAME_CATEGORY_TAIL_RE = /\s*；\s*Name:[^；;]*；\s*Category:\s*$/i

const AUTHOR_CHATTER_CARD_IDS = new Set(['m012430'])

function unwrapRecCard(card) {
  let changed = false
  if (/^rec:gur:/i.test(String(card.name ?? ''))) {
    card.name = ''
    changed = true
  }
  let text = String(card.card ?? '')
  if (REC_PREFIX_RE.test(text)) {
    text = text.replace(REC_PREFIX_RE, '')
    changed = true
  }
  if (REC_TAIL_RE.test(text)) {
    text = text.replace(REC_TAIL_RE, '')
    changed = true
  }
  if (NAME_CATEGORY_TAIL_RE.test(text)) {
    text = text.replace(NAME_CATEGORY_TAIL_RE, '')
    changed = true
  }
  card.card = text.trim()
  return changed
}

function cleanMachineCards(sections, stats) {
  for (const section of SECTIONS) {
    const cards = sections[section]
    if (!cards) continue
    const kept = []
    for (const card of cards) {
      const id = String(card._id ?? '')
      if (AUTHOR_CHATTER_CARD_IDS.has(id)) {
        stats.deletedIds.push(id)
        stats.droppedAuthorChatterCard++
        continue
      }
      if (MACHINE_RE.test(String(card.card ?? '')) || MACHINE_HEAD_RE.test(String(card.card ?? '').trim())) {
        stats.droppedMachineCard++
        stats.machineExamples.push({ section, _id: id, name: card.name ?? '', head: String(card.card).slice(0, 80) })
        continue
      }
      const isRecWrapper = /^rec:gur:/i.test(String(card.name ?? '')) || /rec:gur:/i.test(String(card.card ?? ''))
      if (isRecWrapper) {
        const changed = unwrapRecCard(card)
        if (changed) stats.unwrappedRecCard++
      }
      const body = String(card.card ?? '').trim()
      // 只有剥壳后就掏空的 rec 包装卡才丢弃；普通短卡保留（阶段一已做过空壳判定）
      if (isRecWrapper && body.length < 8) {
        stats.droppedRecShellEmpty++
        continue
      }
      if (MACHINE_RE.test(body)) {
        stats.droppedMachineCard++
        continue
      }
      kept.push(card)
    }
    sections[section] = kept
  }
}

// ---------------------------------------------------------------------------
// Step 3 —— 星号词还原（只还原原文有明文的 3 组）
// ---------------------------------------------------------------------------

const STAR_RULES = [
  [/爱情仙蛊爱\*{2,}/g, '爱情仙蛊'],
  [/\*{2,}运仙蛊/g, '狗屎运仙蛊'],
  [/\*{2,}运/g, '狗屎运'],
  [/五行\*{2,}师/g, '五行大法师'],
  [/爱\*{2,}/g, '爱情仙蛊'],
]

const STAR_NOTE_RE = /（原文(?:隐去名称|打码|星号|名号两字被隐)）/g

function restoreStars(text) {
  let out = String(text ?? '')
  for (const [re, to] of STAR_RULES) out = out.replace(re, to)
  out = out.replace(STAR_NOTE_RE, '')
  out = out.replace(/爱情仙蛊仙蛊/g, '爱情仙蛊').replace(/狗屎运仙蛊仙蛊/g, '狗屎运仙蛊')
  return out
}

function cleanStars(sections, routerAliases, stats) {
  for (const section of SECTIONS) {
    for (const card of sections[section] ?? []) {
      const before = JSON.stringify([card.name, card.card, card.keys, card.aliases])
      if (!/\*{2,}/.test(before)) continue
      if (card.name) card.name = restoreStars(card.name)
      card.card = restoreStars(card.card)
      if (Array.isArray(card.keys)) card.keys = card.keys.map(restoreStars)
      if (Array.isArray(card.aliases)) card.aliases = card.aliases.map(restoreStars)
      stats.starCards++
      stats.starCardDetails.push({
        section,
        _id: card._id,
        name_before: JSON.parse(before)[0] ?? '',
        name_after: card.name ?? '',
        card_changed: JSON.parse(before)[1] !== card.card,
      })
    }
  }

  const renamed = {}
  for (const [alias, postings] of Object.entries(routerAliases)) {
    if (!/\*{2,}/.test(alias)) {
      renamed[alias] = postings
      continue
    }
    const clean = restoreStars(alias)
    if (clean === alias || isDirtyAlias(clean)) {
      stats.droppedStarAlias++
      stats.starAliasDropped.push(alias)
      continue
    }
    renamed[clean] = renamed[clean] ? [...new Set([...renamed[clean], ...postings])] : postings
    stats.renamedStarAlias++
    stats.starAliasRenamed.push({ from: alias, to: clean, postings: postings.length })
  }
  return renamed
}

// ---------------------------------------------------------------------------
// Step 4 —— 5 张截断/机器字段人物卡，对照原文重写
// ---------------------------------------------------------------------------

const CARD_FIXES = [
  {
    id: 'm005596',
    section: 'character_states',
    name: '马尊',
    chapterOrdinals: [487, 488],
    quoteOrdinal: 488,
    card:
      '马尊是北原三大驭兽大师之一、马家少族长马英杰的族叔，以驭兽与奴道成名。他孩童时极少开口，沉默寡言到父母几乎以为他是哑巴；爱马成痴，少年时被族人戏称“马痴”“马呆子”；性情孤僻，一生未娶，只爱骏马，常年与马群生活在一起，对世俗权力和红尘杂务毫不关心。马英杰常借他的威信号令马家诸蛊师。',
    quote:
      '他性情孤僻，一生未娶，只爱骏马，常年和马群生活在一起。对世俗权力、红尘杂务一点都不关心，也没有丝毫的兴趣。',
  },
  {
    id: 'm006375',
    section: 'character_states',
    name: '黑楼兰',
    chapterOrdinals: [1001],
    quoteOrdinal: 1001,
    card:
      '黑楼兰身具十绝大力真武体，已是六转力道蛊仙，与方源订有盟约，背后有黎山仙子、焚天魔女撑腰。方源接管惊鸿乱斗台、面对被镇压的八转大力真武仙僵时，曾权衡是否放弃此处、日后改去谋害黑楼兰：只要盟约时限一到，或用信道手段破除盟约便可动手。但他自知尚无把握对付这三位女蛊仙，且盟约初签、夜长梦多，遂决定先镇压义天山这尊八转仙僵。',
    quote: '就算黑楼兰和方源之间，签订了盟约。但只要盟约时限一到，或者动用信道手段破除盟约，方源也可以对付黑楼兰。',
  },
  {
    id: 'm006377',
    section: 'character_states',
    name: '监天塔主',
    chapterOrdinals: [1002],
    quoteOrdinal: 1002,
    card:
      '监天塔主是天庭蛊仙之首，手持拐杖，执掌九转仙蛊屋监天塔。为应对义天山变局，他召集十三位八转蛊仙，携监天塔跨越五域界壁、昼夜兼程赶到现场。他借监天塔俯瞰战场，看出十绝仙僵无生大阵以人为阵、本质是战场杀招，只差最后一位力道十绝仙僵；因薄青等人尚未现身，他按兵不动，等对手先消耗。',
    quote: '监天塔主手持拐杖，借助监天塔，他的目光透射出去，将底下的战场种种映入心中。',
  },
  {
    id: 'm006387',
    section: 'character_states',
    name: '黑楼兰',
    chapterOrdinals: [1005],
    quoteOrdinal: 1005,
    card:
      '黑楼兰与黎山仙子同藏于太白云生的仙窍，被方源在义天山战场唤出助战。她当面讥讽方源“你可真会作死”，语气里却带着隐隐钦佩；因新盟约约束，她与黎山仙子不得不替方源出力，但眼看影宗与天庭两方厮杀，心中都在打鼓。',
    quote: '环顾一周，黑楼兰道：“方源，你可真会作死。”语气中，却是带着隐隐的钦佩。',
  },
  {
    id: 'm008611',
    section: 'character_states',
    name: '方源',
    chapterOrdinals: [10],
    quoteOrdinal: 10,
    card:
      '第11章时方源已开窍，是一转初阶蛊师、丙等资质，仍住古月山寨。舅父舅母派贴身丫鬟沈翠以酒菜色诱陷害，他识破后掐住其脖颈逼问，念旧情放她离开，随即搬出原住处，住进山寨唯一的客栈，付两块元石订下上房，准备在大厅用饭后出寨探索花酒行者遗藏。手头仅剩四块元石，正为炼化月光蛊、以及日后若寻得酒虫的开销发愁。',
    quote: '“念在你作为贴身丫鬟，服侍我这么多年的份上，我这次就不杀你了。你不是想脱离奴籍么，去找我弟弟吧，他可是又傻又天真。”',
    validFrom: 11,
    validTo: 14,
  },
]

function applyCardFixes(sections, novel, stats) {
  for (const fix of CARD_FIXES) {
    const list = sections[fix.section] ?? []
    const card = list.find((c) => c._id === fix.id)
    if (!card) throw new Error(`找不到待修复卡片 ${fix.id}`)
    const anchored = reanchorQuote(novel, fix.quoteOrdinal, fix.quote)
    if (!anchored) throw new Error(`修复卡 ${fix.id} 的引文无法在 ch${fix.quoteOrdinal + 1} 原文中逐字定位`)
    const nextValidFrom = fix.validFrom ?? card.valid_from
    const nextValidTo = fix.validTo ?? card.valid_to
    stats.fixedCards.push({
      _id: fix.id,
      section: fix.section,
      name: fix.name,
      before: { name: card.name ?? '', card: card.card, ch: card.ch ?? [], valid_from: card.valid_from, valid_to: card.valid_to },
      after: { name: fix.name, card: fix.card, ch: fix.chapterOrdinals, valid_from: nextValidFrom, valid_to: nextValidTo },
      quote: anchored.quote,
      quote_offset: anchored.offset,
      quote_len: anchored.quote.length,
      chapter_id: chapterIdOf(fix.quoteOrdinal),
    })
    card.name = fix.name
    card.card = fix.card
    card.ch = fix.chapterOrdinals
    if (nextValidFrom !== undefined) card.valid_from = nextValidFrom
    if (nextValidTo !== undefined) card.valid_to = nextValidTo
    card.__evQuotes = [{ chapterOrdinal: fix.quoteOrdinal, quote: anchored.quote, offset: anchored.offset }]
    card.__evReplace = true
  }
}

/** 剩余 character_states 的 … 尾巴：通用规则 + 3 张手工裁定的确定性补丁（只删残句，不改事实）。 */
const ELLIPSIS_OVERRIDES = {
  m005336:
    '卫德馨：身份 卫家（原）族长夫人、奴隶；实力 未知（原卫家族长夫人，懂经营）；势力 原卫家（现为商家奴隶）；关系 卫家原族长之妻、亲弟为卫神经；性别 女；外貌 脸有污垢但艳丽（"水蜜桃般"）。',
  m005928:
    '星宿仙尊：身份 蛊师历史上十大尊者之一；少见的女性九转蛊仙；智道祖师爷、开创星道；天庭二代仙王；实力 九转；势力 天庭；关系 梦中压迫方源等三人；性别 女；外貌 深蓝长袍、秀发如灿烂银河；性格 高傲、居高临下。',
  m007067:
    '蒙屠：身份 蒙家七转蛊仙、战力巅峰、刀道准大宗师（数百年未突破大宗师）、蒙家战力支柱之一；实力 七转；势力 北原超级势力蒙家；关系 蒙自在之族兄、受族中敬重；性别 男；外貌 身材魁梧，皮肤红铜色泽，穿马甲露肩赤脚；性格 坚忍沉默。',
}

function cleanEllipsisCards(sections, stats) {
  for (const card of sections.character_states ?? []) {
    const text = String(card.card ?? '')
    if (!text.includes('…')) continue
    let out = ELLIPSIS_OVERRIDES[card._id] ?? text
      .replace(/，\s*…\s*(?=[；;])/g, '')
      .replace(/，\s*…\s*(?=[。])/g, '。')
      .replace(/…+/g, '，')
      .replace(/，\s*；/g, '；')
      .replace(/；\s*，/g, '；')
      .replace(/，{2,}/g, '，')
      .replace(/，\s*。/g, '。')
      .replace(/^\s*，/g, '')
    out = out.trim()
    if (!/[。！？]/.test(out.slice(-1))) out += '。'
    card.card = out
    stats.ellipsisCleanedCards++
    stats.ellipsisExamples.push({ _id: card._id, before: text.slice(0, 90), after: out.slice(0, 90) })
  }
}

// ---------------------------------------------------------------------------
// Step 5 —— 6 个空白章节
// ---------------------------------------------------------------------------

const NEW_CHAPTER_CARDS = [
  {
    _id: 'p2:ev:ch0028:1',
    ordinal: 27,
    name: '方源堵门勒索同窗元石',
    card:
      '方源在古月山寨学堂大门口堵门斗殴，专砍同窗左右侧脖颈致其昏厥而不伤性命，随后向倒地者每人勒索一块元石，连亲弟古月方正也不放过。全班五十七人共被勒索五十六块，方源手头元石增至七十九块。学堂家老全程旁观，认为他下手有分寸、只取一块未越底线，反而借机敲打侍卫、革去妄议主子的头目之职。',
    keys: ['方源', '古月学堂', '元石', '古月方正', '学堂家老'],
    quote: '迫于方源的淫威，他们只好一个个低下头，搜出地上少年们的钱袋，并从中取出一块元石。然后汇集到一起，交给方源。',
  },
  {
    _id: 'p2:ev:ch0521:1',
    ordinal: 520,
    name: '费才偷鞋翻盘',
    card:
      '费家灭亡后，费才沦为马家少族长马英杰的贴身奴仆，被老奴设局诱他偷走少族长的鞋，欲借盗窃罪将他处死。赵怜云指点他应对：费才不辩偷窃，反称用全部积蓄买真绸裹鞋、贴胸为少族长暖脚。马英杰有洁癖又重“英明仁爱”之名，闻言转怒为喜，命侦察蛊师彻查，查出老奴们才是惯偷并全部发配辎重营，费才反被擢升为奴仆长。',
    keys: ['费才', '马英杰', '赵怜云', '偷鞋', '奴仆长'],
    quote: '费才答道：“小人只顾着为少族长大人暖鞋，却忘了若是大人您要出去时，会极不方便。小人有罪，请大人您责罚吧！”',
  },
  {
    _id: 'p2:ev:ch1455:1',
    ordinal: 1454,
    name: '方源年蛊价格战震动宝黄天',
    card:
      '方源以匿名第四卖家身份在宝黄天抛售年蛊，凭优质货源连续降价，逼得谢宝树、荣欣、王明月三大卖家步步跟进平价。荣欣存货最少，既想大幅降价争取补货时间，又怕暴露底细。方源随后两次加大降幅，第四次降价狠狠压缩年蛊贸易利润，令三大卖方若跟进便伤筋动骨，宝黄天为之震动。',
    keys: ['方源', '年蛊', '宝黄天', '谢宝树', '荣欣', '王明月'],
    quote: '方源这一次降价，极大地缩减了年蛊贸易利润，对于三大卖方而言，若是他们跟进，无一不伤筋动骨！',
  },
]

/** 页码重复导致的空章：正文本在前一个 ordinal 的同名小节里。 */
const PAGE_SPLIT_ALIASES = [
  { emptyOrdinal: 1213, bodyOrdinal: 1212, preferId: 'm013163' }, // 同名小节卡「仙缘生意」
  { emptyOrdinal: 2030, bodyOrdinal: 2029 },
  { emptyOrdinal: 2038, bodyOrdinal: 2037, preferId: 'm021642' }, // 「强弱」→ 强蛊卡
]

function applyBlankChapterCards(sections, novel, stats) {
  for (const item of NEW_CHAPTER_CARDS) {
    const anchored = reanchorQuote(novel, item.ordinal, item.quote)
    if (!anchored) throw new Error(`新卡 ${item._id} 的引文无法在 ch${item.ordinal + 1} 原文中逐字定位`)
    const chapterNo = item.ordinal + 1
    const card = {
      _id: item._id,
      name: item.name,
      card: item.card,
      ch: [item.ordinal],
      keys: item.keys,
      state_kind: 'event',
      valid_from: chapterNo,
      valid_to: chapterNo,
      section: 'events',
      __evQuotes: [{ chapterOrdinal: item.ordinal, quote: anchored.quote, offset: anchored.offset }],
    }
    sections.events.push(card)
    stats.newChapterCards.push({
      _id: item._id,
      chapter: chapterNo,
      ch: [item.ordinal],
      name: item.name,
      card: item.card,
      quote: anchored.quote,
      quote_offset: anchored.offset,
      quote_len: anchored.quote.length,
      chapter_id: chapterIdOf(item.ordinal),
    })
  }

  for (const alias of PAGE_SPLIT_ALIASES) {
    const candidates = []
    for (const section of CONTENT_SECTIONS) {
      for (const card of sections[section] ?? []) {
        if (Array.isArray(card.ch) && card.ch.includes(alias.bodyOrdinal)) candidates.push(card)
      }
    }
    if (!candidates.length) {
      stats.pageSplitAliases.push({ ...alias, attachedTo: null })
      continue
    }
    const target =
      (alias.preferId && candidates.find((c) => c._id === alias.preferId)) ??
      candidates.sort((a, b) => String(b.card).length - String(a.card).length)[0]
    if (!target.ch.includes(alias.emptyOrdinal)) target.ch.push(alias.emptyOrdinal)
    target.ch = uniq(target.ch).sort((a, b) => a - b)
    stats.pageSplitAliases.push({
      ...alias,
      attachedTo: target._id,
      attachedName: target.name ?? '',
      attachedCard: target.card,
      attachedCh: target.ch,
      evidence: {
        emptyTitle: chapterOf(novel, alias.emptyOrdinal)?.title ?? null,
        bodyTitle: chapterOf(novel, alias.bodyOrdinal)?.title ?? null,
        emptyChars: normSpace(chapterOf(novel, alias.emptyOrdinal)?.cleanBodyText ?? '').length,
        bodyChars: normSpace(chapterOf(novel, alias.bodyOrdinal)?.cleanBodyText ?? '').length,
      },
    })
  }
}

// ---------------------------------------------------------------------------
// Step 6 —— 缺章卡定位 + 章内确定性引文回填
// ---------------------------------------------------------------------------

const STOP_CHARS = new Set(
  '的了是在和与他她它我你您这那个之也就都很不没为以对而但所以如因什么自己会能要可有被把从到给让使还又再才只更最太过着说过做看知觉等一'.split('')
)

const GENERIC_NAMES = new Set(['方源', '蛊师', '蛊虫', '希望蛊', '天庭', '北原', '南疆', '中洲', '东海', '西漠'])

const CHATTER_TEST_RE =
  /(?:ps[:：]|PS[:：]|备注[:：]|求月票|呼唤月票|书友群|打赏|评价票|加入书签|未完待续|第\d+\s*\/\s*\d+\s*页|记住手机版)/

function extractSignals(card) {
  const name = String(card.name ?? '').trim()
  const raw = `${name}。${String(card.card ?? '')}`
  const cleanedText = raw.replace(/(?:Action|Why|Content|Impact|Result|Type|People|Setting|Display|Who|What|Category|Name|Identity|Alias|Profile|Goal|State|Effect)[:：]/g, '。')

  const bigrams = new Set()
  for (const run of cleanedText.match(/[\u3400-\u4dbf\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) {
      const bg = run.slice(i, i + 2)
      if (STOP_CHARS.has(bg[0]) || STOP_CHARS.has(bg[1])) continue
      bigrams.add(bg)
    }
  }

  const anchors = new Set()
  if (name.length >= 2 && name.length <= 8 && CJK_RE.test(name) && !GENERIC_NAMES.has(name)) anchors.add(name)
  for (const key of card.keys ?? []) {
    const k = String(key).trim()
    if (k.length >= 2 && k.length <= 8 && CJK_RE.test(k) && !GENERIC_NAMES.has(k)) anchors.add(k)
  }
  return { name, anchors, bigrams }
}

function sentenceSpans(text) {
  const spans = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '。' || ch === '！' || ch === '？' || ch === '…' || ch === '”' || ch === '」' || ch === '』') {
      let end = i + 1
      while (end < text.length && /[”」』)）]/.test(text[end])) end++
      spans.push({ start, end })
      start = end
    }
  }
  if (start < text.length) spans.push({ start, end: text.length })
  return spans
}

const spanCache = new Map()
function spansOf(chapter) {
  if (!spanCache.has(chapter.ordinal)) spanCache.set(chapter.ordinal, sentenceSpans(chapter.cleanBodyText))
  return spanCache.get(chapter.ordinal)
}

function trimmedText(text, start, end) {
  let s = start
  let e = end
  while (s < e && /\s/.test(text[s])) s++
  while (e > s && /\s/.test(text[e - 1])) e--
  return { start: s, end: e, text: text.slice(s, e) }
}

function scoreCandidate(quote, signals) {
  let anchorHits = 0
  let nameHit = false
  for (const anchor of signals.anchors) {
    if (quote.includes(anchor)) {
      anchorHits++
      if (anchor === signals.name) nameHit = true
    }
  }
  const hits = countBigramHits(quote, signals.bigrams)
  // 分母取 min(总 bigram, 10)：保证「命中 >= 5」与「覆盖率 >= 0.45」两条门禁自洽
  const coverage = hits.distinct / Math.min(signals.bigrams.size || 1, 10)
  return { anchorHits, nameHit, bigramHits: hits.distinct, coverage, strongFragments: hits.runs }
}

/** 去重 bigram 命中数 + 互不重叠的实词片段数（用于「≥3 个非停用词实词片段」门禁）。 */
function countBigramHits(quote, bigrams) {
  const hitSet = new Set()
  let runs = 0
  let i = 0
  while (i + 1 < quote.length) {
    const bg = quote.slice(i, i + 2)
    if (bigrams.has(bg)) {
      hitSet.add(bg)
      runs++
      i += 2
    } else {
      i += 1
    }
  }
  return { distinct: hitSet.size, runs }
}

function pickEvidenceInChapter(card, chapter, signals, limits) {
  const minLen = limits?.minLen ?? 25
  const maxLen = limits?.maxLen ?? 140
  const spans = spansOf(chapter)
  let best = null
  let raw = null
  for (let i = 0; i < spans.length; i++) {
    for (let k = 1; k <= 2; k++) {
      if (i + k - 1 >= spans.length) break
      const from = spans[i].start
      const to = spans[i + k - 1].end
      if (to - from > maxLen + 40) continue
      const trimmed = trimmedText(chapter.cleanBodyText, from, to)
      // 逐字引文必须保持原文（含段内空白），跨段落的候选直接跳过，保证引文是单段连续原文
      if (/[\r\n]/.test(trimmed.text)) continue
      const quote = trimmed.text
      if (quote.length < minLen || quote.length > maxLen) continue
      if (!CJK_RE.test(quote)) continue
      if (CHATTER_TEST_RE.test(quote)) continue
      if (HAS_KNOWN_STAR_RE.test(quote)) continue
      if (!/^[“"「『（(]?[\u3400-\u4dbf\u4e00-\u9fff]/.test(quote)) continue
      const score = scoreCandidate(quote, signals)
      const total = score.bigramHits + score.anchorHits * 3 + score.coverage * 6
      if (!raw || total > raw.total) raw = { chapterOrdinal: chapter.ordinal, quote, offset: trimmed.start, total, ...score }
      const passes =
        (score.nameHit || score.anchorHits >= 3 || score.strongFragments >= 3) &&
        ((score.bigramHits >= 5 && score.coverage >= 0.45) ||
          (score.anchorHits >= 1 && score.bigramHits >= 4) ||
          (score.bigramHits >= 4 && score.coverage >= 0.4 && score.strongFragments >= 4))
      if (!passes) continue
      if (!best || total > best.total) {
        best = {
          chapterOrdinal: chapter.ordinal,
          quote,
          offset: trimmed.start,
          total,
          ...score,
        }
      }
    }
  }
  return { best, raw }
}

function backfillEvidence(sections, novel, stats) {
  const backfilled = []
  const NEGATIVE_CARD_RE = /无新人物(?:本章)?出场|无新角色(?:本章)?出场|本章无新人物/
  for (const section of CONTENT_SECTIONS) {
    for (const card of sections[section] ?? []) {
      if (card.__evReplace) continue
      if (Array.isArray(card.__evQuotes) && card.__evQuotes.length) continue
      const ch = Array.isArray(card.ch) ? card.ch : []
      if (!ch.length) continue
      if (Array.isArray(card.ev) && card.ev.length) continue
      if (NEGATIVE_CARD_RE.test(String(card.card ?? '').slice(0, 40))) {
        stats.evBackfillSkippedNegative++
        continue
      }
      const signals = extractSignals(card)
      if (signals.bigrams.size < 6 && signals.anchors.size === 0) continue
      let best = null
      let rawBest = null
      for (const ordinal of ch) {
        const chapter = chapterOf(novel, ordinal)
        if (!chapter) continue
        const candidate = pickEvidenceInChapter(card, chapter, signals)
        if (candidate.best && (!best || candidate.best.total > best.total)) best = candidate.best
        if (candidate.raw && (!rawBest || candidate.raw.total > rawBest.total)) rawBest = candidate.raw
      }
      if (!best) {
        stats.evBackfillMiss++
        if (process.env.P2_DEBUG) {
          const key = `${rawBest?.bigramHits ?? 0}`
          stats.evMissHist[key] = (stats.evMissHist[key] ?? 0) + 1
          stats.evMissBySection[section] = (stats.evMissBySection[section] ?? 0) + 1
          if (stats.evMissDebug.length < 8 && section !== 'calibrated_cards') {
            stats.evMissDebug.push({
              section,
              _id: card._id,
              name: card.name ?? '',
              anchors: [...signals.anchors],
              bigrams: signals.bigrams.size,
              rawQuote: rawBest?.quote?.slice(0, 90) ?? null,
              raw: rawBest ? { hits: rawBest.bigramHits, coverage: Number(rawBest.coverage.toFixed(2)), frags: rawBest.strongFragments, anchors: rawBest.anchorHits } : null,
            })
          }
        }
        continue
      }
      card.__evQuotes = [{ chapterOrdinal: best.chapterOrdinal, quote: best.quote, offset: best.offset, score: Number(best.total.toFixed(3)) }]
      stats.evBackfill++
      backfilled.push({
        section,
        _id: card._id,
        name: card.name ?? '',
        chapter_id: chapterIdOf(best.chapterOrdinal),
        card: String(card.card).slice(0, 120),
        matched_quote: best.quote,
        offset: best.offset,
        score: Number(best.total.toFixed(3)),
        bigram_hits: best.bigramHits,
        coverage: Number(best.coverage.toFixed(3)),
        anchor_hits: best.anchorHits,
      })
    }
  }
  stats.evBackfilledSamples = backfilled
  return backfilled
}

/** 无 ch 的残余卡：先用 name/keys 锚点定位；锚点不足的再用 4-gram 稀有片段定位。 */
function locateMissingChapters(sections, novel, stats) {
  const located = []
  const chapterLens = novel.chapters.map((c) => normSpace(c.cleanBodyText).length)
  const pending = []

  for (const section of CONTENT_SECTIONS) {
    for (const card of sections[section] ?? []) {
      if (Array.isArray(card.ch) && card.ch.length) continue
      if (section === 'calibrated_cards') continue
      const signals = extractSignals(card)
      const anchors = [...signals.anchors].filter((a) => a.length >= 2)
      if (anchors.length < 2) {
        pending.push({ section, card, signals })
        continue
      }

      const scoreByChapter = new Map()
      let totalWeight = 0
      for (const anchor of anchors) {
        const occurrences = []
        let idx = 0
        while ((idx = novel.text.indexOf(anchor, idx)) >= 0) {
          occurrences.push(idx)
          idx += anchor.length
        }
        if (!occurrences.length) continue
        const weight = 1 / (1 + Math.log10(occurrences.length + 1))
        totalWeight += weight
        for (const off of occurrences) {
          const ordinal = ordinalAt(novel, off)
          if (chapterLens[ordinal] < 300) continue
          scoreByChapter.set(ordinal, (scoreByChapter.get(ordinal) ?? 0) + weight)
        }
      }
      if (!scoreByChapter.size) {
        pending.push({ section, card, signals })
        continue
      }
      const ranked = [...scoreByChapter].sort((a, b) => b[1] - a[1])
      const best = ranked[0]
      const second = ranked[1]?.[1] ?? 0
      const ratio = best[1] / Math.max(1e-9, totalWeight)
      if (ratio < 0.6 || best[1] < 0.15 || best[1] < second * 1.8) {
        pending.push({ section, card, signals })
        continue
      }
      if (!tryAttachChapter(novel, card, signals, best[0], stats, located, section, ratio, best[1] / Math.max(second, 1e-9))) {
        pending.push({ section, card, signals })
      }
    }
  }

  if (!pending.length) return located

  // 4-gram 稀有片段定位：一次扫描全书建立索引（只记录目标卡涉及的 4-gram）
  const gramSets = []
  const gramUnion = new Set()
  for (const item of pending) {
    const grams = new Set()
    const text = `${item.card.name ?? ''}。${item.card.card}`
    for (const run of text.match(/[\u3400-\u4dbf\u4e00-\u9fff]{4,}/g) ?? []) {
      for (let i = 0; i + 4 <= run.length; i++) grams.add(run.slice(i, i + 4))
    }
    gramSets.push(grams)
    for (const g of grams) gramUnion.add(g)
  }
  if (!gramUnion.size) {
    for (const item of pending) stats.chLocateSkipped.push({ _id: item.card._id, reason: 'anchors<2' })
    return located
  }

  const index = new Map()
  for (const g of gramUnion) index.set(g, [])
  const text = novel.text
  for (let i = 0; i + 4 <= text.length; i++) {
    const gram = text.slice(i, i + 4)
    const bucket = index.get(gram)
    if (bucket && bucket.length < 400) bucket.push(i)
  }

  pending.forEach((item, idx) => {
    const grams = gramSets[idx]
    const candidates = []
    for (const gram of grams) {
      const bucket = index.get(gram)
      if (!bucket || bucket.length === 0 || bucket.length > 60) continue
      candidates.push({ gram, count: bucket.length, offsets: bucket })
    }
    if (candidates.length < 2) {
      stats.chLocateSkipped.push({ _id: item.card._id, reason: 'no rare 4-gram' })
      return
    }
    candidates.sort((a, b) => a.count - b.count)
    const picked = candidates.slice(0, 5)
    const scoreByChapter = new Map()
    let totalWeight = 0
    for (const c of picked) {
      const weight = 1 / c.count
      totalWeight += weight
      for (const off of c.offsets) {
        const ordinal = ordinalAt(novel, off)
        if (chapterLens[ordinal] < 300) continue
        scoreByChapter.set(ordinal, (scoreByChapter.get(ordinal) ?? 0) + weight)
      }
    }
    if (!scoreByChapter.size) {
      stats.chLocateSkipped.push({ _id: item.card._id, reason: '4-gram no chapter' })
      return
    }
    const ranked = [...scoreByChapter].sort((a, b) => b[1] - a[1])
    const best = ranked[0]
    const second = ranked[1]?.[1] ?? 0
    const ratio = best[1] / Math.max(1e-9, totalWeight)
    if (best[1] < 0.35 || best[1] < second * 1.6) {
      stats.chLocateSkipped.push({ _id: item.card._id, reason: `4-gram weak(${ratio.toFixed(2)})` })
      return
    }
    if (!tryAttachChapter(novel, item.card, item.signals, best[0], stats, located, item.section, ratio, best[1] / Math.max(second, 1e-9))) {
      stats.chLocateSkipped.push({ _id: item.card._id, reason: 'located but no quote' })
    }
  })

  return located
}

function tryAttachChapter(novel, card, signals, ordinal, stats, located, section, ratio, margin) {
  const chapter = chapterOf(novel, ordinal)
  const pick = pickEvidenceInChapter(card, chapter, signals)
  const candidate = pick.best
  if (!candidate) return false
  card.ch = [ordinal]
  card.__evQuotes = [{ chapterOrdinal: ordinal, quote: candidate.quote, offset: candidate.offset, score: Number(candidate.total.toFixed(3)) }]
  stats.chLocated++
  located.push({
    section,
    _id: card._id,
    name: card.name ?? '',
    chapter: ordinal + 1,
    chapter_id: chapterIdOf(ordinal),
    match_ratio: Number(ratio.toFixed(3)),
    margin: Number(Number(margin).toFixed(2)),
    score: Number(candidate.total.toFixed(3)),
    quote: candidate.quote,
    offset: candidate.offset,
  })
  return true
}

let ordinalIndexBuilt = false
const ordinalStarts = []
function buildOrdinalIndex(novel) {
  if (ordinalIndexBuilt) return
  for (const c of novel.chapters) ordinalStarts.push(c.start)
  ordinalIndexBuilt = true
}

function ordinalAt(novel, offset) {
  buildOrdinalIndex(novel)
  let lo = 0
  let hi = ordinalStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ordinalStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

// ---------------------------------------------------------------------------
// Step 7 —— evidence 重建 / 全局去重 / 致密重索引
// ---------------------------------------------------------------------------

const POINTER_RE = /^(?:micro|macro|ev|evidence|quote|ref|src|ch|anchor|card|m\d)[:：]?[\w:.-]*$/i
const HAS_KNOWN_STAR_RE = /\*{2,}运|五行\*{2,}师|爱\*{2,}/

function rebuildAll(sections, sourceKb, novel, stats, srcAliases) {
  // 7.1 evidence 重建：只从幸存卡的既定引文建表 → 天然 0 孤儿行
  const catalog = []
  const keyToIndex = new Map()
  const evQuotesByCard = new Map()

  const addEvidence = (chapterId, quote, typeCode) => {
    const key = `${chapterId}|${quote}`
    if (keyToIndex.has(key)) {
      stats.evidenceDedupeHits++
      return keyToIndex.get(key)
    }
    const idx = catalog.length
    catalog.push([chapterId, typeCode || 'Q', quote, null, null])
    keyToIndex.set(key, idx)
    return idx
  }

  const oldEvidence = sourceKb.evidence_catalog ?? []

  for (const section of SECTIONS) {
    if (section === 'conflicts') continue
    for (const card of sections[section] ?? []) {
      const picked = []
      const seen = new Set()

      if (card.__evReplace) {
        for (const entry of card.__evQuotes ?? []) {
          const idx = addEvidence(chapterIdOf(entry.chapterOrdinal), entry.quote)
          const key = String(idx)
          if (seen.has(key)) continue
          seen.add(key)
          picked.push(idx)
        }
      } else {
        // 先处理本轮新回填的引文（高优先），再补旧引文
        for (const entry of card.__evQuotes ?? []) {
          const idx = addEvidence(chapterIdOf(entry.chapterOrdinal), entry.quote)
          const key = String(idx)
          if (seen.has(key)) continue
          seen.add(key)
          picked.push(idx)
        }
        for (const oldIdx of card.ev ?? []) {
          if (picked.length >= 2) break
          if (!Number.isInteger(oldIdx) || oldIdx < 0 || oldIdx >= oldEvidence.length) continue
          const row = oldEvidence[oldIdx]
          const rawQuote = String(row[2] ?? '').trim()
          if (!rawQuote) {
            stats.evidenceDroppedEmpty++
            continue
          }
          if (rawQuote.length <= 32 && POINTER_RE.test(rawQuote)) {
            stats.evidenceDroppedPointer++
            continue
          }
          const ordinal = Number(/^ch(\d+)$/.exec(String(row[0]))?.[1] ?? 0) - 1
          if (ordinal < 0 || ordinal >= novel.chapters.length) {
            stats.evidenceDroppedBadChapter++
            continue
          }
          const cleaned = cleanEvidenceQuote(rawQuote)
          if (!cleaned || cleaned.length < 8) {
            stats.evidenceDroppedChatter++
            continue
          }
          // 先用「原引文」在原文里验真（原文本身带星号时也能逐字对上），
          // 锚定成功后再做星号词还原入库，避免把真引文误判成星号残留而丢弃。
          let anchored = reanchorQuote(novel, ordinal, cleaned)
          if (!anchored) anchored = reanchorQuote(novel, ordinal, restoreStars(cleaned))
          if (!anchored) {
            stats.evidenceDroppedUnverifiable++
            stats.unverifiableExamples.push({ chapter_id: String(row[0]), quote: cleaned.slice(0, 90) })
            continue
          }
          const finalQuote = restoreStars(anchored.quote)
          if (HAS_KNOWN_STAR_RE.test(finalQuote)) {
            stats.evidenceDroppedStar++
            continue
          }
          const idx = addEvidence(String(row[0]), finalQuote, String(row[1] ?? 'Q'))
          const key = String(idx)
          if (seen.has(key)) continue
          seen.add(key)
          picked.push(idx)
          if (String(row[1] ?? 'Q') !== 'Q') stats.nonQTypes.add(String(row[1]))
        }
      }

      card.__finalEv = picked.slice(0, 2)
      evQuotesByCard.set(card._id, card.__finalEv)
    }
  }

  stats.evidenceRowsBefore = oldEvidence.length
  stats.evidenceRowsAfter = catalog.length

  // 7.2 致密 catalog
  const mobileCardCatalog = []
  const newOrdinalByCardId = new Map()
  const kindByCardId = new Map()
  const oldCatalogById = new Map()
  for (const row of sourceKb.mobile_card_catalog ?? []) {
    oldCatalogById.set(String(row[1]), { kind: String(row[2] ?? ''), priorityRank: Number(row[3]) })
  }

  let nextOrdinal = 0
  for (const section of SECTIONS) {
    if (section === 'conflicts') continue
    for (const card of sections[section] ?? []) {
      const meta = oldCatalogById.get(card._id)
      const kind = section === 'calibrated_cards' ? 'calibrated' : meta?.kind || section
      const priorityRank =
        section === 'calibrated_cards'
          ? 4
          : Number.isFinite(meta?.priorityRank) && meta.priorityRank > 0
            ? meta.priorityRank
            : section === 'entities' || section === 'events' || section === 'items_and_gu'
              ? 3
              : 2
      mobileCardCatalog.push([nextOrdinal, card._id, kind, priorityRank, 1])
      newOrdinalByCardId.set(card._id, nextOrdinal)
      kindByCardId.set(card._id, kind)
      nextOrdinal++
    }
  }

  // 7.3 router aliases（旧 ordinal → 旧 cardId → 幸存 cardId → 新 ordinal）
  const oldOrdinalToId = new Map()
  for (const row of sourceKb.mobile_card_catalog ?? []) oldOrdinalToId.set(Number(row[0]), String(row[1]))
  const survivors = new Set(newOrdinalByCardId.keys())
  const aliases = {}
  let aliasPostings = 0
  for (const [alias, postings] of Object.entries(srcAliases ?? {})) {
    const ids = new Set()
    for (const p of postings) {
      const oldId = oldOrdinalToId.get(Number(p))
      if (oldId && survivors.has(oldId)) ids.add(oldId)
    }
    if (!ids.size) continue
    if (isDirtyAlias(alias)) continue
    const ordinals = []
    for (const id of ids) ordinals.push(newOrdinalByCardId.get(id))
    aliases[alias] = uniq(ordinals).sort((a, b) => a - b)
    aliasPostings += aliases[alias].length
  }

  stats.aliasBefore = Object.keys(sourceKb.mobile_router?.aliases ?? {}).length
  stats.aliasAfter = Object.keys(aliases).length
  stats.aliasPostings = aliasPostings
  stats.aliasSourceAfterStars = Object.keys(srcAliases ?? {}).length

  return { catalog, aliases, mobileCardCatalog, newOrdinalByCardId, kindByCardId }
}

function cleanEvidenceQuote(raw) {
  let quote = String(raw ?? '').trim()
  // 站内页脚 / 未完待续
  quote = quote.replace(/\s*[（(]?\s*未完待续[。.]?\s*[）)]?\s*$/, '')
  quote = quote.replace(/记住手机版网址[：:][\s\S]*$/, '')
  quote = quote.replace(/加入书签[\s\S]*$/, '')
  quote = quote.replace(/第\d+\s*\/\s*\d+\s*页/g, '')
  // 作者备注：从 ps / 备注 / 括号 ps 起裁掉尾部
  const noteIdx = quote.search(/\s*(?:[（(]\s*)?(?:ps|Ps|PS|备注)\s*[:：]/)
  if (noteIdx > 0) quote = quote.slice(0, noteIdx)
  quote = quote.trim()
  // 整条就是作者杂谈的（求票/书友群/打赏/评价票/页码）直接丢弃
  if (/(?:感谢[\s\S]{0,60}(?:打赏|评价票))|书友群|求月票|呼唤月票|第\d+\s*\/\s*\d+\s*页/.test(quote) && quote.length < 120) return ''
  return quote
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function enrich(inputPath, novelPath) {
  const kb = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
  const novel = parseNovel(novelPath, kb)
  const stats = {
    novel: novel.stats,
    droppedMachineCard: 0,
    droppedAuthorChatterCard: 0,
    unwrappedRecCard: 0,
    droppedRecShellEmpty: 0,
    deletedIds: [],
    machineExamples: [],
    starCards: 0,
    starCardDetails: [],
    starAliasRenamed: [],
    starAliasDropped: [],
    renamedStarAlias: 0,
    droppedStarAlias: 0,
    fixedCards: [],
    ellipsisCleanedCards: 0,
    ellipsisExamples: [],
    newChapterCards: [],
    pageSplitAliases: [],
    evBackfill: 0,
    evBackfillMiss: 0,
    evMissDebug: [],
    evMissHist: {},
    evMissBySection: {},
    chLocated: 0,
    chLocateSkipped: [],
    evidenceRowsBefore: 0,
    evidenceRowsAfter: 0,
    evidenceDroppedEmpty: 0,
    evidenceDroppedPointer: 0,
    evidenceDroppedBadChapter: 0,
    evidenceDroppedChatter: 0,
    evidenceDroppedUnverifiable: 0,
    evidenceDedupeHits: 0,
    evBackfillSkippedNegative: 0,
    evidenceDroppedStar: 0,
    unverifiableExamples: [],
    nonQTypes: new Set(),
    aliasBefore: 0,
    aliasAfter: 0,
    aliasPostings: 0,
  }

  const sections = {}
  for (const section of SECTIONS) {
    sections[section] = []
    for (const card of kb[section] ?? []) sections[section].push({ ...card, section })
  }

  cleanMachineCards(sections, stats)

  const routerAfterStars = cleanStars(sections, kb.mobile_router?.aliases ?? {}, stats)
  stats.aliasAfterStars = Object.keys(routerAfterStars).length

  applyCardFixes(sections, novel, stats)
  cleanEllipsisCards(sections, stats)
  applyBlankChapterCards(sections, novel, stats)

  const located = locateMissingChapters(sections, novel, stats)
  const backfilled = backfillEvidence(sections, novel, stats)

  const rebuilt = rebuildAll(sections, kb, novel, stats, routerAfterStars)

  // 组装输出
  const out = {
    format: 'GUR-KB-SINGLE-2.0-COMPACT',
    manifest: {
      ...(kb.manifest ?? {}),
      kb_version: KB_VERSION,
      enriched_from: ENRICHED_FROM,
      parent_chapter_span: 1,
      novel_source: 'G:\\workplace\\gur-backfill\\大爱-2.txt',
      line_policy: 'compact single-line json for chatbox JSON.parse',
    },
    runtime_core: kb.runtime_core,
    chapter_catalog: kb.chapter_catalog,
    evidence_catalog: rebuilt.catalog,
    mobile_card_catalog: rebuilt.mobileCardCatalog,
    mobile_router: { aliases: rebuilt.aliases },
    mobile_stats: {},
  }

  const kinds = {}
  for (const [, , kind] of rebuilt.mobileCardCatalog) kinds[kind] = (kinds[kind] ?? 0) + 1

  out.mobile_stats = {
    source_cards: (kb.mobile_card_catalog ?? []).length,
    retained_cards: rebuilt.mobileCardCatalog.length,
    replaced_machine_cards: stats.droppedMachineCard,
    dropped_author_chatter_card: stats.droppedAuthorChatterCard,
    unwrapped_rec_cards: stats.unwrappedRecCard,
    star_restored_cards: stats.starCards,
    fixed_truncated_cards: stats.fixedCards.length,
    new_chapter_cards: stats.newChapterCards.length,
    relocated_cards: stats.chLocated,
    evidence_backfilled: stats.evBackfill,
    evidence_rows: rebuilt.catalog.length,
    router_aliases: Object.keys(rebuilt.aliases).length,
    calibrated_cards: (sections.calibrated_cards ?? []).length,
    card_kinds: Object.fromEntries(Object.entries(kinds).sort((a, b) => a[0].localeCompare(b[0]))),
  }

  for (const section of SECTIONS) {
    if (section === 'conflicts') {
      out.conflicts = []
      continue
    }
    out[section] = (sections[section] ?? []).map((card) => projectCard(card))
  }

  return { out, stats, kb, novel, located, backfilled }
}

function projectCard(card) {
  const projected = { _id: card._id }
  if (card.name) projected.name = card.name
  projected.card = card.card
  const ch = uniq((card.ch ?? []).map(Number).filter((n) => Number.isInteger(n) && n >= 0))
  if (ch.length) projected.ch = ch.sort((a, b) => a - b)
  if (card.__finalEv?.length) projected.ev = card.__finalEv
  const keys = cleanKeys(card.keys)
  if (keys.length) projected.keys = keys
  const aliases = (card.aliases ?? []).map(String).filter((a) => a && CJK_RE.test(a))
  if (aliases.length) projected.aliases = aliases
  if (card.story_time) projected.story_time = card.story_time
  if (card.state_kind) projected.state_kind = card.state_kind
  if (Number.isFinite(Number(card.valid_from))) projected.valid_from = Number(card.valid_from)
  if (Number.isFinite(Number(card.valid_to))) projected.valid_to = Number(card.valid_to)
  return projected
}

// ---------------------------------------------------------------------------
// 审计报告
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildAuditReport({ out, stats, kb, novel, located, backfilled, outputBytes, indexMetrics }) {
  const countWithEvidence = (source) => {
    let n = 0
    for (const section of CONTENT_SECTIONS) {
      for (const card of source[section] ?? []) if (Array.isArray(card.ev) && card.ev.length) n++
    }
    return n
  }
  stats.cardsWithEvBefore = countWithEvidence(kb)
  stats.cardsWithEvAfter = countWithEvidence(out)
  const coverageBySection = {}
  for (const section of CONTENT_SECTIONS) {
    let before = 0
    let after = 0
    for (const card of kb[section] ?? []) if (Array.isArray(card.ev) && card.ev.length) before++
    for (const card of out[section] ?? []) if (Array.isArray(card.ev) && card.ev.length) after++
    const totalBefore = (kb[section] ?? []).length
    const totalAfter = (out[section] ?? []).length
    coverageBySection[section] = {
      cards_before: totalBefore,
      cards_after: totalAfter,
      with_ev_before: before,
      with_ev_after: after,
      coverage_before: `${((100 * before) / Math.max(1, totalBefore)).toFixed(1)}%`,
      coverage_after: `${((100 * after) / Math.max(1, totalAfter)).toFixed(1)}%`,
    }
  }
  const rng = mulberry32(SAMPLE_SEED)
  const shuffled = [...backfilled]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  const sample = shuffled.slice(0, 30)
  const h4Pool = backfilled.filter((x) => x.bigram_hits === 4)
  const h4Sample = h4Pool.slice(0, 20)

  // 章节覆盖
  const covered = new Set()
  for (const section of CONTENT_SECTIONS) {
    for (const card of stats.finalCards?.[section] ?? []) for (const ch of card.ch ?? []) covered.add(Number(ch))
  }

  return {
    generated_at: new Date().toISOString(),
    source: {
      kb_input: INPUT_REL,
      kb_output: OUTPUT_REL,
      novel: NOVEL_DEFAULT,
      kb_version: KB_VERSION,
      enriched_from: ENRICHED_FROM,
    },
    summary: {
      bytes: outputBytes,
      mib: Number((outputBytes / 1024 / 1024).toFixed(2)),
      cards_before: (kb.mobile_card_catalog ?? []).length,
      cards_after: out.mobile_card_catalog.length,
      chapters: novel.stats.chapterCount,
      timeline_matched: `${novel.stats.timelineMatched}/${novel.stats.timelineTotal}`,
      author_note_chars_stripped: novel.stats.authorNoteCharsRemoved,
      evidence_rows_before: stats.evidenceRowsBefore,
      evidence_rows_after: stats.evidenceRowsAfter,
      evidence_duplicates_removed: stats.evidenceDedupeHits,
      evidence_dropped: {
        empty: stats.evidenceDroppedEmpty,
        pointer: stats.evidenceDroppedPointer,
        bad_chapter: stats.evidenceDroppedBadChapter,
        chatter: stats.evidenceDroppedChatter,
        unverifiable: stats.evidenceDroppedUnverifiable,
        star: stats.evidenceDroppedStar,
      },
      evidence_backfilled: stats.evBackfill,
      evidence_backfill_miss: stats.evBackfillMiss,
      evidence_backfill_skipped_negative: stats.evBackfillSkippedNegative,
      cards_with_evidence_before: stats.cardsWithEvBefore,
      cards_with_evidence_after: stats.cardsWithEvAfter,
      evidence_coverage_before: `${((100 * stats.cardsWithEvBefore) / Math.max(1, (kb.mobile_card_catalog ?? []).length)).toFixed(1)}%`,
      evidence_coverage_after: `${((100 * stats.cardsWithEvAfter) / Math.max(1, out.mobile_card_catalog.length)).toFixed(1)}%`,
      evidence_coverage_by_section: coverageBySection,
      router_aliases_before: stats.aliasBefore,
      router_aliases_after: stats.aliasAfter,
      alias_postings: stats.aliasPostings,
      index_duration_ms: indexMetrics?.indexDurationMs ?? null,
      parent_count: indexMetrics?.parentCount ?? null,
      children_count: indexMetrics?.chunksCount ?? null,
    },
    machine_card_cleaning: {
      dropped: stats.droppedMachineCard,
      dropped_author_chatter_card: stats.droppedAuthorChatterCard,
      unwrapped_rec_cards: stats.unwrappedRecCard,
      dropped_rec_shell_empty: stats.droppedRecShellEmpty,
      deleted_ids: stats.deletedIds,
      examples: stats.machineExamples.slice(0, 20),
    },
    star_restoration: {
      cards: stats.starCards,
      renamed_aliases: stats.renamedStarAlias,
      dropped_aliases: stats.droppedStarAlias,
      card_details: stats.starCardDetails,
      alias_renamed: stats.starAliasRenamed,
      alias_dropped: stats.starAliasDropped,
      kept_starred: ['换魂**'],
    },
    fixed_truncated_cards: stats.fixedCards,
    ellipsis_cleanup: { cards: stats.ellipsisCleanedCards, examples: stats.ellipsisExamples },
    missing_6_chapters: {
      new_cards: stats.newChapterCards,
      page_split_aliases: stats.pageSplitAliases,
      all_six: [...stats.newChapterCards.map((c) => ({
        chapter: c.chapter,
        chapter_id: c.chapter_id,
        mode: 'new_event_card',
        card_id: c._id,
        card: c.card,
        quote: c.quote,
        quote_offset: c.quote_offset,
        quote_len: c.quote_len,
      })),
      ...stats.pageSplitAliases.map((a) => ({
        chapter: a.emptyOrdinal + 1,
        chapter_id: chapterIdOf(a.emptyOrdinal),
        mode: 'page_split_alias',
        card_id: a.attachedTo,
        card: a.attachedCard ?? null,
        attached_ch: a.attachedCh ?? null,
        empty_title: a.evidence?.emptyTitle ?? null,
        body_title: a.evidence?.bodyTitle ?? null,
      }))].sort((a, b) => a.chapter - b.chapter),
      note:
        '第1214/2031/2039章在原文中只是重复的页码分节标题（正文在同名前一小节），没有独立正文，故不新造剧情卡，改为把空章 ordinal 挂到该节已有卡片的 ch 上，既保证 2337/2337 覆盖又不重复编造内容。',
    },
    relocated_cards: { count: stats.chLocated, items: located },
    backfill_ev_random_sample_30: sample,
    backfill_ev_h4_sample_20: h4Sample,
    backfill_ev_total: backfilled.length,
    unverifiable_quotes: stats.unverifiableExamples.slice(0, 20),
  }
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

async function loadIsStoryKbFormat() {
  const mod = await import(pathToFileURL(path.join(repoRoot, 'src/shared/session-attachment-rag/chunking.ts')).href)
  return mod.isStoryKbFormat
}

async function verifyOutput(outputPath, novel, reportPath) {
  const failures = []
  const check = (name, ok, detail) => {
    console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures.push(name)
  }

  const raw = fs.readFileSync(outputPath, 'utf8')
  const out = JSON.parse(raw)
  const isStoryKbFormat = await loadIsStoryKbFormat()

  check('1. isStoryKbFormat(output) === true', isStoryKbFormat(raw) === true)

  const calibrated = out.calibrated_cards ?? []
  const mustBeFull = {
    八大兽影: 'CH_368。',
    炼蛊四大基本操作: '不应混淆。',
    以蛊炼人: 'CH_1021。',
    九转至尊仙胎蛊: 'CH_1021。',
    宝黄天: '渠道。',
    世界底层补充: '约38倍。',
  }
  const missingTail = Object.entries(mustBeFull).filter(([name, tail]) => {
    const card = calibrated.find((c) => c.name === name)
    return !card || !String(card.card).includes(tail)
  })
  check(
    '2. calibrated_cards === 22 / 正文 >= 20 字 / 6 条全文完整',
    calibrated.length === 22 && calibrated.every((c) => String(c.card).length >= 20) && missingTail.length === 0,
    `count=${calibrated.length} 截断=${missingTail.map(([n]) => n).join(',') || '无'}`
  )

  check('3. conflicts === []', (out.conflicts ?? []).length === 0, `len=${(out.conflicts ?? []).length}`)

  let leakCount = 0
  for (const section of SECTIONS) for (const card of out[section] ?? []) if (MACHINE_RE.test(String(card.card)) || MACHINE_HEAD_RE.test(String(card.card).trim())) leakCount++
  check('4. 阶段二机器记账卡 === 0', leakCount === 0, `count=${leakCount}`)

  let tailCount = 0
  for (const card of out.character_states ?? []) if (/；说明\s*(?:Identity|Name|Category|Profile):/.test(card.card)) tailCount++
  check('5. character_states 残余「；说明 Identity:」=== 0', tailCount === 0, `count=${tailCount}`)

  const chapterOrdinals = new Set((out.chapter_catalog ?? []).map((row) => Number(row[0])))
  const evidence = out.evidence_catalog ?? []
  let badCh = 0
  let badEv = 0
  const referencedEv = new Set()
  for (const section of SECTIONS) {
    for (const card of out[section] ?? []) {
      for (const ch of card.ch ?? []) if (!chapterOrdinals.has(Number(ch))) badCh++
      for (const ev of card.ev ?? []) {
        if (!Number.isInteger(ev) || ev < 0 || ev >= evidence.length) badEv++
        else {
          referencedEv.add(ev)
          if (!String(evidence[ev][2] ?? '').trim()) badEv++
        }
      }
    }
  }
  check('6. 所有 ch 命中 chapter_catalog / 所有 ev 合法且引文非空', badCh === 0 && badEv === 0, `badCh=${badCh} badEv=${badEv}`)

  const catalogLength = (out.mobile_card_catalog ?? []).length
  let badOrd = 0
  let dirtyAlias = 0
  for (const [alias, postings] of Object.entries(out.mobile_router?.aliases ?? {})) {
    if (isDirtyAlias(alias)) dirtyAlias++
    for (const posting of postings) if (!Number.isInteger(posting) || posting < 0 || posting >= catalogLength) badOrd++
  }
  const dense = (out.mobile_card_catalog ?? []).every((row, idx) => Number(row[0]) === idx)
  check(
    '7. router posting 合法 / 脏 alias === 0 / catalog 序号致密',
    badOrd === 0 && dirtyAlias === 0 && dense,
    `badOrd=${badOrd} dirtyAlias=${dirtyAlias} dense=${dense} catalog=${catalogLength}`
  )

  let asciiKeys = 0
  for (const section of SECTIONS) for (const card of out[section] ?? []) for (const key of card.keys ?? []) if (isPlainAsciiToken(String(key))) asciiKeys++
  check('8. 纯 ASCII card.keys === 0', asciiKeys === 0, `count=${asciiKeys}`)

  const bytes = fs.statSync(outputPath).size
  const mib = bytes / 1024 / 1024
  check('9. 文件体积 13–17 MiB', mib >= 13 && mib <= 17, `${mib.toFixed(2)} MiB (${bytes} bytes)`)

  const idSet = new Set()
  let dupIds = 0
  for (const section of SECTIONS) {
    for (const card of out[section] ?? []) {
      if (idSet.has(card._id)) dupIds++
      idSet.add(card._id)
    }
  }
  const catalogIds = new Set((out.mobile_card_catalog ?? []).map((row) => String(row[1])))
  let missingFromCatalog = 0
  for (const id of idSet) if (!catalogIds.has(id)) missingFromCatalog++
  check('附. 卡片 _id 唯一 / 全部登记进 mobile_card_catalog', dupIds === 0 && missingFromCatalog === 0, `dup=${dupIds} missing=${missingFromCatalog}`)

  const orphan = evidence.length - referencedEv.size
  check('附2. evidence_catalog 无孤儿行', orphan === 0, `orphan=${orphan} rows=${evidence.length}`)

  // ---- 阶段二 ----
  const covered = new Set()
  for (const section of CONTENT_SECTIONS) for (const card of out[section] ?? []) for (const ch of card.ch ?? []) covered.add(Number(ch))
  let missingChapters = 0
  for (let i = 0; i < EXPECTED_CHAPTERS; i++) if (!covered.has(i)) missingChapters++
  check('S2-1 全书内容卡覆盖 2337/2337', missingChapters === 0, `缺章=${missingChapters}`)

  const dupKey = new Map()
  let dupEvidence = 0
  const quoteMatch = { measured: 0, matched: 0, failed: [] }
  const restoredChapterCache = new Map()
  const matchQuoteInChapter = (ordinal, quote) => {
    const raw = novel.chapters[ordinal].rawFullText
    if (raw.includes(quote)) return true
    // 原文该章本身带星号时，允许与「星号还原后的明文引文」比对
    if (!/\*{2,}/.test(raw)) return false
    let restored = restoredChapterCache.get(ordinal)
    if (restored === undefined) {
      restored = restoreStars(raw)
      restoredChapterCache.set(ordinal, restored)
    }
    return restored.includes(quote)
  }
  for (const row of evidence) {
    const key = `${row[0]}|${row[2]}`
    dupKey.set(key, (dupKey.get(key) ?? 0) + 1)
    const ordinal = Number(/^ch(\d+)$/.exec(String(row[0]))?.[1] ?? 0) - 1
    if (ordinal < 0 || ordinal >= novel.chapters.length) continue
    quoteMatch.measured++
    if (matchQuoteInChapter(ordinal, String(row[2] ?? ''))) quoteMatch.matched++
    else quoteMatch.failed.push({ chapter_id: String(row[0]), quote: String(row[2]).slice(0, 80) })
  }
  for (const v of dupKey.values()) if (v > 1) dupEvidence += v - 1
  const matchRate = quoteMatch.measured ? (quoteMatch.matched / quoteMatch.measured) * 100 : 100
  check(
    'S2-2 evidence 去重 / 引文逐字可验证',
    dupEvidence === 0 && matchRate >= 99.9,
    `dup=${dupEvidence} measured=${quoteMatch.measured} match=${matchRate.toFixed(2)}% failed=${quoteMatch.failed.length}`
  )

  let chatter = 0
  const CHATTER_GATE_RE = /(?:ps[:：]|PS[:：]|备注[:：]|求月票|呼唤月票|书友群|打赏|评价票)/
  for (const section of SECTIONS) for (const card of out[section] ?? []) if (CHATTER_GATE_RE.test(`${card.name ?? ''}${card.card}`)) chatter++
  for (const row of evidence) if (CHATTER_GATE_RE.test(String(row[2] ?? ''))) chatter++
  check('S2-3 作者杂谈清零', chatter === 0, `count=${chatter}`)

  let stars = 0
  const starGate = [/\*{2,}运/, /五行\*{2,}师/, /爱\*{2,}/]
  for (const section of SECTIONS) {
    for (const card of out[section] ?? []) {
      const blob = `${card.name ?? ''}|${card.card}|${(card.keys ?? []).join(',')}|${(card.aliases ?? []).join(',')}`
      if (starGate.some((re) => re.test(blob))) stars++
    }
  }
  for (const row of evidence) if (starGate.some((re) => re.test(String(row[2] ?? '')))) stars++
  for (const alias of Object.keys(out.mobile_router?.aliases ?? {})) if (starGate.some((re) => re.test(alias))) stars++
  check('S2-4 已证实星号词清零（换魂** 保持原样）', stars === 0, `count=${stars}`)

  let dots = 0
  for (const card of out.character_states ?? []) if (String(card.card).includes('…')) dots++
  let recNames = 0
  for (const section of SECTIONS) for (const card of out[section] ?? []) if (/^rec:gur:/i.test(String(card.name ?? ''))) recNames++
  check('S2-5 真截断与机器记账清零', dots === 0 && leakCount === 0 && recNames === 0, `…卡=${dots} leak=${leakCount} recName=${recNames}`)

  check('S2-6 体积红线 13.5–16.5 MiB', mib >= 13.5 && mib <= 16.5, `${mib.toFixed(2)} MiB`)

  // 附3：审计报告里的 offset 凭据必须能逐字切回原文
  let offsetChecked = 0
  let offsetBad = 0
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    const verifyEntry = (entry) => {
      const ord = Number(/^ch(\d+)$/.exec(String(entry.chapter_id ?? ''))?.[1] ?? 0) - 1
      const quote = String(entry.quote ?? entry.matched_quote ?? '')
      const offset = Number(entry.quote_offset ?? entry.offset)
      const len = Number(entry.quote_len ?? quote.length)
      const chapter = novel.chapters[ord]
      offsetChecked++
      if (!chapter || !Number.isInteger(offset) || chapter.rawFullText.slice(offset, offset + len) !== quote) offsetBad++
    }
    for (const e of report.missing_6_chapters?.new_cards ?? []) verifyEntry(e)
    for (const e of report.fixed_truncated_cards ?? []) verifyEntry(e)
    for (const e of report.relocated_cards?.items ?? []) verifyEntry(e)
    for (const e of report.backfill_ev_random_sample_30 ?? []) verifyEntry(e)
    for (const e of report.backfill_ev_h4_sample_20 ?? []) verifyEntry(e)
  } catch (error) {
    offsetBad++
    console.log('[verify] 审计报告读取失败:', error.message)
  }
  check('附3. 审计报告 offset 凭据逐字对齐原文', offsetBad === 0, `checked=${offsetChecked} bad=${offsetBad}`)

  const srcKb = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
  const sameCatalog = JSON.stringify(srcKb.chapter_catalog) === JSON.stringify(out.chapter_catalog)
  const sameRuntime = JSON.stringify(srcKb.runtime_core) === JSON.stringify(out.runtime_core)
  check('附4. chapter_catalog / runtime_core 与阶段一逐字节一致', sameCatalog && sameRuntime, `catalog=${sameCatalog} runtime=${sameRuntime}`)

  console.log(`\n=== 阶段二门禁：${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`} ===`)
  return failures.length === 0
}

function runEndToEndProbes() {
  const rel = path.relative(repoRoot, outputPathOf()).replace(/\\/g, '/')
  console.log(`\n=== 端到端回归：KB_PATH=${rel} / KB_PROBES=2 ===`)
  const result = spawnSync(process.execPath, ['--experimental-transform-types', 'scripts/verify-mobile-story-rag.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, KB_PATH: rel, KB_PROBES: '2' },
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) {
    console.error(`\n[verify] 端到端回归退出码 ${result.status}`)
    process.exitCode = 1
    return false
  }
  // 把端到端实测的导入耗时/父块/子块数补写进审计报告
  const metrics = parseIndexMetrics(result.stdout ?? '')
  if (metrics) {
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
      report.summary.index_duration_ms = metrics.indexDurationMs ?? null
      report.summary.parent_count = metrics.parentCount ?? null
      report.summary.children_count = metrics.childrenCount ?? null
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
    } catch (error) {
      console.log('[verify] 审计报告补写导入指标失败:', error.message)
    }
  }
  return true
}

function parseIndexMetrics(text) {
  const marker = /Indexed in (\d+)ms:\s*/.exec(text)
  if (!marker) return null
  const start = text.indexOf('{', marker.index + marker[0].length)
  if (start < 0) return { indexDurationMs: Number(marker[1]) }
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1))
          return { indexDurationMs: Number(marker[1]), ...parsed }
        } catch {
          const tail = text.slice(start, i + 1)
          const num = (key) => {
            const m = new RegExp(`${key}:\\s*(\\d+)`).exec(tail)
            return m ? Number(m[1]) : null
          }
          return {
            indexDurationMs: Number(marker[1]),
            parentCount: num('parentCount'),
            childrenCount: num('chunkCount') ?? num('totalChunks'),
          }
        }
      }
    }
  }
  return { indexDurationMs: Number(marker[1]) }
}

function outputPathOf() {
  return process.env.KB_OUTPUT ? path.resolve(repoRoot, process.env.KB_OUTPUT) : path.join(repoRoot, OUTPUT_REL)
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const args = new Set(process.argv.slice(2))
const outputPath = outputPathOf()
const reportPath = path.join(repoRoot, REPORT_REL)
const novelPath = process.env.NOVEL_PATH ? path.resolve(process.env.NOVEL_PATH) : NOVEL_DEFAULT
const inputPath = process.env.KB_INPUT ? path.resolve(repoRoot, process.env.KB_INPUT) : path.join(repoRoot, INPUT_REL)

if (!args.has('--verify-only')) {
  const startedAt = Date.now()
  const { out, stats, kb, novel, located, backfilled } = enrich(inputPath, novelPath)
  const serialized = JSON.stringify(out)
  fs.writeFileSync(outputPath, serialized, 'utf8')

  // 备份：统计最终卡片（供审计报告覆盖度）
  stats.finalCards = {}
  for (const section of SECTIONS) stats.finalCards[section] = out[section] ?? []

  const outputBytes = Buffer.byteLength(serialized, 'utf8')
  const report = buildAuditReport({ out, stats, kb, novel, located, backfilled, outputBytes })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')

  const srcMib = (Buffer.byteLength(fs.readFileSync(inputPath, 'utf8'), 'utf8') / 1024 / 1024).toFixed(2)
  console.log(`\n[phase2] ${srcMib} MiB → ${(outputBytes / 1024 / 1024).toFixed(2)} MiB in ${Date.now() - startedAt}ms`)
  console.log('[phase2] cards: %d → %d', (kb.mobile_card_catalog ?? []).length, out.mobile_card_catalog.length)
  console.log(
    '[phase2] machine cards dropped=%d chatterCard=%d recUnwrapped=%d recEmpty=%d',
    stats.droppedMachineCard,
    stats.droppedAuthorChatterCard,
    stats.unwrappedRecCard,
    stats.droppedRecShellEmpty
  )
  console.log('[phase2] star cards=%d | fixed=%d | ellipsis=%d', stats.starCards, stats.fixedCards.length, stats.ellipsisCleanedCards)
  console.log('[phase2] new chapter cards=%d | ch relocated=%d | ev backfilled=%d (miss=%d)', stats.newChapterCards.length, stats.chLocated, stats.evBackfill, stats.evBackfillMiss)
  console.log('[phase2] evidence rows: %d → %d (unverifiable dropped=%d)', stats.evidenceRowsBefore, stats.evidenceRowsAfter, stats.evidenceDroppedUnverifiable)
  console.log('[phase2] aliases: %d → %d | postings=%d', stats.aliasBefore, stats.aliasAfter, stats.aliasPostings)
  for (const section of SECTIONS) {
    console.log('   %s: %d → %d', section.padEnd(18), (kb[section] ?? []).length, (out[section] ?? []).length)
  }
  console.log(`[phase2] wrote ${outputPath}`)
  console.log(`[phase2] wrote ${reportPath}`)
  if (process.env.P2_DEBUG) {
    console.log('[debug] ev miss histogram (bigramHits):', JSON.stringify(stats.evMissHist))
    console.log('[debug] ev miss by section:', JSON.stringify(stats.evMissBySection))
    console.log('[debug] ev miss samples:', JSON.stringify(stats.evMissDebug, null, 1))
    console.log('[debug] locate skipped:', JSON.stringify(stats.chLocateSkipped.slice(0, 20)))
  }
}

if (args.has('--verify') || args.has('--verify-only')) {
  const novel = parseNovel(novelPath, JSON.parse(fs.readFileSync(inputPath, 'utf8')))
  const ok = await verifyOutput(outputPath, novel, reportPath)
  if (ok && args.has('--verify')) runEndToEndProbes()
  if (!ok) process.exitCode = 1
}

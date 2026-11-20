/**
 * 蛊真人 KB — Chatbox 专用精简版清洗器（确定性，零 LLM）
 *
 * 输入：git c64080b1 中的 patch/goal/gur-kb(2).json（22.04 MiB / 41,893 catalog / 100% 原文引文）
 *      —— 当前工作区里的 gur-kb(2).json 是被回滚的旧版，不能用作基线。
 * 输出：patch/goal/gur-kb-chatbox-slim.json（100% 兼容 src/shared/session-attachment-rag/chunking.ts）
 *
 * 用法：
 *   node scripts/clean-story-kb-chatbox.mjs            # 生成精简 KB
 *   node scripts/clean-story-kb-chatbox.mjs --verify   # 生成 + 不变量自检 + 端到端回归
 *   node scripts/clean-story-kb-chatbox.mjs --verify-only  # 只对已生成文件做自检
 *
 * 环境变量：
 *   KB_SOURCE  覆盖输入（.json 路径）；默认从 git c64080b1 读取
 *   KB_OUTPUT  覆盖输出路径
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const BASELINE_COMMIT = 'c64080b1'
const BASELINE_PATH = 'patch/goal/gur-kb(2).json'
const OUTPUT_REL = 'patch/goal/gur-kb-chatbox-slim.json'
const KB_VERSION = 'kb-2026-11-20-chatbox-slim-v1'
const CLEANED_FROM = 'kb-2026-10-25-r05-chatbox-fix'

/** chunking.ts 消费的 14 个正文分区，顺序即写入顺序。 */
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

/** 跨分区去重的保留优先级（越小越优先）。 */
const SECTION_PRIORITY = new Map(
  ['calibrated_cards', 'character_states', 'entities', 'items_and_gu', 'events', 'relationships', 'factions', 'locations', 'rules', 'terms', 'timeline', 'foreshadows', 'claims'].map(
    (name, idx) => [name, idx]
  )
)

/** 流水线元数据泄漏特征：命中即整卡丢弃。
 *  除首版的已知前缀外，补充实测命中的半截机器字段（quote_excerpt / record_id /
 *  status_change_in_chunk / mention_ids 等）：这些卡片正文是流水线中间态 dump，
 *  截断后只剩字段名与残句，会直接抢占 Top-1。 */
const PIPELINE_LEAK_RE =
  /(?:promoted_by:|record_type:|source_refs:|ord_type:|entity_candidate|A7 resolver|verification_verdict:|canon_status:canon_source|chunk_id:micro:|quote_excerpt:|e_excerpt:|record_id:|status_change_in_chunk:|n_chunk:|mention_ids:|subject_id:|entity_id:|canonical_name:|inference_notes:|motivations_and_goals:|ty_status:|behavior_patterns:|capabilities:basis:|uncertainty:)/i

/** 纯空壳：`某某：Name:某某；Category:势力 | 某某。` */
const NAME_CATEGORY_SHELL_RE = /^[^：:]+[：:]\s*Name:[^；;]+；Category:[^；;|]+[|｜]\s*[^。]+。?$/

/** character_states 尾部重复倾倒（Identity:... / Name:... / Category:... / Profile:...）。
 *  正文在 130 字处被截断时标签只剩前缀（"Ident" / "Iden" / "Id"），同样要剥掉。 */
const STATE_TAIL_RE = /；说明\s*(?:Identity|Identi|Ident|Iden|Ide|Id|I|Name|Category|Profile)[:：]?[\s\S]*$/

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function readBaseline() {
  const override = process.env.KB_SOURCE
  if (override) {
    const abs = path.resolve(repoRoot, override)
    console.log(`[source] ${abs}`)
    return JSON.parse(fs.readFileSync(abs, 'utf8'))
  }
  const raw = execFileSync('git', ['show', `${BASELINE_COMMIT}:${BASELINE_PATH}`], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  })
  console.log(`[source] git ${BASELINE_COMMIT}:${BASELINE_PATH} (${(Buffer.byteLength(raw, 'utf8') / 1024 / 1024).toFixed(2)} MiB)`)
  return JSON.parse(raw)
}

/** 去重用的文本归一化：压掉空白与句尾标点。 */
function normalizeText(text) {
  return String(text ?? '')
    .replace(/\s+/g, '')
    .replace(/[。.;；!！?？]+$/g, '')
    .trim()
}

function isPlainAsciiToken(value) {
  return /^[a-zA-Z0-9_.\-…]+$/.test(value)
}

function uniq(arr) {
  return [...new Set(arr)]
}

function uniqNumbers(arr) {
  const out = []
  const seen = new Set()
  for (const raw of arr ?? []) {
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0 || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

function cleanKeys(keys) {
  const out = []
  const seen = new Set()
  for (const raw of keys ?? []) {
    const key = String(raw ?? '').trim()
    if (!key) continue
    // 纯 ASCII / 截断内部标签（calibrated_se…、setting_item_…、info…）全部剔除。
    if (isPlainAsciiToken(key)) continue
    if (key.length <= 1) continue
    if (/[\n\r:：|｜]/.test(key)) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/** 别名脏键：长度、标点、伪 ID 三类。 */
function isDirtyAlias(alias) {
  if (!alias) return true
  if (alias.length <= 1 || alias.length > 12) return true
  if (/[，。；？！：:()（）【】\[\]|]|CH_\d|见第/.test(alias)) return true
  if (/^[a-zA-Z0-9_.\-]+$/.test(alias)) return true
  return false
}

/** 剥掉 `Name:/Identity:/Category:/…` 这类机器标签，返回剩余有效文本。 */
function stripMachineLabels(text) {
  return String(text ?? '')
    .replace(/^[^：:]{1,40}[：:]\s*/, '')
    .replace(/(?:^|[；;|｜])\s*(?:Name|Identity|Category|Alias|Age|Gender|Status|Profile)\s*[:：][^；;|｜]*/g, '')
    .replace(/[；;|｜\s。.]+/g, '')
    .trim()
}

// ---------------------------------------------------------------------------
// Step A — 无损重建 calibrated_cards
// ---------------------------------------------------------------------------

function rebuildCalibratedCards(src, stats) {
  const groups = new Map()
  for (const card of src.calibrated_cards ?? []) {
    if (!groups.has(card.name)) groups.set(card.name, [])
    groups.get(card.name).push(card)
  }

  const supplements = src.calibrated_supplements ?? []
  const out = []
  const idRemap = new Map()
  const info = new Map()
  const nameMap = new Map(supplements.map((sup) => [sup.name, sup]))

  for (const [groupName, group] of groups) {
    if (!nameMap.has(groupName)) {
      throw new Error(`calibrated_cards 分组 "${groupName}" 没有对应的 calibrated_supplements 条目`)
    }
  }

  for (const sup of supplements) {
    const group = groups.get(sup.name)
    if (!group || group.length === 0) {
      throw new Error(`calibrated_supplements "${sup.name}" 找不到同名 calibrated_cards 分组`)
    }

    // 陷阱：calibrated_supplements.ch 是旧版越界序号（2334..2352 > chapter_catalog 最大 ordinal 2336），
    // 一律不取；ch/ev 只从同名原分组继承。
    const canonicalId = String(group[0]._id)
    for (const card of group.slice(1)) idRemap.set(String(card._id), canonicalId)

    const stmt = String(sup.statement ?? '').trim()
    const body = String(sup.text ?? '').trim()
    const stmtHead = stmt.slice(0, 12)
    let text = body.includes(stmtHead) ? body : `${stmt} ${body}`.trim()
    if (!text) text = `${stmt} ${body}`.trim()

    if (
      (sup.canon_status === 'player_provided_calibration' || sup.verification_status === 'player_provided') &&
      !text.includes('玩家提供')
    ) {
      text += '（玩家提供校准，非原著既定事实）'
    }
    if (sup.canon_status === 'player_calibrated_with_inference' && !text.includes('推测')) {
      text += '【推测/外推】'
    }

    const ch = uniqNumbers(group.flatMap((card) => (Array.isArray(card.ch) ? card.ch : []))).sort((a, b) => a - b)
    const ev = uniqNumbers(group.flatMap((card) => (Array.isArray(card.ev) ? card.ev : []))).slice(0, 2)

    const aliases = uniq([
      ...(Array.isArray(sup.aliases) ? sup.aliases.map(String) : []),
      ...group.flatMap((card) => (Array.isArray(card.aliases) ? card.aliases.map(String) : [])),
    ]).filter((alias) => alias && CJK_RE.test(alias))

    const keys = cleanKeys([
      ...(Array.isArray(sup.keys) ? sup.keys : []),
      ...group.flatMap((card) => (Array.isArray(card.keys) ? card.keys : [])),
    ])

    const rebuilt = {
      section: 'calibrated_cards',
      _id: canonicalId,
      name: String(sup.name),
      card: text,
      ch,
      ev,
      keys,
      aliases,
      story_time: '',
      state_kind: 'calibrated',
      valid_from: undefined,
      valid_to: undefined,
      kind: 'calibrated',
      priorityRank: 4,
    }

    info.set(canonicalId, { kind: 'calibrated', priorityRank: 4 })
    out.push(rebuilt)
  }

  stats.calibratedGroups = groups.size
  stats.calibratedOut = out.length
  return { cards: out, idRemap, info }
}

// ---------------------------------------------------------------------------
// Step B — 清除垃圾分区与坏卡
// ---------------------------------------------------------------------------

function cleanSection(sectionName, cards, ctx) {
  const kept = []

  for (const card of cards ?? []) {
    const id = String(card._id ?? '')
    if (!id) continue
    const originalName = String(card.name ?? '')
    let text = String(card.card ?? '').trim()
    if (!text) continue

    // B1：原 catalog 里 substantive=0 / priority_rank=0 的空壳占位卡
    const catalogInfo = ctx.catalogById.get(id)
    if (catalogInfo && (catalogInfo.substantive === false || catalogInfo.priorityRank === 0)) {
      ctx.stats.dropNonSubstantive++
      continue
    }

    // B2：流水线元数据泄漏
    if (PIPELINE_LEAK_RE.test(text)) {
      ctx.stats.dropLeak++
      continue
    }

    // B3a：character_states 尾部重复倾倒（先清理再判空）
    if (sectionName === 'character_states' && STATE_TAIL_RE.test(text)) {
      text = text.replace(STATE_TAIL_RE, '')
      if (!/[。！？…”』】]$/.test(text)) text += '。'
      ctx.stats.stripStateTail++
    }

    // B3b：纯空壳 Name/Category 模板
    if (NAME_CATEGORY_SHELL_RE.test(text)) {
      ctx.stats.dropShell++
      continue
    }

    // B3c：剥掉机器标签后无有效内容，或只是把名字复读一遍
    const residual = stripMachineLabels(text)
    if (!residual) {
      ctx.stats.dropShell++
      continue
    }

    // B3d：同义反复空壳
    // timeline 的卡就是章目标题（name === card，如「第41章 第四十一节：解石」），
    // 剥掉「第N章 第M节：」前缀后只剩 2 个字，会被下面的短文本规则误杀，故整段跳过。
    if (sectionName !== 'timeline') {
      const tautology = text
        .replace(/^[^：:]{1,40}[：:]\s*/, '')
        .replace(/[。.;；!！?？\s]+$/g, '')
        .trim()
      if (!tautology) {
        ctx.stats.dropTautology++
        continue
      }
      if (tautology.length < 4 && !/^\d+$/.test(tautology)) {
        ctx.stats.dropTautology++
        continue
      }
      if (originalName && tautology === originalName.trim()) {
        ctx.stats.dropTautology++
        continue
      }
    }

    // B3e：占位标题（未命名-legacy: / 未命名-rec: / 未命名-cand_ 等全部 未命名- 前缀）
    // 这些技术标题会被 chunking.ts 写进 entities/倒排表，必须清空。
    let name = originalName
    if (/^未命名-/.test(name)) {
      name = ''
      ctx.stats.clearedName++
    }

    const ch = uniqNumbers(Array.isArray(card.ch) ? card.ch : [])
    const ev = uniqNumbers(Array.isArray(card.ev) ? card.ev : [])

    kept.push({
      section: sectionName,
      _id: id,
      name,
      card: text,
      ch,
      ev,
      keys: cleanKeys(card.keys),
      aliases: Array.isArray(card.aliases) ? card.aliases.map(String).filter((a) => a && CJK_RE.test(a)) : [],
      story_time: typeof card.story_time === 'string' && card.story_time.trim() ? card.story_time.trim() : '',
      state_kind: typeof card.state_kind === 'string' && card.state_kind.trim() ? card.state_kind.trim() : '',
      valid_from: Number.isFinite(Number(card.valid_from)) ? Number(card.valid_from) : undefined,
      valid_to: Number.isFinite(Number(card.valid_to)) ? Number(card.valid_to) : undefined,
      kind: catalogInfo?.kind || sectionName,
      priorityRank:
        catalogInfo && Number.isFinite(catalogInfo.priorityRank) && catalogInfo.priorityRank > 0
          ? catalogInfo.priorityRank
          : sectionName === 'entities' || sectionName === 'events' || sectionName === 'items_and_gu'
            ? 3
            : 2,
    })
  }

  return dedupeSameSection(sectionName, kept, ctx)
}

/** 同分区去重：同名 + 同正文 → 保留更早章节 / 更高优先级 / 更多引文的那张。 */
function dedupeSameSection(sectionName, kept, ctx) {
  const groups = new Map()
  for (const card of kept) {
    const key = `${sectionName}|${card.name}|${normalizeText(card.card)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(card)
  }

  const out = []
  for (const [, list] of groups) {
    if (list.length === 1) {
      out.push(list[0])
      continue
    }
    list.sort((a, b) => {
      const aCh = a.ch.length ? Math.min(...a.ch) : Number.MAX_SAFE_INTEGER
      const bCh = b.ch.length ? Math.min(...b.ch) : Number.MAX_SAFE_INTEGER
      if (aCh !== bCh) return aCh - bCh
      if (a.priorityRank !== b.priorityRank) return b.priorityRank - a.priorityRank
      if (a.ev.length !== b.ev.length) return b.ev.length - a.ev.length
      return a._id.localeCompare(b._id)
    })
    const keeper = list[0]
    out.push(keeper)
    for (const dup of list.slice(1)) {
      ctx.idRemap.set(dup._id, keeper._id)
      ctx.stats.dropSameSectionDup++
    }
  }
  return out
}

/** 跨分区完全重复（name + 正文一致，name 非空且正文 >= 15 字）。 */
function dedupeCrossSection(allCards, ctx) {
  const byKey = new Map()
  for (const card of allCards) {
    if (!card.name) continue
    const norm = normalizeText(card.card)
    if (norm.length < 15) continue
    const key = `${card.name}|${norm}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(card)
  }

  const removed = new Set()
  for (const [, list] of byKey) {
    if (list.length < 2) continue
    list.sort((a, b) => {
      const pa = SECTION_PRIORITY.get(a.section) ?? 99
      const pb = SECTION_PRIORITY.get(b.section) ?? 99
      if (pa !== pb) return pa - pb
      const aCh = a.ch.length ? Math.min(...a.ch) : Number.MAX_SAFE_INTEGER
      const bCh = b.ch.length ? Math.min(...b.ch) : Number.MAX_SAFE_INTEGER
      return aCh - bCh
    })
    const keeper = list[0]
    for (const dup of list.slice(1)) {
      if (removed.has(dup._id)) continue
      removed.add(dup._id)
      ctx.idRemap.set(dup._id, keeper._id)
      ctx.stats.dropCrossSectionDup++
    }
  }

  return allCards.filter((card) => !removed.has(card._id))
}

// ---------------------------------------------------------------------------
// Step C — 清洗 keys 与 mobile_router.aliases
// ---------------------------------------------------------------------------

function cleanRouterAliases(src, survivorsById, ctx) {
  const oldCatalog = src.mobile_card_catalog ?? []
  const oldCardIdByOrdinal = new Map()
  for (const entry of oldCatalog) {
    if (Array.isArray(entry) && typeof entry[0] === 'number') oldCardIdByOrdinal.set(Number(entry[0]), String(entry[1]))
  }

  const aliasPostings = new Map()
  const rawAliases = src.mobile_router?.aliases
  if (!rawAliases || typeof rawAliases !== 'object') return aliasPostings

  for (const [rawAlias, postings] of Object.entries(rawAliases)) {
    if (!rawAlias || !Array.isArray(postings)) continue
    ctx.stats.aliasesBefore++

    // 第一步：旧 ordinal → 旧 cardId → 幸存 cardId（清洗中被删/被并的 posting 丢弃）
    const cardIds = new Set()
    for (const posting of postings) {
      if (typeof posting !== 'number' && !(typeof posting === 'string' && /^\d+$/.test(posting))) continue
      const oldId = oldCardIdByOrdinal.get(Number(posting))
      if (!oldId) continue
      const mappedId = ctx.idRemap.get(oldId) ?? oldId
      if (!survivorsById.has(mappedId)) continue
      cardIds.add(mappedId)
    }
    if (cardIds.size === 0) continue

    // 第二步：清洗脏 alias 键（前缀剥离 + 顿号拆分 + 三类脏键过滤）
    let base = rawAlias
    if (base.startsWith('别名:') || base.startsWith('别名：')) base = base.slice(3)
    const parts = base.includes('、') ? base.split('、') : [base]
    for (const rawPart of parts) {
      const alias = rawPart.trim()
      if (isDirtyAlias(alias)) continue
      if (!aliasPostings.has(alias)) aliasPostings.set(alias, new Set())
      for (const id of cardIds) aliasPostings.get(alias).add(id)
    }
  }

  return aliasPostings
}

// ---------------------------------------------------------------------------
// 主清洗流程
// ---------------------------------------------------------------------------

function cleanKb(src) {
  const stats = {
    sourceBytes: Buffer.byteLength(JSON.stringify(src), 'utf8'),
    sourceCards: 0,
    dropNonSubstantive: 0,
    dropLeak: 0,
    dropShell: 0,
    dropTautology: 0,
    stripStateTail: 0,
    clearedName: 0,
    dropSameSectionDup: 0,
    dropCrossSectionDup: 0,
    aliasesBefore: 0,
    aliasesAfter: 0,
    keysBefore: 0,
    keysAfter: 0,
    calibratedGroups: 0,
    calibratedOut: 0,
  }

  const oldCatalogById = new Map()
  for (const entry of src.mobile_card_catalog ?? []) {
    if (!Array.isArray(entry)) continue
    const ordinal = Number(entry[0])
    const cardId = String(entry[1])
    oldCatalogById.set(cardId, {
      ordinal,
      kind: String(entry[2] ?? ''),
      priorityRank: Number(entry[3]),
      substantive: entry.length >= 5 ? Number(entry[4]) !== 0 : true,
    })
  }

  const ctx = { catalogById: oldCatalogById, idRemap: new Map(), stats }

  for (const sectionName of SECTIONS) {
    stats.sourceCards += (src[sectionName] ?? []).length
    for (const card of src[sectionName] ?? []) {
      stats.keysBefore += Array.isArray(card.keys) ? card.keys.length : 0
    }
  }

  // Step A
  const calibrated = rebuildCalibratedCards(src, stats)
  // 22 组 calibrated 碎片卡的 ID 合并必须并入全局映射，否则 router 里挂在
  // 非首张碎片 ID 上的别名会解析不到幸存卡而被静默丢弃。
  for (const [oldId, canonicalId] of calibrated.idRemap) ctx.idRemap.set(oldId, canonicalId)

  // Step B
  let allCards = [...calibrated.cards]
  for (const sectionName of SECTIONS) {
    if (sectionName === 'calibrated_cards') continue
    if (sectionName === 'conflicts') continue
    const sectionCards = cleanSection(sectionName, src[sectionName], ctx)
    for (const card of sectionCards) allCards.push(card)
  }

  // 同一 _id 只应出现一次
  const seenIds = new Set()
  allCards = allCards.filter((card) => {
    if (seenIds.has(card._id)) {
      ctx.stats.dropSameSectionDup++
      return false
    }
    seenIds.add(card._id)
    return true
  })

  // Step B4b：跨分区去重
  allCards = dedupeCrossSection(allCards, ctx)

  const survivorsById = new Map(allCards.map((card) => [card._id, card]))

  // Step C：卡内 keys
  for (const card of allCards) {
    card.keys = cleanKeys(card.keys)
    stats.keysAfter += card.keys.length
  }

  // Step C：router aliases（需要 idRemap 与幸存集合都已稳定）
  const aliasPostings = cleanRouterAliases(src, survivorsById, ctx)

  // Step D：字段裁剪在输出阶段完成
  // 先按原表完成「同卡重复引文去重 + 截断前 2 条」，再据此建 evidence_catalog，
  // 否则会为一堆最终没人引用的中间行建表（实测 99 行孤儿）。
  const oldEvidence = src.evidence_catalog ?? []
  for (const card of allCards) {
    card.ev = selectOldEvidence(card, oldEvidence)
  }
  const { evidenceCatalog, evRemap } = rebuildEvidenceCatalog(oldEvidence, allCards, stats)
  for (const card of allCards) {
    card.ev = card.ev.map((oldIdx) => evRemap.get(oldIdx)).filter((idx) => idx !== undefined)
  }

  // Step E：重建 catalog 与 router
  const { mobileCardCatalog, newOrdinalByCardId, kindByCardId } = rebuildCatalog(allCards)
  const outAliases = {}
  for (const [alias, ids] of aliasPostings) {
    const ordinals = []
    for (const id of ids) {
      const ordinal = newOrdinalByCardId.get(id)
      if (ordinal !== undefined) ordinals.push(ordinal)
    }
    if (ordinals.length === 0) continue
    outAliases[alias] = uniqNumbers(ordinals).sort((a, b) => a - b)
    stats.aliasesAfter++
  }

  // 输出对象
  const out = {
    format: 'GUR-KB-SINGLE-2.0-COMPACT',
    manifest: {
      kb_name: 'gur-canon-kb',
      schema_version: 'GUR-KB-SINGLE-2.0-COMPACT',
      prompt_compatibility: 'GUR-GAME-PROMPT-2.x-COMPACT',
      kb_version: KB_VERSION,
      cleaned_from: CLEANED_FROM,
      source_commit: BASELINE_COMMIT,
      source_bytes: stats.sourceBytes,
      parent_chapter_span: 1,
      line_policy: 'compact single-line json for chatbox JSON.parse',
    },
    runtime_core: src.runtime_core,
    chapter_catalog: src.chapter_catalog,
    evidence_catalog: evidenceCatalog,
    mobile_card_catalog: mobileCardCatalog,
    mobile_router: { aliases: outAliases },
    mobile_stats: {
      source_cards: stats.sourceCards,
      retained_cards: allCards.length,
      dropped_non_substantive: stats.dropNonSubstantive,
      dropped_metadata_leak: stats.dropLeak,
      dropped_shell: stats.dropShell + stats.dropTautology,
      stripped_state_tail: stats.stripStateTail,
      cleared_placeholder_names: stats.clearedName,
      dropped_same_section_dup: stats.dropSameSectionDup,
      dropped_cross_section_dup: stats.dropCrossSectionDup,
      evidence_rows: evidenceCatalog.length,
      router_aliases: Object.keys(outAliases).length,
      calibrated_cards: calibrated.cards.length,
      card_kinds: Object.fromEntries(
        [...new Set(kindByCardId.values())].sort().map((kind) => [kind, [...kindByCardId.values()].filter((v) => v === kind).length])
      ),
    },
  }

  out.calibrated_cards = calibrated.cards.map((card) => projectCard(card))
  for (const sectionName of SECTIONS) {
    if (sectionName === 'calibrated_cards') continue
    if (sectionName === 'conflicts') {
      out.conflicts = []
      continue
    }
    out[sectionName] = allCards.filter((card) => card.section === sectionName).map((card) => projectCard(card))
  }

  return { out, stats }
}

/** Step D：每张幸存卡只保留 chunking.ts 会消费的字段。 */
function projectCard(card) {
  const projected = { _id: card._id }
  if (card.name) projected.name = card.name
  projected.card = card.card
  if (card.ch.length) projected.ch = card.ch
  if (card.ev.length) projected.ev = card.ev
  if (card.keys.length) projected.keys = card.keys
  if (card.aliases.length) projected.aliases = card.aliases
  if (card.story_time) projected.story_time = card.story_time
  if (card.state_kind) projected.state_kind = card.state_kind
  if (card.valid_from !== undefined) projected.valid_from = card.valid_from
  if (card.valid_to !== undefined) projected.valid_to = card.valid_to
  return projected
}

/** 指针形状的「引文」只是位置标记，写进 child 文本会把 id 当句子喂给模型。 */
const EVIDENCE_POINTER_RE = /^(?:micro|macro|ev|evidence|quote|ref|src|ch|anchor|card|m\d)[:：]?[\w:.-]*$/i

/** 源表已知错配的引文：old idx 1671「幽魂魔尊生前未攻上天庭」被挂在
 *  「九转至尊仙胎蛊」碎片卡上，与词条无关；同一组里 1672 才是正确引文。 */
const KNOWN_MISFILED_EVIDENCE = new Map([['九转至尊仙胎蛊', new Set([1671])]])

/** 选出这张卡最终要保留的旧 ev 下标：去非法、去空引文、去重复引文，最多 2 条。 */
function selectOldEvidence(card, oldEvidence) {
  const excluded = KNOWN_MISFILED_EVIDENCE.get(card.name)
  const seenQuotes = new Set()
  const picked = []
  for (const oldIdx of card.ev) {
    if (!Number.isInteger(oldIdx) || oldIdx < 0 || oldIdx >= oldEvidence.length) continue
    if (excluded && excluded.has(oldIdx)) continue
    const quote = String(oldEvidence[oldIdx]?.[2] ?? '').trim()
    if (!quote) continue
    if (quote.length <= 32 && EVIDENCE_POINTER_RE.test(quote)) continue
    const fingerprint = quote.replace(/\s+/g, '')
    // 同一张卡的 ev 常指向两行内容相同的引文（源表去重残留），只保留一条。
    if (seenQuotes.has(fingerprint)) continue
    seenQuotes.add(fingerprint)
    picked.push(oldIdx)
    if (picked.length >= 2) break
  }
  return picked
}

function rebuildEvidenceCatalog(oldEvidence, allCards, stats) {
  const used = new Set()
  for (const card of allCards) {
    for (const idx of card.ev) {
      if (Number.isInteger(idx) && idx >= 0 && idx < oldEvidence.length) used.add(idx)
    }
  }

  const ordered = [...used].sort((a, b) => a - b)
  const evRemap = new Map()
  const catalog = []
  for (const oldIdx of ordered) {
    const row = oldEvidence[oldIdx]
    const quote = Array.isArray(row) ? String(row[2] ?? '').trim() : ''
    // pickEvidenceQuote 优先读 row[2]；空引文或指针形状的行没有保留价值。
    if (!quote) continue
    if (quote.length <= 32 && EVIDENCE_POINTER_RE.test(quote)) continue
    evRemap.set(oldIdx, catalog.length)
    catalog.push([row[0], row[1], quote, null, null])
  }

  stats.evidenceBefore = oldEvidence.length
  stats.evidenceAfter = catalog.length
  return { evidenceCatalog: catalog, evRemap }
}

function rebuildCatalog(allCards) {
  const catalog = []
  const newOrdinalByCardId = new Map()
  const kindByCardId = new Map()
  let nextOrdinal = 0

  for (const sectionName of SECTIONS) {
    const cards = allCards.filter((card) => card.section === sectionName)
    for (const card of cards) {
      const kind = sectionName === 'calibrated_cards' ? 'calibrated' : card.kind || sectionName
      const priorityRank = sectionName === 'calibrated_cards' ? 4 : card.priorityRank
      catalog.push([nextOrdinal, card._id, kind, priorityRank, 1])
      newOrdinalByCardId.set(card._id, nextOrdinal)
      kindByCardId.set(card._id, kind)
      nextOrdinal++
    }
  }
  return { mobileCardCatalog: catalog, newOrdinalByCardId, kindByCardId }
}

// ---------------------------------------------------------------------------
// 验证
// ---------------------------------------------------------------------------

async function loadIsStoryKbFormat() {
  try {
    const mod = await import(pathToFileURL(path.join(repoRoot, 'src/shared/session-attachment-rag/chunking.ts')).href)
    return mod.isStoryKbFormat
  } catch (error) {
    console.warn('[verify] 无法导入 chunking.ts，退回等价内联实现:', error.message)
    return (content) => {
      const trimmed = String(content ?? '').trimStart()
      if (!trimmed.startsWith('{')) return false
      return (
        trimmed.includes('"GUR-KB-SINGLE-2.0-COMPACT"') ||
        trimmed.includes('"mobile_card_catalog"') ||
        trimmed.includes('"mobile_router"')
      )
    }
  }
}

async function verifyOutput(outputPath) {
  const failures = []
  const check = (name, ok, detail) => {
    console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures.push(name)
  }

  const raw = fs.readFileSync(outputPath, 'utf8')
  const out = JSON.parse(raw)
  const isStoryKbFormat = await loadIsStoryKbFormat()

  // 1
  check('1. isStoryKbFormat(output) === true', isStoryKbFormat(raw) === true)

  // 2
  const calibrated = out.calibrated_cards ?? []
  const tooShort = calibrated.filter((card) => String(card.card ?? '').length < 20)
  const mustBeFull = {
    八大兽影: 'CH_368。',
    炼蛊四大基本操作: '不应混淆。',
    以蛊炼人: 'CH_1021。',
    九转至尊仙胎蛊: 'CH_1021。',
    宝黄天: '渠道。',
    世界底层补充: '约38倍。',
  }
  const missingTail = []
  for (const [name, tail] of Object.entries(mustBeFull)) {
    const card = calibrated.find((c) => c.name === name)
    if (!card || !String(card.card).includes(tail)) missingTail.push(name)
  }
  check(
    '2. calibrated_cards === 22 / 正文 >= 20 字 / 6 条全文完整',
    calibrated.length === 22 && tooShort.length === 0 && missingTail.length === 0,
    `count=${calibrated.length} short=${tooShort.length} 截断=${missingTail.join(',') || '无'}`
  )

  // 3
  const conflicts = out.conflicts ?? []
  check('3. conflicts === []', conflicts.length === 0, `len=${conflicts.length}`)

  // 4
  const leakRe = PIPELINE_LEAK_RE
  let leakCount = 0
  for (const sectionName of SECTIONS) {
    for (const card of out[sectionName] ?? []) if (leakRe.test(String(card.card))) leakCount++
  }
  check('4. 流水线元数据泄漏卡 === 0', leakCount === 0, `count=${leakCount}`)

  // 5
  let tailCount = 0
  for (const card of out.character_states ?? []) if (/；说明\s*(?:Identity|Name|Category|Profile):/.test(card.card)) tailCount++
  check('5. character_states 残余「；说明 Identity:」=== 0', tailCount === 0, `count=${tailCount}`)

  // 6
  const chapterOrdinals = new Set((out.chapter_catalog ?? []).map((row) => Number(row[0])))
  let badCh = 0
  let badEv = 0
  const evidence = out.evidence_catalog ?? []
  const referencedEv = new Set()
  for (const sectionName of SECTIONS) {
    for (const card of out[sectionName] ?? []) {
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

  // 7
  const catalogLength = (out.mobile_card_catalog ?? []).length
  let badOrd = 0
  let dirtyAlias = 0
  for (const [alias, postings] of Object.entries(out.mobile_router?.aliases ?? {})) {
    if (isDirtyAlias(alias)) dirtyAlias++
    for (const posting of postings) if (!Number.isInteger(posting) || posting < 0 || posting >= catalogLength) badOrd++
  }
  const denseCatalog = (out.mobile_card_catalog ?? []).every((row, idx) => Number(row[0]) === idx)
  check(
    '7. router posting 合法 / 脏 alias === 0 / catalog 序号致密',
    badOrd === 0 && dirtyAlias === 0 && denseCatalog,
    `badOrd=${badOrd} dirtyAlias=${dirtyAlias} dense=${denseCatalog} catalog=${catalogLength}`
  )

  // 8
  let asciiKeys = 0
  for (const sectionName of SECTIONS) {
    for (const card of out[sectionName] ?? []) for (const key of card.keys ?? []) if (isPlainAsciiToken(String(key))) asciiKeys++
  }
  check('8. 纯 ASCII card.keys === 0', asciiKeys === 0, `count=${asciiKeys}`)

  // 9
  const bytes = fs.statSync(outputPath).size
  const mib = bytes / 1024 / 1024
  check('9. 文件体积 13–17 MiB', mib >= 13 && mib <= 17, `${mib.toFixed(2)} MiB (${bytes} bytes)`)

  // 额外完整性
  const idSet = new Set()
  let dupIds = 0
  for (const sectionName of SECTIONS) {
    for (const card of out[sectionName] ?? []) {
      if (idSet.has(card._id)) dupIds++
      idSet.add(card._id)
    }
  }
  const catalogIds = new Set((out.mobile_card_catalog ?? []).map((row) => String(row[1])))
  let missingFromCatalog = 0
  for (const id of idSet) if (!catalogIds.has(id)) missingFromCatalog++
  check('附. 卡片 _id 唯一 / 全部登记进 mobile_card_catalog', dupIds === 0 && missingFromCatalog === 0, `dup=${dupIds} missing=${missingFromCatalog}`)

  const orphanEvidence = evidence.length - referencedEv.size
  check('附2. evidence_catalog 无孤儿行（每行都被幸存卡引用）', orphanEvidence === 0, `orphan=${orphanEvidence} rows=${evidence.length}`)

  console.log(`\n=== 不变量自检：${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`} ===`)
  return failures.length === 0
}

function runEndToEndProbes() {
  const rel = path.relative(repoRoot, outputPathOf()).replace(/\\/g, '/')
  console.log(`\n=== 端到端回归：KB_PATH=${rel} ===`)
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', 'scripts/verify-mobile-story-rag.mjs'],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, KB_PATH: rel, KB_PROBES: '1' },
    }
  )
  if (result.status !== 0) {
    console.error(`\n[verify] 端到端回归退出码 ${result.status}`)
    process.exitCode = 1
    return false
  }
  return true
}

function outputPathOf() {
  return process.env.KB_OUTPUT ? path.resolve(repoRoot, process.env.KB_OUTPUT) : path.join(repoRoot, OUTPUT_REL)
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const args = new Set(process.argv.slice(2))
const outputPath = outputPathOf()

if (!args.has('--verify-only')) {
  const src = readBaseline()
  const startedAt = Date.now()
  const { out, stats } = cleanKb(src)

  const serialized = JSON.stringify(out)
  fs.writeFileSync(outputPath, serialized, 'utf8')

  const outMib = (Buffer.byteLength(serialized, 'utf8') / 1024 / 1024).toFixed(2)
  const srcMib = (stats.sourceBytes / 1024 / 1024).toFixed(2)
  console.log(`\n[clean] ${srcMib} MiB → ${outMib} MiB  (${((1 - Buffer.byteLength(serialized, 'utf8') / stats.sourceBytes) * 100).toFixed(1)}% 缩减) in ${Date.now() - startedAt}ms`)
  console.log('[clean] cards:', stats.sourceCards, '→', out.mobile_card_catalog.length)
  console.log('[clean] dropped: nonSubstantive=%d leak=%d shell=%d tautology=%d sameDup=%d crossDup=%d',
    stats.dropNonSubstantive, stats.dropLeak, stats.dropShell, stats.dropTautology, stats.dropSameSectionDup, stats.dropCrossSectionDup)
  console.log('[clean] state tail stripped:', stats.stripStateTail, '| placeholder names cleared:', stats.clearedName)
  console.log('[clean] evidence rows: %d → %d | aliases: %d → %d | keys: %d → %d',
    stats.evidenceBefore, stats.evidenceAfter, stats.aliasesBefore, stats.aliasesAfter, stats.keysBefore, stats.keysAfter)
  for (const sectionName of SECTIONS) {
    console.log('   %s: %d → %d', sectionName.padEnd(18), (src[sectionName] ?? []).length, (out[sectionName] ?? []).length)
  }
  console.log(`[clean] wrote ${outputPath}`)
}

if (args.has('--verify') || args.has('--verify-only')) {
  const ok = await verifyOutput(outputPath)
  if (ok && args.has('--verify')) runEndToEndProbes()
  if (!ok) process.exitCode = 1
}

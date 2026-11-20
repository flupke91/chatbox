import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const chatboxRoot = path.resolve(__dirname, '..')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@shared/')) {
      const target = path.join(chatboxRoot, 'src/shared', specifier.slice('@shared/'.length) + '.ts')
      return { url: pathToFileURL(target).href, shortCircuit: true }
    }
    if (specifier === '@capacitor-community/sqlite') {
      return {
        url: 'data:text/javascript,export class CapacitorSQLite {}; export class SQLiteConnection { constructor() {} }',
        shortCircuit: true,
      }
    }
    if (specifier === './embedding') {
      return {
        url: 'data:text/javascript,export async function embedManyWithRetry() { return [] }; export function getMobileEmbeddingModelString() { return "" }; export async function resolveMobileEmbeddingProvider() { throw new Error("No embedding model configured") }; export function validateEmbeddingBatch() {};',
        shortCircuit: true,
      }
    }
    if (specifier === './attachment-content') {
      return {
        url: 'data:text/javascript,export async function getMobileAttachmentContent() { return "" };',
        shortCircuit: true,
      }
    }
    // Renderer-only modules pulled in by mobile/engine.ts; the bench runs headless.
    if (specifier === '@/platform') {
      return {
        url: 'data:text/javascript,export default { type: "web", getConfig: async () => ({}) };',
        shortCircuit: true,
      }
    }
    if (specifier === '@/utils/telemetry') {
      return {
        url: 'data:text/javascript,export function reportTelemetry() {};',
        shortCircuit: true,
      }
    }
    if (specifier === '@/adapters' || specifier === '@/storage' || specifier === '@/stores/settingsStore') {
      return {
        url: 'data:text/javascript,export function createModel() { throw new Error("createModel unavailable in bench") }; export default { getBlob: async () => null }; export const settingsStore = { getState: () => ({}) };',
        shortCircuit: true,
      }
    }
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      if (context.parentURL?.startsWith('file://')) {
        const parentDir = path.dirname(new URL(context.parentURL).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
        const candidateTs = path.resolve(parentDir, specifier + '.ts')
        if (fs.existsSync(candidateTs)) {
          return { url: pathToFileURL(candidateTs).href, shortCircuit: true }
        }
      }
    }
    return nextResolve(specifier, context)
  },
})

const { isStoryKbFormat } = await import(
  pathToFileURL(path.join(chatboxRoot, 'src/shared/session-attachment-rag/chunking.ts')).href
)
const { MobileRagDatabase } = await import(
  pathToFileURL(path.join(chatboxRoot, 'src/renderer/platform/session-attachment-rag/mobile/db.ts')).href
)
const { SQLiteBlobVectorStore } = await import(
  pathToFileURL(path.join(chatboxRoot, 'src/renderer/platform/session-attachment-rag/mobile/vector-store.ts')).href
)
const { MobileRagIndexer } = await import(
  pathToFileURL(path.join(chatboxRoot, 'src/renderer/platform/session-attachment-rag/mobile/indexer.ts')).href
)
const { MobileLocalRagEngine } = await import(
  pathToFileURL(path.join(chatboxRoot, 'src/renderer/platform/session-attachment-rag/mobile/engine.ts')).href
)

const sqlite = new DatabaseSync(':memory:')
let lastId = 0

const realSqliteDbAdapter = {
  async open() {},
  async execute(sql) {
    sqlite.exec(sql)
    return { changes: { changes: 0 } }
  },
  async run(sql, params = []) {
    const stmt = sqlite.prepare(sql)
    const res = stmt.run(...params)
    lastId = Number(res.lastInsertRowid || 0)
    return { changes: { changes: Number(res.changes || 0), lastId } }
  },
  async executeSet(set) {
    sqlite.exec('BEGIN TRANSACTION')
    try {
      let totalChanges = 0
      for (const item of set) {
        const stmt = sqlite.prepare(item.statement)
        const res = stmt.run(...(item.values ?? []))
        totalChanges += Number(res.changes || 0)
      }
      sqlite.exec('COMMIT')
      return { changes: { changes: totalChanges } }
    } catch (err) {
      sqlite.exec('ROLLBACK')
      throw err
    }
  },
  async query(sql, params = []) {
    const stmt = sqlite.prepare(sql)
    const values = stmt.all(...params)
    return { values }
  },
}

const mockConnection = {
  async closeConnection() {},
  async createConnection() {
    return realSqliteDbAdapter
  },
}

const kbPath = process.env.KB_PATH
  ? path.resolve(chatboxRoot, process.env.KB_PATH)
  : path.join(chatboxRoot, 'patch/goal/gur-kb(2).json')
const rawKb = fs.readFileSync(kbPath, 'utf-8')

console.log('1. Testing isStoryKbFormat:', isStoryKbFormat(rawKb))

const database = new MobileRagDatabase(mockConnection)
const vectorStore = new SQLiteBlobVectorStore(database)
const indexer = new MobileRagIndexer(database, vectorStore, {
  getContent: async () => rawKb,
  resolveEmbeddingProvider: async () => {
    throw new Error('No embedding model configured')
  },
})
const engine = new MobileLocalRagEngine({
  database,
  vectorStore,
  indexer,
  resolveEmbeddingProvider: async () => {
    throw new Error('No embedding model configured')
  },
})

console.log('2. Indexing full 18.4MB gur-kb(2).json into real SQLite via MobileRagIndexer...')
const t0 = Date.now()
const attachment = await engine.createAttachment({
  sessionId: 'session_real_bench',
  messageId: 'msg_real_bench',
  attachmentStorageKey: 'gur_kb_2',
  filename: 'gur-kb(2).json',
  mimeType: 'application/json',
  fileSize: rawKb.length,
  tokenEstimate: Math.ceil(rawKb.length / 2),
})
await engine.queue
const indexDurationMs = Date.now() - t0

const [readyAtt] = await engine.getAttachments([attachment.id])
const debugSnap = await engine.getDebugSnapshot()
console.log(`Indexed in ${indexDurationMs}ms:`, {
  status: readyAtt.status,
  indexingStage: readyAtt.indexingStage,
  totalChunks: readyAtt.totalChunks,
  parentCount: debugSnap.parentCount,
  chunkCount: debugSnap.chunkCount,
})

const chStats = await realSqliteDbAdapter.query(
  'SELECT MIN(chapter_order) as min_ch, MAX(chapter_order) as max_ch, COUNT(*) as total, SUM(CASE WHEN chapter_order <= 10 THEN 1 ELSE 0 END) as ch1_10 FROM session_attachment_chunk'
)
console.log('SQLite chapter_order stats:', chStats.values[0])

const scenarios = [
  {
    id: 'S01',
    name: '青茅山开局本命蛊 (Ch1防剧透)',
    query: '方源重生回青茅山时，他的本命蛊是什么？有什么来历和作用？',
    currentChapter: 1,
    activeEntities: ['方源', '春秋蝉'],
    expectAny: ['春秋蝉'],
    forbidAny: ['至尊仙胎', '定仙游'],
  },
  {
    id: 'S02',
    name: '开窍大典资质测定 (Ch2状态准确)',
    query: '古月山寨开窍大典上，方源和古月方正测出的资质分别是什么等级？',
    currentChapter: 10,
    activeEntities: ['方源', '古月方正'],
    expectAny: ['丙等', '甲等', '古月方正', '开窍'],
    forbidAny: ['至尊仙体'],
  },
  {
    id: 'S03',
    name: '花酒行者与酒虫 (早期奇遇)',
    query: '花酒行者在青茅山留下的传承里有什么蛊虫？酒虫有什么效果？',
    currentChapter: 30,
    activeEntities: ['花酒行者', '酒虫'],
    expectAny: ['酒虫', '花酒行者'],
    forbidAny: [],
  },
  {
    id: 'S04',
    name: '人物关系检索 (relationships表)',
    query: '方源和古月方正、古月博之间是什么关系？',
    currentChapter: 50,
    activeEntities: ['方源', '古月方正', '古月博'],
    expectAny: ['古月方正', '古月博', '兄弟', '族长'],
    forbidAny: [],
  },
  {
    id: 'S05',
    name: '世界观术语检索 (terms/rules)',
    query: '蛊师的空窍和真元是如何划分等级的？一转到五转真元有什么区别？',
    currentChapter: 50,
    activeEntities: [],
    expectAny: ['空窍', '真元'],
    forbidAny: [],
  },
  {
    id: 'S06',
    name: '白凝冰与北冥冰魄体 (十绝体)',
    query: '白凝冰是什么体质？北冥冰魄体有什么特点和隐患？',
    currentChapter: 190,
    activeEntities: ['白凝冰'],
    expectAny: ['白凝冰', '北冥冰魄体', '十绝体'],
    forbidAny: [],
  },
  {
    id: 'S07',
    name: '血颅蛊与古月山寨终局 (Ch199)',
    query: '方源在青茅山是用什么蛊虫屠戮亲族提升资质的？',
    currentChapter: 200,
    activeEntities: ['方源', '血颅蛊'],
    expectAny: ['血颅蛊', '天元宝莲', '古月'],
    forbidAny: [],
  },
  {
    id: 'S08',
    name: '商量山与商心慈 (白骨山后)',
    query: '方源到商家城途中遇到的商心慈是什么身份？',
    currentChapter: 280,
    activeEntities: ['方源', '商心慈', '商燕飞'],
    expectAny: ['商心慈', '商燕飞', '商家'],
    forbidAny: [],
  },
  {
    id: 'S09',
    name: '三王传承与定仙游 (Ch405名场面)',
    query: '方源在三王福地最后关头炼成了什么仙蛊逃出生天？',
    currentChapter: 410,
    activeEntities: ['方源', '定仙游'],
    expectAny: ['定仙游', '三王'],
    forbidAny: [],
  },
  {
    id: 'S10',
    name: '狐仙福地与荡魂山 (Ch415)',
    query: '狐仙福地里的荡魂山能产出什么？方源是怎么夺取狐仙福地的？',
    currentChapter: 420,
    activeEntities: ['方源', '狐仙福地', '荡魂山'],
    expectAny: ['狐仙福地', '荡魂山', '胆识蛊'],
    forbidAny: [],
  },
  {
    id: 'S11',
    name: '北原王庭之争与八十八角真阳楼',
    query: '巨阳仙尊留下的八十八角真阳楼在北原王庭福地有什么作用？',
    currentChapter: 650,
    activeEntities: ['八十八角真阳楼', '巨阳仙尊', '黑楼兰'],
    expectAny: ['八十八角真阳楼', '巨阳', '王庭'],
    forbidAny: [],
  },
  {
    id: 'S12',
    name: '仙僵与智慧蛊 (王庭终局)',
    query: '方源变成六转仙僵后，如何利用九转智慧蛊的智慧光晕？',
    currentChapter: 680,
    activeEntities: ['方源', '智慧蛊'],
    expectAny: ['智慧蛊', '仙僵'],
    forbidAny: [],
  },
  {
    id: 'S13',
    name: '义天山大战与至尊仙胎蛊 (Ch1020)',
    query: '义天山大战中魔尊幽魂炼制的至尊仙胎蛊被谁夺走了？',
    currentChapter: 1050,
    activeEntities: ['方源', '至尊仙胎蛊', '幽魂魔尊'],
    expectAny: ['至尊仙胎蛊', '幽魂', '义天山'],
    forbidAny: [],
  },
  {
    id: 'S14',
    name: '逆流河与逆流护身印 (Ch1285)',
    query: '方源在逆流河中坚持到了最后，练成了什么仙道杀招？',
    currentChapter: 1300,
    activeEntities: ['方源', '逆流河', '逆流护身印'],
    expectAny: ['逆流河', '逆流护身印'],
    forbidAny: [],
  },
  {
    id: 'S15',
    name: '十大尊者设定',
    query: '蛊真人世界里的九转尊者有哪些？红莲魔尊和星宿仙尊分别是什么流派？',
    currentChapter: 1500,
    activeEntities: ['红莲魔尊', '星宿仙尊'],
    expectAny: ['红莲', '星宿'],
    forbidAny: [],
  },
  {
    id: 'S16',
    name: '宿命之战与宿命蛊',
    query: '天庭守护的宿命蛊为什么必须被毁掉？宿命大战的结果如何？',
    currentChapter: 2000,
    activeEntities: ['方源', '宿命蛊', '天庭'],
    expectAny: ['宿命蛊', '天庭'],
    forbidAny: [],
  },
  {
    id: 'S17',
    name: '别名路由测试 (古月方源/大爱仙尊)',
    query: '大爱仙尊炼道成尊时的名号和底蕴是什么？',
    currentChapter: 2300,
    activeEntities: ['大爱仙尊'],
    expectAny: ['方源', '大爱仙尊', '炼道'],
    forbidAny: [],
  },
  {
    id: 'S18',
    name: '伏笔与传承线索 (foreshadows)',
    query: '红莲魔尊在光阴长河布置的石莲岛传承有什么伏笔？',
    currentChapter: 1800,
    activeEntities: ['红莲魔尊', '春秋蝉'],
    expectAny: ['红莲', '石莲', '光阴'],
    forbidAny: [],
  },
  {
    id: 'S19',
    name: '时间线节点检索 (timeline)',
    query: '青茅山狼潮爆发和雷冠头狼出现的时间线事件是什么？',
    currentChapter: 160,
    activeEntities: ['方源', '雷冠头狼'],
    expectAny: ['狼潮', '雷冠头狼', '青茅山'],
    forbidAny: [],
  },
  {
    id: 'S20',
    name: '幻觉防御测试 (不存在的赛博概念)',
    query: '纳米机械仙蛊和量子纠缠杀招在哪个福地出现过？',
    currentChapter: 100,
    activeEntities: [],
    expectAny: [],
    forbidAny: ['纳米机械仙蛊', '量子纠缠杀招'],
  },
]

let passed = 0
for (const sc of scenarios) {
  const qStart = Date.now()
  const results = await engine.query({
    attachmentIds: [attachment.id],
    query: sc.query,
    plan: {
      recallTopK: 35,
      finalTopK: 6,
      storyFilter: {
        currentChapter: sc.currentChapter,
        activeEntities: sc.activeEntities,
      },
    },
  })
  const qMs = Date.now() - qStart
  const combinedText = results.map((r) => `${r.sectionPath} ${r.text}`).join('\n')

  const hitExpected =
    sc.expectAny.length === 0 || sc.expectAny.some((term) => combinedText.includes(term))
  const hitForbidden = sc.forbidAny.some((term) => combinedText.includes(term))
  const ok = hitExpected && !hitForbidden
  if (ok) passed++

  console.log(
    `[${ok ? 'PASS' : 'FAIL'}] ${sc.id} ${sc.name} (${qMs}ms, hits=${results.length}) -> Top1: ${results[0]?.sectionPath ?? 'NONE'} (score=${results[0]?.score?.toFixed(3) ?? 0})`
  )
  if (!ok) {
    console.log('   Expected any of:', sc.expectAny, 'Forbid:', sc.forbidAny)
    console.log('   Actual top results:', results.map((r) => `${r.sectionPath}: ${r.text.slice(0, 80)}`))
  }
}

console.log(`\n=== SUMMARY: ${passed}/${scenarios.length} Scenarios Passed ===`)
if (passed < scenarios.length) {
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 精简版专项探针（KB_PROBES=1 时运行）：只针对 clean-story-kb-chatbox 的产出。
// ---------------------------------------------------------------------------
if (process.env.KB_PROBES === '1' || process.env.KB_PROBES === '2') {
  const probes = [
    {
      id: 'P01',
      name: '炼蛊四大基本操作全文恢复',
      query: '炼蛊四大基本操作 升炼 合炼 平炼 逆炼',
      currentChapter: 50,
      activeEntities: [],
      assertText: (top1) => top1.includes('不应混淆'),
      label: 'Top1 含「不应混淆」',
    },
    {
      id: 'P02',
      name: '八大兽影全文恢复 + 章号保留',
      query: '八大兽影',
      currentChapter: 400,
      activeEntities: ['八大兽影'],
      assertText: (top1) =>
        ['白象元力蛊', '黑蟒缠力蛊', '棕熊本力蛊', '石龟负力蛊', '青牛痛力蛊', '鳄力蛊', '马力蛊', '猪力蛊'].every((beast) =>
          top1.includes(beast)
        ) && top1.includes('CH_368'),
      label: 'Top1 含八兽名 + CH_368',
    },
    {
      id: 'P03',
      name: '方源 Ch15 状态无后期泄漏与重复尾巴',
      query: '方源的修为境界和当前身份是什么？',
      currentChapter: 15,
      activeEntities: ['方源'],
      assertResults: (results) => {
        const lateTerms = ['至尊仙胎', '仙僵', '大爱仙尊', '六转', '九转']
        const isBad = (text) => text.includes('；说明 Identity:') || lateTerms.some((term) => text.includes(term))

        // 检索侧：返回的 character_states 快照必须干净
        const states = results.filter((r) => (r.sectionPath ?? '').startsWith('character_states'))
        const badReturned = states.filter((r) => isBad(r.text))

        // 静态侧：KB 中在 Ch15 可见的方源状态卡必须干净（避免检索侧为空时断言空转）
        const data = JSON.parse(rawKb)
        const chapterMap = new Map(data.chapter_catalog.map((row) => [Number(row[0]), Number(row[2])]))
        let visible = 0
        let badStatic = 0
        for (const card of data.character_states ?? []) {
          if (card.name !== '方源') continue
          const chs = (card.ch ?? []).map((ch) => chapterMap.get(Number(ch))).filter((n) => Number.isFinite(n))
          if (chs.length > 0 && Math.min(...chs) > 15) continue
          if (card.valid_from !== undefined && card.valid_from > 15) continue
          if (card.valid_to !== undefined && card.valid_to < 15) continue
          visible++
          if (isBad(String(card.card ?? ''))) badStatic++
        }
        return {
          ok: badReturned.length === 0 && badStatic === 0 && visible > 0,
          detail: `character_states=${states.length} badReturned=${badReturned.length} visibleAtCh15=${visible} badStatic=${badStatic}`,
        }
      },
      label: 'character_states 无后期修为 / 无重复尾巴',
    },
  ]

  const phase2Probes = [
    {
      id: 'P04',
      name: '星号词还原可搜（狗屎运仙蛊）',
      query: '狗屎运仙蛊 巨阳仙尊本命蛊',
      currentChapter: 1300,
      activeEntities: [],
      assertResults: (results) => {
        const hit = results.filter((r) => r.text.includes('狗屎运仙蛊'))
        const star = results.filter((r) => r.text.includes('****'))
        return { ok: hit.length > 0 && star.length === 0, detail: `命中狗屎运仙蛊=${hit.length} 残留****=${star.length}` }
      },
      label: 'Top 结果（任一）含「狗屎运仙蛊」且无 ****',
    },
    {
      id: 'P05',
      name: '星号词还原可搜（五行大法师）',
      query: '五行大法师 劫运坛 阵道',
      currentChapter: 2250,
      activeEntities: [],
      assertText: (top1) => top1.includes('五行大法师') && !top1.includes('五行**师') && !top1.includes('****'),
      label: 'Top1 含「五行大法师」且无星号',
    },
    {
      id: 'P06',
      name: '截断人物卡修复（马尊）',
      query: '马尊 马英杰 驭兽大师 爱马成痴',
      currentChapter: 500,
      activeEntities: ['马尊'],
      assertText: (top1) => top1.includes('马尊') && !top1.includes('…') && top1.length >= 40,
      label: 'Top1 为完整中文描述且无 …',
    },
    {
      id: 'P07',
      name: '空白章补齐（Ch28 / Ch1455）',
      query: '方源 学堂 勒索 元石 宝黄天 年蛊 价格战',
      currentChapter: 1455,
      activeEntities: [],
      assertResults: (results) => {
        const need = ['方源堵门勒索同窗元石', '方源年蛊价格战震动宝黄天']
        const found = need.filter((name) =>
          results.some((r) => (r.sectionPath ?? '') === `events:${name}` && r.text.includes('【原文印证】'))
        )
        return { ok: found.length === need.length, detail: `命中新建卡=${found.length}/${need.length} [${found.join(',')}]` }
      },
      label: '新建卡命中且带本章【原文印证】',
    },
  ]

  const activeProbes = process.env.KB_PROBES === '2' ? [...probes, ...phase2Probes] : probes
  let probesPassed = 0
  for (const probe of activeProbes) {
    const results = await engine.query({
      attachmentIds: [attachment.id],
      query: probe.query,
      plan: {
        recallTopK: 35,
        finalTopK: 6,
        storyFilter: { currentChapter: probe.currentChapter, activeEntities: probe.activeEntities },
      },
    })
    const top1 = results[0]?.text ?? ''
    let ok
    let detail
    if (probe.assertResults) {
      const verdict = probe.assertResults(results)
      ok = verdict.ok
      detail = verdict.detail
    } else {
      ok = probe.assertText(top1)
      detail = `Top1=${results[0]?.sectionPath ?? 'NONE'} (score=${results[0]?.score?.toFixed(3) ?? 0})`
    }
    if (ok) probesPassed++
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${probe.id} ${probe.name} — ${probe.label} ${ok ? '✓' : '✗'} (${detail})`)
    console.log(`   Top1 text: ${top1.replace(/\n/g, ' ').slice(0, 220)}`)
    if (!ok) {
      console.log('   All results:', results.map((r) => `${r.sectionPath}: ${r.text.slice(0, 100)}`))
    }
  }

  console.log(`\n=== PROBES: ${probesPassed}/${activeProbes.length} Passed ===`)
  if (probesPassed < activeProbes.length) {
    process.exit(1)
  }
}

# 《蛊真人》KB 清洗与 Chatbox 专用精简版生成计划（外包执行手册）

> **目标读者**：接手执行 KB 清洗脚本开发与验证的外部 Coding Agent（如 DeepSeek / Flash）。  
> **执行原则**：**纯确定性 Node.js 脚本清洗（零 LLM 调用）**，严守所有索引不变量，不覆盖原始文件，不执行 `git commit` / `git push`，完成后输出实测对比报告交由主控审核。

---

## 1. 工作区与环境约束（必读）

- **仓库根目录**：`G:\workplace\gu-chatbox`（所有命令必须先 `cd G:\workplace\gu-chatbox`）。
- **操作系统与运行方式**：Windows + PowerShell；直接用 `node` 执行 `.mjs` 脚本，**禁止使用 `pnpm`**（本机 Windows 全局 pnpm store 存在 `os error 183`）。
- **输入源（严禁使用当前工作区的旧版 `patch/goal/gur-kb(2).json`！）**：
  - 当前工作区的 `patch/goal/gur-kb(2).json` 是被回滚的旧版 `kb-2026-09-11-r04-feedback`（17.58 MiB，缺 `state_kind` / `valid_from` / `valid_to` 且 91% 引文为空）。
  - **正确清洗基线**在 git 历史 commit **`c64080b1`**（`2026-10-28` B2 构建版，22.04 MiB，41,893 catalog 条目，100% 真实原文引文，`parent_chapter_span: 1`）。
  - 读取方式：`execFileSync('git', ['show', 'c64080b1:patch/goal/gur-kb(2).json'], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' })`（或先导出到临时文件读取，清洗完删除临时文件）。
- **交付物（仅允许新增以下 2 个文件 + 1 处向后兼容的 1 行改动）**：
  1. **新增脚本**：`G:\workplace\gu-chatbox\scripts\clean-story-kb-chatbox.mjs`
  2. **新增精简 KB**：`G:\workplace\gu-chatbox\patch\goal\gur-kb-chatbox-slim.json`
  3. **可选 1 行兼容增强**：`G:\workplace\gu-chatbox\scripts\verify-mobile-story-rag.mjs` 第 108 行把硬编码的 `kbPath` 改为支持环境变量覆盖：
     ```js
     const kbPath = process.env.KB_PATH
       ? path.resolve(chatboxRoot, process.env.KB_PATH)
       : path.join(chatboxRoot, 'patch/goal/gur-kb(2).json')
     ```
- **禁止触碰**：不要修改 `patch/goal/gur-kb(2).json`、`patch/goal/gur-ai-story-game-prompt-*` 或 `src/` 下任何业务代码；不要运行 `git commit` 或 `git push`。

---

## 2. Chatbox 消费契约（`src/shared/session-attachment-rag/chunking.ts`）

清洗脚本产出必须 100% 兼容 `src/shared/session-attachment-rag/chunking.ts`（特别是 `isStoryKbFormat` 和 `chunkStoryKbObject`）：

1. **格式识别**：根对象必须保留 `"format": "GUR-KB-SINGLE-2.0-COMPACT"`、`mobile_card_catalog`、`mobile_router`。
2. **`manifest` 必留字段**：
   - `kb_name`、`schema_version: "GUR-KB-SINGLE-2.0-COMPACT"`
   - `kb_version: "kb-2026-11-20-chatbox-slim-v1"`（记录 `cleaned_from: "kb-2026-10-25-r05-chatbox-fix"`）
   - **`parent_chapter_span: 1`**（必须保留！防止 `read_session_attachment_parents` 跨章剧透）
3. **14 个正文分区**（与 `chunking.ts` 一致）：
   `calibrated_cards`, `entities`, `character_states`, `items_and_gu`, `events`, `rules`, `factions`, `locations`, `relationships`, `terms`, `claims`, `foreshadows`, `conflicts`（清空为 `[]`）, `timeline`。
4. **必留辅助表**：
   - `chapter_catalog`（2,337 行，0.04 MiB）：**原样保留，严禁重排 ordinal**（否则所有 `card.ch` 章节号都会错位！）。
   - `mobile_card_catalog`：`[ordinal, card_id, kind, priority_rank, substantive]` 五元组数组，ordinal 必须与数组下标严格一致（`0 .. N-1`）。
   - `mobile_router`: `{ aliases: { [alias]: number[] } }`，数值数组必须是重建后 `mobile_card_catalog` 的合法新 `ordinal`。
   - `evidence_catalog`：`[chapter_id, type_code, quote, micro_ref, extra_ref]`，仅保留被幸存卡片 `ev` 引用的行，并同步重映射每张卡的 `ev` 数组索引。
   - `runtime_core`：**原样保留**（`world_rules` 250 条、`cultivation_rules` 169 条、`default_resolution_rules` 3 条等）。

---

## 3. 确定性清洗步骤（严格按序执行）

### Step A：无损重建 `calibrated_cards`（解决最高优先级校准卡被拦腰截断）
> **严重陷阱预警**：`calibrated_supplements`（22 条）中的 `ch`（如 `[2334..2340]`）和 `ev`（如 `[7478..7484]`）是旧版残留的越界序号！**严禁直接复制 `calibrated_supplements.ch` 和 `.ev`**！

按以下规则一对一重建 22 张完整 `calibrated_cards`：
1. 将原始 `calibrated_cards`（32 张）按 `card.name` 分组（22 个唯一 `name`，与 `calibrated_supplements` 22 条一一对应）。
2. 对 `calibrated_supplements` 中的每一条 `sup`：
   - 取同 `name` 原分组的第一张卡的 `_id` 作为 `canonicalId`（例如 `本命蛊` → `m039962`）；记录映射 `idRemap.set(oldId, canonicalId)`（将该组其余碎片卡 ID 如 `m039963`、`m039984`、`m039985` 全部重映射到 `canonicalId`，供后续别名路由迁移使用）。
   - 拼接无损正文：
     - 取 `stmt = (sup.statement || '').trim()`、`body = (sup.text || '').trim()`；
     - 若 `body` 已包含 `stmt` 前 12 字则仅用 `body`，否则用 `${stmt} ${body}`；
     - 若 `sup.canon_status === 'player_provided_calibration'` 或 `sup.verification_status === 'player_provided'` 且正文未含“玩家提供”，尾部补充 `（玩家提供校准，非原著既定事实）`；若为 `player_calibrated_with_inference` 且未含“推测”，补充 `【推测/外推】`。
   - `ch`：取同 `name` 原 `calibrated_cards` 分组所有 `ch` 的去重升序并集（**绝不取 `sup.ch`**）。
   - `ev`：取同 `name` 原 `calibrated_cards` 分组所有 `ev` 的去重并集，最多保留前 2 个（**绝不取 `sup.ev`**）。
   - `aliases`：合并 `sup.aliases` 与原分组 `aliases` 去重。
   - `keys`：仅保留中文实体/别名（剔除 `calibrated_se…` 等截断 ASCII 键）。
   - `state_kind: "calibrated"`；在重建 `mobile_card_catalog` 时固定写 `kind = "calibrated"`, `priority_rank = 4`, `substantive = 1`。

### Step B：清除纯垃圾分区与坏卡
遍历剩余 13 个分区（`conflicts` 直接置空 `[]`，因实测 610/610 全是 `"ts记录。"` / `"duplicate record IDs require A7 resolver decision。"` / `"9f：conflicts记录。"` 残骸）：

1. **基于原 `mobile_card_catalog` 过滤**：
   - 查原 `catalogMap.get(card._id)`，若 `substantive === 0` 或 `priority_rank === 0`，直接丢弃（约 2,406 张空壳占位卡）。
2. **基于流水线元数据泄漏过滤**：
   - 正文匹配以下任意正则时直接丢弃（约 935 张）：
     ```js
     /(?:promoted_by:|record_type:|source_refs:|ord_type:|entity_candidate|A7 resolver|verification_verdict:|canon_status:canon_source|chunk_id:micro:)/i
     ```
3. **正文噪声清理（先清理再判空）**：
   - **`character_states` 尾部重复倾倒剥离**（命中约 2,424 张，可立省 ~230 KB）：
     - 若正文包含 `；说明 ` 且其后紧跟 `Identity:` / `Name:` / `Category:` / `Profile:`，直接截去从 `；说明 ` 开始的尾部重复内容，并补句号（若末尾无标点）。
   - **纯空壳 `Name:...；Category:...` 剔除**：
     - 匹配 `/^[^：:]+[：:]\s*Name:[^；;]+；Category:[^；;|]+[|｜]\s*[^。]+。?$/` 或剥去 `Name:/Category:/Identity:` 标签后剩余有效文本为空或等于 `card.name` 的卡片，直接丢弃（如 `"中洲十大古派：Name:中洲十大古派；Category:势力 | 中洲十大古派。"`）。
   - **同义反复空壳剔除**：
     - 去掉前缀 `^[^：:]+[：:]\s*` 和末尾标点后，若文本为空、长度 `< 4` 且不是数字/条款、或严格等于 `card.name`，直接丢弃。
   - **占位标题清理**：
     - 若 `card.name` 以 `未命名-legacy:` 或 `未命名-rec:` 或 `未命名-cand_` 开头（约 17,280 张），将其简化为空字符串 `""` 或保留干净短标签（注意：`chunking.ts` 第 681/788 行在 `name` 为空时会自动回退用 `id` 作为 `sectionPath` 后缀且不会把 `未命名-legacy:...` 写进 `entities` 污染倒排表！建议直接置 `name: ""`，实测还能额外省下 ~0.6 MiB）。
4. **严格去重**：
   - **同分区去重**：以 `${sectionName}|${name}|${normalizedText}` 为键，保留更早章节（`min(ch)` 更小）或更高优先级 / 更多 `ev` 的那张；被丢弃的重复卡 ID 同样写入 `idRemap.set(dupId, keptId)`。
   - **跨分区完全重复去重**：若 `(name, normalizedText)` 跨分区完全一致（且 `name` 非空、`normalizedText.length >= 15`），按分区优先级保留一张：`calibrated_cards > character_states > entities > items_and_gu > events > relationships > factions > locations > rules > terms > timeline > foreshadows > claims`，被丢弃 ID 写入 `idRemap`。

### Step C：清洗 `card.keys` 与 `mobile_router.aliases`（防倒排表膨胀）
1. **清洗每张幸存卡片的 `keys`**：
   - 删除所有纯 ASCII / 截断内部标签（匹配 `/^[a-zA-Z0-9_.\-…]+$/`，即清掉 `action`、`setting`、`info`、`foreshadow`、`setting_item_…` 等 23,670 项噪声键）；
   - 删除长度 `<= 1`、或含换行/冒号/竖线的脏键；
   - 去重；若清空后为空数组，可删除 `card.keys` 字段省字节。
2. **清洗并重映射 `mobile_router.aliases`**：
   - 第一步（先用旧 catalog 解析）：读取原始 `mobile_router.aliases`（9,393 条），先把每个 `oldOrdinal` 翻译为 `oldCardId = oldCatalog[oldOrdinal]?.[1]`，再经 `idRemap.get(oldCardId) ?? oldCardId` 映射到幸存的 `cardId` 集合（若该 `cardId` 已被清洗删除则丢弃该 posting）。
   - 第二步（清洗脏 alias 键，目标消灭 ~430 条脏键）：
     - 若 alias 以 `别名:` / `别名：` 开头，剥离前缀；
     - 若 alias 包含顿号 `、`（如 `"古月陈博、古月藻榭"`），按 `、` 拆分为多个独立 alias，继承同一组 postings；
     - 剔除满足以下任一条件的脏 alias：
       - 长度 `<= 1` 或 `> 12`（长于 12 字的几乎全是整句解释，如 `"空窍是人体要害，比心脏更重要..."`）；
       - 含标点/注释特征：`/[，。；？！：:()（）【】\[\]\|]|CH_\d|见第/`；
       - 纯 ASCII/数字 ID：`/^[a-zA-Z0-9_.\-]+$/`。
   - 第三步（重建新 catalog 后再编回新 ordinal）：见 Step E。

### Step D：Chatbox 专用字段裁剪（无损瘦身 ~3.7+ MiB）
在保留检索与防剧透所需全部字段的前提下，裁剪 Chatbox 永不消费的字段：
1. **删除顶层冗余键**：
   - 删除 `anchors`（0.57 MiB，有 `chapter_catalog` 时完全不读）；
   - 删除 `calibrated_supplements`、`calibrated_supplement_manifest`（已在 Step A 完整并入 `calibrated_cards`）；
   - 删除 `coverage_and_limits`、`encoding`（仅保留精简统计到 `mobile_stats`）。
2. **每张幸存卡片仅保留以下白名单字段**（缺省/空数组字段直接省略）：
   - `_id`, `name`（非空时）, `card`, `ch`（非空时）, `ev`（最多保留前 2 个有效引用，匹配 `chunking.ts` 第 715 行 `card.ev.slice(0, 2)`）, `keys`（非空时）, `aliases`（非空时）, `story_time`（非空时）, `state_kind`（非空时）, `valid_from`（数字时）, `valid_to`（数字时）。
   - **裁掉**：`src_ids`、`refs`、`risk_categories`（合计节省 ~3.17 MiB；确认所有 `ch` 已由 `chapter_catalog` 覆盖，不依赖 `src_ids` 兜底）。

### Step E：重建紧凑 `mobile_card_catalog`、`mobile_router.aliases` 与 `evidence_catalog`
1. **重建 `evidence_catalog`**：
   - 收集所有幸存卡片 `ev`（已截断为前 2 个）引用到的旧 `evIdx` 集合；
   - 按原顺序生成新 `newEvidenceCatalog`，记录 `evRemap: Map<oldEvIdx, newEvIdx>`；
   - 把每张幸存卡片的 `ev` 替换为新下标；同时把 `evidence_catalog` 每行末尾恒为 `null` 的占位或无用 `micro_ref` 保持兼容 5 元组 `[ch, type, quote, null, null]`（注意：`pickEvidenceQuote` 优先读 `row[2]`，确保 `row[2]` 是非空真引文且不匹配指针正则）。
2. **重建 `mobile_card_catalog`**：
   - 遍历 14 个分区的所有幸存卡片，按顺序分配致密新序号 `newOrd = 0, 1, ..., N-1`：
     `newCatalog.push([newOrd, card._id, kind, priorityRank, 1])`
   - 同步建立 `newOrdByCardId.set(card._id, newOrd)`。
3. **回填 `mobile_router.aliases`**：
   - 将 Step C 产出的 `Map<cleanAlias, Set<cardId>>` 转为新序号数组 `[...cardIds].map(id => newOrdByCardId.get(id)).filter(x => x !== undefined)`；
   - 仅保留非空数组，写入 `out.mobile_router = { aliases }`。
4. **序列化输出**：
   - 用紧凑 JSON（单行或按行切分，确保文件体积最小；Chatbox 用标准 `JSON.parse` 读取，无需 2048 字节折行填充）写入 `patch/goal/gur-kb-chatbox-slim.json`。

---

## 4. 必须通过的验证清单与验收标准

脚本执行完后，必须在 `G:\workplace\gu-chatbox` 下运行以下两项验证并把完整输出贴回审核报告：

### 验证 1：脚本内置不变量自检（全部必须为 0 错误）
1. `isStoryKbFormat(outputStr) === true`。
2. `calibrated_cards.length === 22`，每张正文长度 `>= 20` 字符，且 `八大兽影`、`炼蛊四大基本操作`、`以蛊炼人`、`九转至尊仙胎蛊`、`宝黄天`、`世界底层补充` 全文完整无截断。
3. `conflicts.length === 0`。
4. 流水线元数据泄漏卡（`promoted_by:` / `record_type:` / `entity_candidate` / `source_refs:`）为 **0**。
5. `character_states` 中残余 `；说明 Identity:` 重复尾巴为 **0**。
6. 所有幸存卡的 `ch` 序号 100% 存在于 `chapter_catalog`；所有 `ev` 序号 100% 满足 `0 <= e < evidence_catalog.length` 且 `evidence_catalog[e][2]` 非空。
7. 所有 `mobile_router.aliases` 的 posting 序号 100% 满足 `0 <= ord < mobile_card_catalog.length`，且脏 alias 数量为 **0**。
8. 纯 ASCII 内部 `card.keys` 为 **0**。
9. 文件大小目标：**13–17 MiB**（对比原 `2026-10-28` 的 `22.04 MiB` 下降 25%+）。

### 验证 2：真实 SQLite 端到端 20 场景检索回归对比
运行对比（先按第 1 节给 `scripts/verify-mobile-story-rag.mjs` 加上 `process.env.KB_PATH` 支持）：
```powershell
cd G:\workplace\gu-chatbox
$env:KB_PATH="patch/goal/gur-kb-chatbox-slim.json"
node scripts/verify-mobile-story-rag.mjs
```
- **硬性验收标准**：
  - 必须 **20/20 Scenarios Passed**（不得有任何场景退化）；
  - 额外补跑 3 条专项回归探针（可写在 `clean-story-kb-chatbox.mjs --verify` 里）：
    1. 查询 `"炼蛊四大基本操作 升炼 合炼 平炼 逆炼"`（`currentChapter: 50`）→ Top 命中必须包含完整词句 `"不应混淆"`；
    2. 查询 `"八大兽影"`（`currentChapter: 400`）→ Top 命中必须包含完整八兽名与 `"CH_368"`；
    3. 查询 `"方源"`（`currentChapter: 15`）→ 返回的 `character_states` 快照不得包含后期修为，且不含 `"；说明 Identity:"` 重复尾巴。

---

## 5. 交付汇报格式（交主控审核用）

完成后请简明回报：
1. 清洗前后体积对比（MiB）、卡片数对比（按分区）、`evidence_catalog` / `aliases` / `card.keys` 对比；
2. 验证 1 的 9 项不变量检查结果；
3. `verify-mobile-story-rag.mjs` 的导入耗时（`indexDurationMs`）、`parentCount`/`chunkCount` 与 `20/20` 场景通过摘要；
4. 3 条专项探针的 Top-1 命中文本片段。

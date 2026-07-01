# byrdocs-search-mcp 改造总计划(细化版)

## Context

用户对 MCP 做了扎实的独立评审(核验过 `typecheck`、实时 metadata、真实 wiki 页面、`wrangler deploy --dry-run` = gzip 3517.84 KiB)。结论:方向对,但现在是「可工作检索原型」,离稳定公开使用还有:一个真 bug(按年筛真题恒空)、文档/事实不一致、返回不够可交付、真题一卷一块过粗。本计划把它收敛成「可长期公开使用的公共 MCP」。**核心原则:先修准确性、工具设计、数据质量,不动架构。**

## 架构决策(已确认)
- Cloudflare Worker **Paid**($5/月,10MB 上限);`data/*.json` + `jieba-wasm` 继续打包进 Worker;暂不 R2/KV、不预建索引、不去 wasm。
- 对外收敛为 3 个清晰工具 + 1 个兼容层。

## 已核验的 Ground Truth(本计划所有实现据此)
| 事实 | 值 | 用于 |
|---|---|---|
| metadata | 1115 条(book 376 / test 571 / doc 168),已含 `filesize`(1114/1115) | #1.2 字段补全 |
| metadata `url` | 已是镜像直链 `byrdocs.cloudlay.cn/files/<md5>.pdf` | `download_url` |
| test `time` | `{start,end,semester:First/Second,stage:期中/期末}`(结构化) | 排序/筛选 |
| filetype | pdf 1067 / zip 48 | PDF/ZIP 文案 |
| 真题 wiki | 190 卷;189 有 `##` 分节;`<Choices>`(83,`+`正/`-`误,**均单正解**)、`<Blank>答案</Blank>`(100)、`<Solution>`(78)、`<Figure>`(76);7 图片卷;15 卷超 8000 字被截 | #2 按题切块 |
| 题号 | `^\d+\.`(172 卷)为主;`（数）`(10 卷)为子问;无顿号 | 切题正则 |
| 节标题 | 双语:中文(选择/单选/填空/简答/计算/证明)+ 英文(`Questions` 26、`Part I` 19) | qtype 推断 |
| **图片真实 URL** | `https://wiki.byrdocs.org/exam/${encodeURIComponent(dir)}/<src>`(**非** Astro 哈希,可靠拼接) | figures[].url |
| frontmatter `时间` | `"2024-2025学年第二学期"`(纯文本,`Number()`=NaN → 真 bug 根源) | #1.1 |
| 指南结构 | 顶层目录即分类:`沙河校区`/`海淀校区`/`学习生活`/`学生组织`/`新生入学`+散文;frontmatter 仅 `title`/`description` | campus/topic 从**路径**推 |
| 两源仓默认分支 | survival-guide=`main`,neowiki=`master`(**不同**) | git 更新须分支无关 |

---

## 一、目标工具形态(最终对外契约)

### `search_documents` — 查可下载资料(教材/试卷/资料)
**入参(zod)**:`query?`、`type?(book|test|doc)`、`course?`、`year?(int)`、`year_from?`、`year_to?`、`stage?(期中|期末)`、`semester?(First|Second)`、`content?`、`sort?(relevance|newest|oldest)`、`limit?(默认8,≤50)`、`offset?(默认0)`
**每条结果**:
```
{ id, type, title, course?, school_year?, year?, semester?, stage?, content?,
  filetype, filesize, filesize_h, detail_url, download_url, source_url, snapshot_at }
```
**顶层**:`{ total, count, offset, sort, note, results, suggestions? }`(count=0 时给 suggestions)

### `search_exam_questions` — 查真题(按卷/节/题)
**入参**:`query?`、`course?`、`school_year?("2024-2025")`、`year?(int,落在 year_start..year_end)`、`semester?`、`stage?`、`section?`、`question_no?`、`qtype?(choice|blank|freeform)`、`has_figure?(bool)`、`answer_mode?(question_only|with_answer|with_solution,默认 with_answer)`、`limit?(默认5,≤10)`
**每条结果**:
```
{ exam_title, course, school_year, semester, stage, section, question_no, qtype, has_figure,
  stem, options?[{label,text}], answer?, solution?, figures?[{src,caption,url}], url, snapshot_at }
```
`answer_mode=question_only` 时**不返回** `answer`/`solution`,且 options 不标正解。含图题且 stem 语义依赖图时,附 `note:"此题依赖图片,请打开 url 查看"`。

### `answer_guide` — 查生存指南(经验问答)
**入参**:`query`、`campus?(沙河|海淀|通用)`、`topic?`、`limit?(默认3,≤5)`
**每条结果**:`{ title, campus, topic, url, text, snapshot_at }`

### `answer_knowledge` — 兼容层(deprecated)
description 开头加弃用提示,引导用上面两个;内部改用结构化 meta(与 #1.1 共用),旧返回形状保持可用。下版本移除。

---

## 二、数据管线(`scripts/build-data.mjs`)

### 2.1 时间解析(#1.1,已半成品,保留)
`时间` → `school_year`/`year_start`(int)/`year_end`(int)/`semester(First|Second)`,正则见现码。

### 2.2 真题按题切块(三层 fallback)
```
parseExam(dir, fm, body):
  examMeta = {school_year, year_start, year_end, semester, stage, type, college, answer_completeness}
  examTitle = `${course} ${时间} ${stage} ${variant(dir)}`
  wikiUrl = `https://wiki.byrdocs.org/exam/${encodeURIComponent(dir)}/`
  figUrl(src) = `https://wiki.byrdocs.org/exam/${encodeURIComponent(dir)}/${src}`   // N2 已验证

  sections = body.split(/^##\s+/m)            // 每节含标题+正文
  chunks = []
  for (heading, content) of sections:
     qtype = inferQtype(heading)              // 见下,双语
     qs = splitQuestions(content)             // 按 /^\s*\d+\.\s/m 顶层切;（数）视为子问不切
     if 1 ≤ qs.length ≤ 100:
        for (qno, qbody) of qs:
           chunks.push(questionChunk(qbody, qtype, examMeta, examTitle, wikiUrl, figUrl))
     else:                                    // 切不动 → 按节
        chunks.push(sectionChunk(heading, content, ...))
  if chunks 为空 或 正文<200字(图片卷): chunks = [ wholeChunk(body, ...) ]   // 整卷兜底
  return chunks

inferQtype(heading):  // 归一小写后匹配
  选择|单选|单项选择|多选|choice|multiple\s*choice  → 'choice'
  填空|fill|blank                                   → 'blank'
  简答|计算|证明|分析|综合|解答|问答|大题|question|part|calculat|prove|essay → 'freeform'
  其它                                              → 'freeform'(默认,仍按题切)

extractQuestion(qbody, qtype):
  figures = [...matchAll(/<Figure src="([^"]+)"[^>]*>([\s\S]*?)<\/Figure>/)] → {src,caption,url:figUrl(src)}
  has_figure = figures.length>0
  if qtype==='choice' 且含 <Choices>:
     items = Choices 内列表项; '-'→干扰,'+'→正解; label A/B/C/… 按序
     options=[{label,text:cleanMdx(去标记)}]; answer = 正解项的 label+text
     stem = <Choices> 之前的正文(cleanMdx, <Slot/>→【】, 去 Figure)
  elif 含 <Blank>X</Blank>:
     answer = 所有 X 拼接; stem = qbody 里 <Blank>X</Blank> 替为【填空】(question_only 用), 去 Figure
  else: stem = cleanMdx(qbody 去 Figure/Solution); options/answer 视有无
  solution = <Solution>…</Solution> 内文 cleanMdx(有则取)
  stem/solution 各 slice 上限 ~1500(按题后基本不触顶)
```
**注**:`answer`/`solution`/`options` 作为**结构化字段存入 chunk**,返回文本由 `tools.ts` 按 `answer_mode` 现拼——切块阶段不丢弃答案,只在返回层按需隐藏。

### 2.3 指南切块 + campus/topic(#3.1)
现有 `##` 切块保留,每块新增:
- `campus`:路径首段 = `沙河校区`→`沙河`;`海淀校区`→`海淀`;否则 `通用`
- `topic`:路径首段原名(`学习生活`/`学生组织`/`新生入学`/`沙河校区`/`海淀校区`/散文文件名)
- chunk 加 `campus`/`topic` 字段与 meta。

### 2.4 build-info + 源仓更新(#1.7,N1)
- 更新源仓(分支无关):`git -C <dir> fetch --depth 1 origin HEAD && git -C <dir> reset --hard FETCH_HEAD`(已 clone 时);`.kb-src` 是一次性检出,`reset --hard` 只作用于它。
- 取 commit:`git -C <dir> rev-parse HEAD`。
- 写 `data/build-info.json`:`{ built_at, metadata_url, metadata_count, knowledge_count, sources:[{repo,commit}] }`(`new Date()` 在普通 node 可用)。
- **先手建占位 `data/build-info.json`**(`{"built_at":""}`)让 `tools.ts` 静态导入可解析。

---

## 三、数据 chunk schema(`data/knowledge.json`)

**真题(question)**:
```
{ id:"neowiki:<dir>#<sectionSlug>-<qno>", source:"neowiki", kind:"exam", chunk:"question",
  title:"<课程> <时间> <stage> <variant> · <section>第<qno>题", course, url:<wikiUrl>,
  section, qno, qtype, has_figure,
  stem, options?[{label,text}], answer?, solution?, figures?[{src,caption,url}],
  meta:{school_year,year_start,year_end,semester,stage,type,college,answer_completeness} }
```
**真题(section / whole 兜底)**:同上,`chunk:"section"|"whole"`,无 qno/options,`text` 存整节/整卷清洗文本。
**指南(guide)**:`{ id, source:"survival-guide", kind:"guide", chunk:"guide", title, campus, topic, url, text, meta:{...} }`

---

## 四、代码改动(file-by-file)

### `src/indexes.ts`
- `KBChunk` 类型扩:`chunk`、`section?`、`qno?`、`qtype?`、`has_figure?`、`stem?`、`options?`、`answer?`、`solution?`、`figures?`、`campus?`、`topic?`、`text?`;`meta` 放宽 `Record<string,string|number|string[]>`。
- `kbIndex` 检索字段:`["title","course","stem","text","section"]`;`storeFields` 补 `chunk/section/qno/qtype/has_figure/campus/topic`;`addAll` 映射相应字段。
- `docIndex`、`SAFE_SEARCH`、分词不变。

### `src/tools.ts`
- `searchDocuments`:入参加 `offset`/`semester`;结果补 `detail_url/download_url/source_url/filesize/filesize_h/school_year/semester/snapshot_at`;去硬编码 `filetype:"pdf"`;`humanSize()` 工具;意图词剥离(见下)、`normalizeCourse()`(全角括号→半角、trim、小 alias 表)、零结果 `suggestions`;导入 `../data/build-info.json` 取 `snapshot_at`。
- 新 `searchExamQuestions(args)`:过滤 `kbIndex`(source=neowiki)→ 结构化字段过滤(`school_year/year/semester/section/question_no/qtype/has_figure`,`year` 落在 `year_start..year_end`)→ 按 `answer_mode` 拼 `stem/options/answer/solution` 返回。
- 新 `answerGuide(args)`:过滤 `kbIndex`(source=survival-guide)+ `campus/topic` → 返回文本。
- `answerKnowledge`:保留,内部改结构化 meta 过滤;返回加 deprecated 提示字段。
- `normalizeCourse`:全角`（）`→半角,去空白;alias `高数→高等数学`、`线代→线性代数`、`概率→概率论`、`计组→计算机组成`。**alias 只在 course 参数上做,绝不动 query 内容词**(避免删掉"推荐系统"的"推荐")。
- 意图词剥离(轻量):仅从 `search_documents.query` 剥离**独立**的 `最新|最近|推荐我?|帮我找|latest|recent|newest`;若命中"最新/newest/recent"且未显式传 `sort`→默认 `sort:"newest"`。

### `src/index.ts`
- 注册 4 个工具(3 新契约 + deprecated),各自 zod schema(见第一节)与描述;server `instructions` 更新:三工具怎么选、真题可只要题干/要不要答案解析、"没有上传时间、最新=学年"。
- `fetch` 路由加:`MCP_AUTH_TOKEN` 可选鉴权(有则校验 `Authorization: Bearer`)、`/health`(读 build-info 静态计数,**不** `await getIndexes()`,N4)、`/version`(package version + build-info commit + built_at)。

### `wrangler.jsonc` / `README.md` / `package.json`
- `wrangler.jsonc:13` 注释:"免费版 3MB 上限内" → "gzip ≈3.5MB,超 Free 3MB,部署 Paid(10MB)"。
- README:PDF→PDF/ZIP;合规文案改"检索索引+必要摘录/题目片段";部署节改"目标 Paid";已知限制列"公网端点无 token/rate-limit(可设 MCP_AUTH_TOKEN 开启)";补 3 工具契约与新返回字段。
- `package.json` version → `0.3.0`。

---

## 五、分阶段落地(每阶段 `typecheck` + 需要时重生数据抽样验证再进下一阶段)
1. **阶段一(资料交付质量)**:#1.1 year 结构化(build-data)+ #1.2 字段补全 + #1.3 零结果 + #1.4 offset + #1.5 归一 + #1.6 文档 + #1.7 build-info/git。重生数据 → typecheck → 抽样。
2. **阶段二(真题产品化)**:2.2 按题切块(build-data)+ indexes 类型 + `search_exam_questions` + answer_knowledge deprecated。重生数据 → typecheck → 抽样。
3. **阶段三(指南独立+公开服务)**:2.3 指南 campus/topic + `answer_guide` + MCP_AUTH_TOKEN + /health + /version。重生数据 → typecheck → dry-run 体积。

## 六、验证矩阵
| 验证项 | 阶段 | 预期 |
|---|---|---|
| `npm run build-data` | 1 | 3 个 json;日志含各源仓 commit;真题 chunk 数(190 卷→预估 1500–3000) |
| `npm run typecheck` | 1-3 | 通过 |
| year:2024 筛真题 | 1 | 命中 2024-2025 卷(旧版必空) |
| search_documents 结果 | 1 | 含 download_url/filesize_h/filetype 实际值/snapshot_at |
| 零结果 | 1 | 有 suggestions |
| offset=8 | 1 | 返回第 9–16 条 |
| "高数" | 1 | 命中"高等数学" |
| README/wrangler | 1 | 无"PDF 文件"/"免费版 3MB 内"措辞 |
| search_exam_questions question_only | 2 | 逐题题干,**无** answer/solution,options 不标正解 |
| 含图题 | 2 | figures[].url 可访问(`/exam/<enc dir>/<src>`) |
| 双语卷 | 2 | 英文节(Questions/Part I)也切出题或降级 section,不崩 |
| answer_guide campus:沙河 | 3 | 只返回沙河校区指南 |
| MCP_AUTH_TOKEN | 3 | 设了则无 header 返回 401;不设则公开 |
| /health、/version | 3 | 不触发建索引;返回计数/版本 commit |
| dry-run 体积 | 3 | gzip < 10MB(超则更积极截 stem/solution) |

## 七、不在本轮范围
R2/KV 卸载数据、预建索引、拆 Worker、移除 jieba-wasm;重型课程别名系统;`build-data` 的 pin-commit(已记录 commit 兜底);真题图片内容理解(只给 url/提示)。

## 附:已落地前置改动
工作树已有 v0.2 改造 + 首次数据重生 + 一处 build-data 时间 meta 半成品(将被 2.2 按题重写整体吸收)。

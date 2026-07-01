# byrdocs-search-mcp

把北邮 **byrdocs 资料库 / 历年真题**的检索能力,做成一个跑在 **Cloudflare Workers** 上的 serverless **MCP server**。任何支持 MCP 的 AI 客户端（Claude Desktop、Cursor、各类 agent）插上它,就能替用户搜北邮的教材、试卷、课程资料,以及答疑用的生存指南和真题 wiki。

---

## 一、这个项目是怎么来的（前因）

几个背景拼在一起才有了这个仓库:

1. **byrdocs** 是北邮的开源资料共享站(https://byrdocs.org),收录教材扫描、历年试卷、课程资料。它还有一个**国内镜像备份站**(`byrdocs.cloudlay.cn`),脱离 Cloudflare、用 COS + 自建部署,资料文件和元数据都同步自上游。
2. 镜像站上挂了一个**网页 AI 助手 [superdocs-agent](https://github.com/Jinchen-Yang/superdocs-agent)**(Mastra + 多模型),帮同学用自然语言找资料、答新生疑问。它内部有一套检索逻辑:把资料元数据和真题/指南建成全文索引,给 LLM 当工具用。
3. 问题是:**这套检索能力被锁死在那个网页助手里**,只有它自己能用。可北邮同学日常用的是 Claude Desktop、Cursor 这些通用 AI 客户端——它们没法碰到 byrdocs 的数据。

所以就有了这个项目:**把 superdocs-agent 的检索层单独抽出来,去掉 Mastra 外壳,套上 MCP 协议,做成一个谁都能接的独立服务。**

---

## 二、它解决什么问题 / 用户什么时候会撞到这个问题

**核心问题:AI 助手默认不知道北邮有哪些资料、更没法把资料递到用户手里。** 你问通用大模型"高等数学期末卷去哪找",它只能瞎编或让你自己搜——因为北邮的资料库不在它的知识里,也没有接口让它查。

| 用户在干什么 | 没有这个 MCP | 有了它 |
|---|---|---|
| 期末复习,想要某门课的历年真题 PDF | AI 无法定位,只能让你去网站手动翻 | 调 `search_documents` 给出试卷列表 + 下载链接 |
| 想看某门课某年期末**题目本身** | AI 没有题库 | 调 `search_exam_questions` 按题返回,可控制是否含答案 |
| 新生问"沙河宿舍能用什么功率的电器" | AI 编一个不一定对的答案 | 调 `answer_guide` 返回生存指南原文 + 出处链接 |

---

## 三、数据从哪来（数据来源）

服务不连数据库,所有数据在**构建时**抓好、打成 JSON 快照,随 Worker 一起部署。由 `scripts/build-data.mjs` 生成:

| 快照 | 内容 | 来源 | 条数 |
|---|---|---|---|
| `data/metadata.json` | 资料元信息(教材/试卷/资料) | 镜像站公开接口 `byrdocs.cloudlay.cn/data/metadata.json` | 1115(book 376 / test 571 / doc 168) |
| `data/knowledge.json` | 真题按题切块 + 生存指南按节切块 | 从两个 GitHub 源仓 clone 后现建 | 真题 ~1500-3000 按题块 + 指南 ~136 块 |
| `data/build-info.json` | 构建元信息(时间、源仓 commit) | 构建时自动生成 | - |

`knowledge.json` 的两个源仓:
- **`byrdocs/bupt-survival-guide`** —— 新生生存指南,按 `##` 小节切块,链接指向线上 `guide.byrdocs.org`;
- **`byrdocs/byrdocs-neowiki`** —— 真题 wiki,按题切块(三层 fallback:按题→按节→整卷),链接指向 `wiki.byrdocs.org/exam`。

### 数据模型

三种资料类型:

- **`book`(教材)**:`title` / `authors` / `publisher` / `publish_year`(出版年)/ `isbn`。
- **`test`(历年试卷)**:`course.name` / `time{start,end,semester,stage}` / `content[原题|答案]`。
  `time.start`-`end` 是**学年区间**(如 `2018-2019`),`stage` 是 `期中|期末`。`semester` 是 `First/Second`。
- **`doc`(课程资料)**:`title` / `course[].name` / `content[思维导图|题库|答案|知识点|课件]`。

**文件类型**:资料文件包含 PDF(~1067个)和 ZIP(~48个),ZIP 需下载解压,非在线预览。

**最关键的一条铁律:byrdocs 数据没有"上传/提交时间"字段。** 要"最新的试卷"→ 用 `search_documents(type="test", sort="newest")`——按学年从新到旧,**不要把"最新"写进 `query`**。

---

## 四、提供的能力（四个 MCP 工具）

### `search_documents` — 查可下载的资料文件

搜元信息,返回标题、课程、学年、阶段、文件类型(PDF/ZIP)、文件大小、下载链接。

| 参数 | 说明 |
|---|---|
| `query` | 内容关键词,可选。别放"最新/最近"等意图词 |
| `type` | `book` / `test` / `doc` |
| `course` | 课程名,支持别名(如"高数"→"高等数学") |
| `year` / `year_from` / `year_to` | 按学年筛选 |
| `stage` | `期中` / `期末` |
| `semester` | `First` / `Second` |
| `content` | 文件内容类型 |
| `sort` | `relevance`(需 query) / `newest` / `oldest` |
| `limit` | 返回条数,默认 8 |
| `offset` | 分页偏移,默认 0 |

每条结果包含:`id` / `type` / `title` / `course` / `school_year` / `year` / `semester` / `stage` / `content` / `filetype` / `filesize` / `filesize_h` / `detail_url` / `download_url` / `source_url` / `snapshot_at`。

零结果时返回 `suggestions`(如"可尝试放宽学年范围""可改用 search_exam_questions")。

### `search_exam_questions` — 查真题题目

按题/节/卷返回真题正文,支持 `answer_mode` 控制答案暴露。

| 参数 | 说明 |
|---|---|
| `query` | 内容关键词 |
| `course` | 课程名 |
| `school_year` | 学年区间,如 `"2024-2025"` |
| `year` | 学年,如 2024 |
| `semester` / `stage` | 学期/阶段 |
| `section` | 节标题,如 `"选择题"` / `"填空"` |
| `question_no` | 题号,如 `"6"` |
| `qtype` | `choice` / `blank` / `freeform` |
| `has_figure` | 是否含图 |
| `answer_mode` | `question_only`(只要题干) / `with_answer`(含答案,默认) / `with_solution`(含解析) |
| `limit` | 默认 5,≤10 |

三层 fallback:能切题→按题返回;能切节→按节返回;图片卷/异常→整卷返回。

### `answer_guide` — 查生存指南

返回校园生活经验正文 + 出处 URL。支持 `campus`(沙河/海淀)和 `topic` 筛选。

### `answer_knowledge` — 已弃用（兼容层）

**⚠️ 请改用 `search_exam_questions`（查真题）或 `answer_guide`（查指南）。** 本工具将在未来版本移除。内部已改用结构化年份字段过滤。

---

## 五、架构

```
MCP 客户端 ──/mcp(Streamable HTTP)或 /sse(SSE)──▶ Cloudflare Worker(Paid)
                                                      │ McpAgent(跑在 Durable Object 里,承载会话)
                                                      │ 冷启动:jieba-wasm 初始化 + minisearch 现建两套索引
                                                      ▼
                                            打包进 Worker 的 data/*.json
```

代码分层(`src/`):

| 文件 | 职责 |
|---|---|
| `index.ts` | MCP 门面:注册四个工具、挂 /mcp+/sse 端点、鉴权、/health、/version |
| `tools.ts` | 检索逻辑:search_documents / search_exam_questions / answer_guide / answer_knowledge |
| `indexes.ts` | 用 minisearch 从 JSON 快照现建两套索引(模块级只建一次,同 isolate 复用) |
| `tokenize.ts` | jieba-wasm 中文分词 |

### 关键技术决策

- **Serverless、数据打包进 Worker、不接数据库**:没请求就不占资源;有请求平台临时拉起,冷启动时用 minisearch 在内存里现建索引。代价是数据更新要重新部署。
- **分词用 WASM 版 jieba**:Cloudflare Workers 不是 Node 环境,跑不了原生 `nodejs-jieba`,但 WASM 能跑。
- **搜索健壮性**:jieba 会把 query 切出很多中文单字,若对单字也开前缀+模糊匹配,候选爆炸。所以:**只对 ≥2 字的词开前缀匹配、≥4 字的词开模糊匹配**。
- **真题按题切块**:用三层 fallback（按题→按节→整卷）保证不丢失内容。

---

## 六、本地跑

```bash
npm install          # 会自动 copy-wasm
npm run dev          # wrangler dev,起本地 Worker
# 打开 http://localhost:8787/ 看说明;MCP 端点是 /mcp 和 /sse
npm run typecheck    # tsc --noEmit
```

## 七、部署

```bash
npx wrangler login   # 登录 Cloudflare 账号
npm run deploy
```

> ⚠️ 包体 gzip ≈3.5MB,超 Cloudflare Free 版 3MB 上限,**需要 Paid 版($5/月,10MB 上限)**。

### 鉴权（可选）

通过 wrangler secret 或 vars 设置 `MCP_AUTH_TOKEN`:
- 设了 → MCP 端点需要 `Authorization: Bearer <token>` 头
- 不设 → 公开服务
- `/health` 和 `/version` 始终不需要鉴权

## 八、刷新数据

真题/指南更新或资料库变动后,在能访问 GitHub 的机器上:

```bash
npm run build-data   # 重拉 metadata + 从 GitHub 现建 knowledge + build-info
npm run deploy       # 把新数据打进 Worker
```

`build-data` 每次会 fetch + reset 源仓(不再"目录存在就跳过"),并记录源仓 commit 到 `data/build-info.json`。

## 九、端点

| 路径 | 说明 |
|---|---|
| `POST /mcp` | MCP Streamable HTTP 端点 |
| `/sse` | MCP SSE 端点 |
| `GET /health` | 健康检查,返回索引条数 |
| `GET /version` | 版本信息,返回 version + build 时间 + 源仓 commit |
| `GET /` | 说明页 |

## 十、接到 Claude Desktop

```jsonc
{
  "mcpServers": {
    "byrdocs-search": {
      "command": "npx",
      "args": ["mcp-remote", "https://byrdocs-search-mcp.<你的子域>.workers.dev/sse"]
    }
  }
}
```

---

## 已知限制

| 限制 | 现状 | 后续 |
|---|---|---|
| 公网端点无默认鉴权 | 可设 `MCP_AUTH_TOKEN` 开启 Bearer token | 已实现,部署时按需设置 |
| 无速率限制 | 可被刷请求消耗 CPU 配额 | 考虑 Cloudflare WAF 或内置 rate limit |
| 数据更新需手动部署 | `build-data` + `deploy` | 考虑 GitHub Actions 自动化 |
| 真题含图题只能给 URL 提示 | 图片不能直接返回给 agent | 考虑返回图片 base64 或代理 |
| 课程别名有限 | 只有 ~12 个别名 | 可扩展 `COURSE_ALIAS` 表 |

## 许可

检索逻辑源自 superdocs-agent;真题/指南内容版权归 byrdocs 及各源仓库(CC-BY-NC-SA 等)。本项目只做检索索引,返回必要的摘录/题目片段,不分发完整原文文件。
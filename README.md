# byrdocs-search-mcp

北邮 **byrdocs 资料 / 真题检索**的 serverless **MCP**,跑在 **Cloudflare Workers** 上。
任何支持 MCP 的 AI 客户端(Claude Desktop、Cursor、各种 agent)插上就能搜北邮资料和历年真题。

检索逻辑移植自 [superdocs-agent](https://github.com/Jinchen-Yang/superdocs-agent),去掉 Mastra 壳、分词换成 WASM 版 jieba。

## 暴露的工具

| 工具 | 作用 |
|---|---|
| `search_documents` | 搜 byrdocs 资料元信息(教材/试卷/资料),返回标题、课程、学年(试卷为学年区间如 `2018-2019`)、阶段(期中/期末)+ 详情页链接 `byrdocs.cloudlay.cn/?q=<md5>` |
| `answer_knowledge` | 一步搜新生答疑知识库(生存指南 + 真题wiki),返回可直接据此作答的正文 + 出处 url(`guide.byrdocs.org` / `wiki.byrdocs.org/exam`) |

## 架构(为什么这么搭)

```
MCP 客户端 ──/mcp(Streamable HTTP)──▶ Cloudflare Worker(McpAgent)
                                          │ 冷启动:jieba-wasm 初始化 + minisearch 现建索引
                                          ▼
                                   打包进 Worker 的 data/metadata.json + knowledge.json
```

- **无服务器**:没请求不占资源、不烧钱;有请求平台临时拉起。
- **数据打包进 Worker**:`data/*.json`(~1.5MB)+ jieba wasm(~4MB),gzip 后约 ~2MB,在免费版 3MB 上限内。数据再涨就改放 R2 运行时拉。
- **分词用 `jieba-wasm`**:Worker 跑不了原生 `nodejs-jieba`,但 WASM 能跑(byrdocs 前端也用它)。

## 本地跑

```bash
npm install
npm run dev          # wrangler dev,起本地 Worker
# 访问 http://localhost:8787/  看说明;MCP 端点是 /mcp 和 /sse
```

## 部署

```bash
npx wrangler login   # 登录 Cloudflare 账号(免费即可)
npm run deploy       # 部署,拿到 https://byrdocs-search-mcp.<你的子域>.workers.dev
```

## 接到 Claude Desktop

`claude_desktop_config.json` 里加(用 mcp-remote 桥接 HTTP MCP):

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

## 刷新数据

真题/指南更新或资料库变动后:

```bash
npm run build-data   # 重拉 metadata + 从 GitHub 现建 knowledge(需能访问 GitHub)
npm run deploy       # 把新数据打进 Worker
```

> 也可以挂 GitHub Action 定期跑 `build-data` + `deploy`,让数据自动保鲜。

## 已本地验证 ✅

`wrangler dev` 本地端到端跑通:`listTools` 返回两个工具,`search_documents`/`answer_knowledge` 真调都返回正确结果(试卷学年区间+阶段、知识库线上 wiki 链接都对)。以下都已解决:

- **jieba-wasm**:包的 `exports` 挡了直接 subpath 导入,故由 `scripts/copy-wasm.mjs`(postinstall/predev/predeploy 自动跑)把 `pkg/web/jieba_rs_wasm_bg.wasm` 拷进 `src/` 再本地导入。`src/*.wasm` 已 gitignore(装依赖时自动生成)。
- **McpAgent Durable Object**:`wrangler.jsonc` 的 `MCP_OBJECT` 绑定 + `new_sqlite_classes` migration 本地正常起。
- **依赖版本**:`package.json` 的版本已 `npm install` 验证可解析。

**唯一没实测的是线上部署本身**(需要你的 Cloudflare 账号):`wrangler deploy` 会报 gzip 后大小,若超免费版 3MB,把 `data/` + wasm 改放 R2 运行时拉(见架构说明)。

## 许可

检索逻辑源自 superdocs-agent;真题/指南内容版权归 byrdocs 及各源仓库(CC-BY-NC-SA 等),本项目只做检索索引,不再分发原文全文。

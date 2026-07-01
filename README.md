# byrdocs-search-mcp

北邮 [byrdocs](https://byrdocs.org) 资料库与历年真题的检索服务，以 [Model Context Protocol](https://modelcontextprotocol.io) 形式暴露，部署于 Cloudflare Workers。支持 MCP 的 AI 客户端接入后，即可检索教材、试卷、课程资料，以及新生生存指南与真题 wiki。

数据来自 byrdocs 国内镜像及其开源内容仓库。本服务仅建立检索索引并返回必要摘录，不分发原文文件。

## 工具

| 工具 | 用途 |
|---|---|
| `search_documents` | 检索资料元信息（教材 / 试卷 / 课程资料），返回标题、课程、学年、文件类型、大小及下载链接 |
| `search_exam_questions` | 检索真题，按题 / 节返回题干、选项、答案、解析；`answer_mode` 控制答案暴露程度 |
| `answer_guide` | 检索生存指南，返回校园生活经验正文与出处，支持按校区 / 主题筛选 |
| `answer_knowledge` | 已弃用，仅作兼容保留，请改用上述工具 |

byrdocs 元数据不含上传时间；检索中的"学年"指试卷学年区间或教材出版年。查询关键词用于全文检索，筛选（类型、学年、阶段、学期等）请使用对应参数。

## 数据来源

| 快照 | 内容 | 来源 |
|---|---|---|
| `data/metadata.json` | 资料元信息（教材 / 试卷 / 课程资料） | 镜像接口 `byrdocs.cloudlay.cn/data/metadata.json` |
| `data/knowledge.json` | 真题按题 / 节切块，指南按节切块 | GitHub：`byrdocs/byrdocs-neowiki`、`byrdocs/bupt-survival-guide` |
| `data/build-info.json` | 构建时间与源仓 commit | 构建时生成 |

数据在构建时抓取并打包进 Worker，随部署一同发布。

## 架构

```
MCP 客户端 ──/mcp | /sse──▶ Cloudflare Worker（McpAgent / Durable Object）
                              首次请求：jieba-wasm 分词 + MiniSearch 建索引（内存，isolate 内复用）
                              数据：打包进 Worker 的 data/*.json
```

- 无服务器，数据随代码部署，索引在运行时按需构建。
- 中文分词使用 `jieba-wasm`（Workers 环境不支持原生实现）。
- 包体 gzip 约 3.3 MB，需 Cloudflare Workers 付费方案（脚本上限 10 MB）。

## 快速开始

```bash
npm install
npm run dev          # 本地启动，默认 http://localhost:8787
npm run typecheck
```

部署：

```bash
npx wrangler login
npm run deploy
```

## 接入

Claude Desktop（`claude_desktop_config.json`，经 `mcp-remote` 桥接）：

```jsonc
{
  "mcpServers": {
    "byrdocs-search": {
      "command": "npx",
      "args": ["mcp-remote", "https://<your-worker>.workers.dev/sse"]
    }
  }
}
```

Cursor 等支持 HTTP MCP 的客户端可直接填写 `https://<your-worker>.workers.dev/mcp`。

鉴权（可选）：设置环境变量 `MCP_AUTH_TOKEN`（`wrangler secret` 或 vars）后，`/mcp` 与 `/sse` 需携带 `Authorization: Bearer <token>`；`/health` 与 `/version` 不受限。

## 端点

| 路径 | 说明 |
|---|---|
| `POST /mcp` | MCP Streamable HTTP |
| `GET /sse` | MCP SSE |
| `GET /health` | 健康检查，返回索引条数 |
| `GET /version` | 版本、构建时间、源仓 commit |

## 数据更新

```bash
npm run build-data   # 重新抓取 metadata，并从 GitHub 源仓重建 knowledge
npm run deploy
```

需可访问 GitHub。`build-data` 会将源仓更新至最新并记录 commit 至 `data/build-info.json`。

## 许可

检索逻辑源自 [superdocs-agent](https://github.com/Jinchen-Yang/superdocs-agent)。真题与指南内容版权归 byrdocs 及各源仓库（CC-BY-NC-SA 等）。本项目仅建立检索索引并返回必要摘录，不分发完整原文文件。

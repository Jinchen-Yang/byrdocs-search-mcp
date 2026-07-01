以下是为您整理的简洁、严肃风格的 README 文档：


# byrdocs-search-mcp

北邮 **byrdocs 资料库 / 历年真题**检索能力的 Serverless MCP 实现。本项目将检索层从 [superdocs-agent](https://github.com/Jinchen-Yang/superdocs-agent) 中解耦，封装为标准 MCP 协议服务，部署于 Cloudflare Workers。支持 Claude Desktop、Cursor 等 AI 客户端直接调用，实现对北邮教材、试卷、课程资料及生存指南的结构化检索。

## 核心功能

| 工具 | 描述 |
| :--- | :--- |
| `search_documents` | 检索可下载的资料文件（教材/试卷/课件），返回元数据及下载链接 |
| `search_exam_questions` | 按题/节/卷粒度检索真题正文，支持答案模式控制 |
| `answer_guide` | 检索新生生存指南，返回经验正文及出处 |
| `answer_knowledge` | ⚠️ **已弃用**。请迁移至 `search_exam_questions` 或 `answer_guide` |

## 架构与数据

- **运行时**：Cloudflare Workers (Paid Plan) + Durable Objects (McpAgent)
- **数据存储**：无外部数据库。所有数据在构建时生成 JSON 快照 (`data/*.json`) 并打包进 Worker
- **检索引擎**：冷启动时基于 `minisearch` 内存建索引；中文分词采用 `jieba-wasm`
- **数据来源**：
  - 资料元数据：`byrdocs.cloudlay.cn` 公开接口
  - 真题/指南内容：`byrdocs/bupt-survival-guide` & `byrdocs/byrdocs-neowiki` 源仓构建

> **注意**：byrdocs 数据无上传时间字段。获取最新试卷请使用 `sort="newest"` 参数，勿在 query 中包含"最新"等意图词。

## 本地开发

```bash
npm install          # 安装依赖并自动复制 WASM 文件
npm run dev          # 启动本地 Wrangler 开发服务器 (http://localhost:8787)
npm run typecheck    # 类型检查
```

## 部署

```bash
npx wrangler login
npm run deploy
```

> ⚠️ **套餐要求**：构建产物 gzip 后约 3.5MB，超出 Free 版限制，**必须使用 Cloudflare Paid 计划** ($5/月)。

### 鉴权配置

通过 Wrangler Secrets 设置 `MCP_AUTH_TOKEN`：
- 已设置：MCP 端点需携带 `Authorization: Bearer <token>`
- 未设置：服务公开访问
- `/health` 与 `/version` 端点始终免鉴权

## 数据更新

资料库或源仓变更后，需重新构建并部署：

```bash
npm run build-data   # 拉取最新 metadata + 重建 knowledge 索引
npm run deploy       # 部署包含新数据的 Worker
```

## API 端点

| 路径 | 方法 | 说明 |
| :--- | :--- | :--- |
| `/mcp` | POST | MCP Streamable HTTP 传输 |
| `/sse` | GET | MCP SSE 传输 |
| `/health` | GET | 健康检查（返回索引条数） |
| `/version` | GET | 版本及构建信息 |

## 客户端接入示例 (Claude Desktop)

```jsonc
{
  "mcpServers": {
    "byrdocs-search": {
      "command": "npx",
      "args": ["mcp-remote", "https://.workers.dev/sse"]
    }
  }
}
```

## 已知限制

- 无内置速率限制，建议配合 Cloudflare WAF 使用
- 数据更新依赖手动构建部署（计划接入 CI/CD）
- 含图真题仅返回 URL 提示，暂不支持图片内容直出
- 课程别名映射表有限，按需扩展 `COURSE_ALIAS`

## 许可

逻辑来自 superdocs-agent；真题及指南内容版权归 byrdocs 及各源仓库所有 (CC-BY-NC-SA 等)。本项目仅提供检索索引与必要摘录，不分发完整原始文件。
```

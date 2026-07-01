// byrdocs-search MCP —— Cloudflare Workers 入口。
// 用 agents 的 McpAgent 暴露 MCP(Streamable HTTP /mcp + SSE /sse)。工具注册与 Node 端共用 register-tools。
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getIndexes, buildInfo } from "./indexes";
import { configureDeps } from "./deps";
import { registerTools, SERVER_INSTRUCTIONS } from "./register-tools";

// 注入 Worker 平台的索引/构建信息(tools.ts 通过 deps 取,不直接依赖平台 indexes)。
configureDeps({ getIndexes, buildInfo });

export class ByrdocsSearchMCP extends McpAgent {
  server = new McpServer(
    { name: "byrdocs-search", version: "0.3.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  async init() {
    registerTools(this.server);
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 鉴权(MCP_AUTH_TOKEN 可选,通过 wrangler secret 或 vars 设置)
    const authToken = (env as any)?.MCP_AUTH_TOKEN;
    if (authToken) {
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${authToken}`) {
        if (url.pathname !== "/health" && url.pathname !== "/version") {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
      }
    }

    if (url.pathname === "/mcp") {
      return ByrdocsSearchMCP.serve("/mcp").fetch(request, env as any, ctx);
    }
    if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
      return ByrdocsSearchMCP.serveSSE("/sse").fetch(request, env as any, ctx);
    }
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", indexes: { docs: buildInfo.metadata_count, kb: buildInfo.knowledge_count } }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname === "/version") {
      return new Response(
        JSON.stringify({ version: "0.3.0", built_at: buildInfo.built_at, sources: buildInfo.sources }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      [
        "byrdocs-search MCP v0.3.0",
        "端点:POST /mcp (Streamable HTTP) 或 /sse (SSE)",
        "工具:search_documents / search_exam_questions / answer_guide",
        "健康检查:GET /health  版本:GET /version",
        "",
        "数据无上传时间:找最新试卷用 search_documents(type=test, sort=newest)。",
      ].join("\n"),
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  },
};

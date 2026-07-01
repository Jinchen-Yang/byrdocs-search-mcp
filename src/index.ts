// byrdocs-search MCP —— Cloudflare Workers serverless。
// 用 agents 的 McpAgent 暴露 MCP(Streamable HTTP /mcp + SSE /sse),两个检索工具。
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchDocuments, answerKnowledge } from "./tools";

export class ByrdocsSearchMCP extends McpAgent {
  server = new McpServer({ name: "byrdocs-search", version: "0.1.0" });

  async init() {
    this.server.tool(
      "search_documents",
      "检索北邮 byrdocs 资料(教材 book / 试卷 test / 资料 doc)的元信息。返回标题、课程、学年(试卷为学年区间如 2018-2019)、阶段(期中/期末)、文件类型,以及可点开看/下载的详情页链接。要「可下载的 PDF 资料」时用它。",
      {
        query: z.string().describe('搜索关键词,如 "高等数学 期末"'),
        type: z.enum(["book", "test", "doc"]).optional(),
        course: z.string().optional().describe("课程名包含匹配"),
        limit: z.number().int().min(1).max(20).optional().describe("返回条数,默认 8"),
      },
      async (args) => ({
        content: [{ type: "text", text: JSON.stringify(await searchDocuments(args)) }],
      }),
    );

    this.server.tool(
      "answer_knowledge",
      "一步检索北邮新生答疑知识库并返回可直接据此作答的相关正文:生存指南(校园生活/选课/宿舍/校园网经验)+ 真题wiki(各课程期中期末题目)。含出处 url、真题的 year/stage 等 meta。要「答疑/找经验/看真题题目本身」时用它。",
      {
        query: z.string().describe('用户问题或关键词,如 "沙河宿舍用电" / "高等数学 期末"'),
        source: z.enum(["survival-guide", "neowiki"]).optional().describe("survival-guide=生存指南, neowiki=真题"),
        course: z.string().optional().describe("课程名包含匹配"),
        kind: z.enum(["guide", "exam"]).optional(),
        topK: z.number().int().min(1).max(5).optional().describe("返回前几块,默认 3"),
      },
      async (args) => ({
        content: [{ type: "text", text: JSON.stringify(await answerKnowledge(args)) }],
      }),
    );
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      return ByrdocsSearchMCP.serve("/mcp").fetch(request, env as any, ctx);
    }
    if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
      return ByrdocsSearchMCP.serveSSE("/sse").fetch(request, env as any, ctx);
    }
    return new Response(
      "byrdocs-search MCP\n端点:POST /mcp (Streamable HTTP) 或 /sse (SSE)\n工具:search_documents, answer_knowledge\n",
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  },
};

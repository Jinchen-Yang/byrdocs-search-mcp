// byrdocs-search MCP —— Node 自托管入口(替代 Cloudflare Worker)。
// 纯 Node http + MCP SDK 的 StreamableHTTPServerTransport(/mcp)与 SSEServerTransport(/sse 兼容旧客户端)。
// 工具注册与检索逻辑与 Worker 共用(register-tools / tools)。
import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { configureDeps } from "../deps";
import { getIndexes, buildInfo } from "./indexes";
import { registerTools, SERVER_INSTRUCTIONS } from "../register-tools";

configureDeps({ getIndexes, buildInfo });

function makeServer(): McpServer {
  const server = new McpServer({ name: "byrdocs-search", version: "0.3.0" }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server);
  return server;
}

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const TOKEN = process.env.MCP_AUTH_TOKEN;

const streamTransports: Record<string, StreamableHTTPServerTransport> = {}; // mcp-session-id → transport
const sseTransports: Record<string, SSEServerTransport> = {}; // sessionId → transport(旧版 SSE)

function json(res: http.ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : undefined); } catch { resolve(undefined); } });
  });
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || HOST}`);
  const path = url.pathname;

  // 鉴权(MCP_AUTH_TOKEN 可选);/health /version / 不需要
  if (TOKEN && path !== "/health" && path !== "/version" && path !== "/") {
    if (req.headers["authorization"] !== `Bearer ${TOKEN}`) { json(res, 401, { error: "Unauthorized" }); return; }
  }

  if (path === "/health") { json(res, 200, { status: "ok", indexes: { docs: buildInfo.metadata_count, kb: buildInfo.knowledge_count } }); return; }
  if (path === "/version") { json(res, 200, { version: "0.3.0", built_at: buildInfo.built_at, sources: buildInfo.sources }); return; }

  // Streamable HTTP:/mcp
  if (path === "/mcp") {
    try {
      const sid = req.headers["mcp-session-id"] as string | undefined;
      let transport = sid ? streamTransports[sid] : undefined;

      if (req.method === "POST") {
        const body = await readBody(req);
        if (!transport) {
          if (isInitializeRequest(body)) {
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (id) => { streamTransports[id] = transport!; },
            });
            transport.onclose = () => { if (transport!.sessionId) delete streamTransports[transport!.sessionId]; };
            await makeServer().connect(transport);
          } else {
            json(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "无有效会话:请先发 initialize" }, id: null });
            return;
          }
        }
        await transport.handleRequest(req, res, body);
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        if (!transport) { json(res, 400, { error: "未知会话" }); return; }
        await transport.handleRequest(req, res);
        return;
      }
      json(res, 405, { error: "Method Not Allowed" });
      return;
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: String((e as Error)?.message || e) });
      return;
    }
  }

  // 旧版 SSE:GET /sse 建流,客户端再 POST /messages?sessionId=...
  if (path === "/sse" && req.method === "GET") {
    const transport = new SSEServerTransport("/messages", res);
    sseTransports[transport.sessionId] = transport;
    res.on("close", () => { delete sseTransports[transport.sessionId]; });
    await makeServer().connect(transport);
    return;
  }
  if (path === "/messages" && req.method === "POST") {
    const sid = url.searchParams.get("sessionId") || "";
    const transport = sseTransports[sid];
    if (!transport) { json(res, 400, { error: "无 SSE 会话" }); return; }
    await transport.handlePostMessage(req, res);
    return;
  }

  if (path === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end([
      "byrdocs-search MCP v0.3.0(Node 自托管)",
      "端点:POST /mcp (Streamable HTTP) 或 GET /sse (SSE)",
      "健康:GET /health  版本:GET /version",
    ].join("\n"));
    return;
  }

  json(res, 404, { error: "Not Found" });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`byrdocs-search MCP (Node) 监听 http://${HOST}:${PORT}  鉴权:${TOKEN ? "开" : "关"}`);
});

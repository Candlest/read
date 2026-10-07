import "./lib/env.js";
// HTTP 服务：静态前端 + 各领域独立的 REST（/api/<domain>/）与 MCP（/mcp/<domain>）。
// 学术与英语的数据库、上下文、工具集互相隔离。
import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./lib/mcp.js";
import { createApiRouter } from "./lib/api.js";
import { DOMAINS, storeFor } from "./lib/domains/index.js";
import { DATA_DIR } from "./lib/store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 5178);
const TOKEN = process.env.READ_TOKEN || "";
const PUBLIC_URL = (process.env.READ_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const CORS_ORIGINS = (process.env.READ_CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const LOOPBACK = ["127.0.0.1", "localhost", "::1"].includes(HOST);

if (!LOOPBACK && !TOKEN && process.env.READ_ALLOW_NO_AUTH !== "1") {
  console.error(`监听地址 ${HOST} 非本机，必须设置 READ_TOKEN（或显式设置 READ_ALLOW_NO_AUTH=1）。`);
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");

// 仅监听本机时校验 Host 头，防止 DNS rebinding 访问本地服务
if (LOOPBACK) {
  app.use((req, res, next) => {
    const host = (req.headers.host || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (["localhost", "127.0.0.1", "::1"].includes(host)) return next();
    res.status(403).send("Forbidden host");
  });
}

// 前后端分离部署时的跨域设置
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.set({
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
      Vary: "Origin",
    });
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  next();
});

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Bearer token 鉴权；iframe 与 pdf.js 无法附加请求头时使用 ?token=
function auth(req, res, next) {
  if (!TOKEN) return next();
  const header = req.headers.authorization || "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : String(req.query.token || "");
  if (given && safeEqual(given, TOKEN)) return next();
  res.status(401).json({ error: "未授权" });
}

app.use(express.json({ limit: "60mb" })); // MCP import 工具支持 base64 文件内容
app.use(express.static(path.join(HERE, "public")));
app.use("/vendor/pdfjs", express.static(path.join(HERE, "node_modules/pdfjs-dist")));
app.use("/vendor/marked", express.static(path.join(HERE, "node_modules/marked/lib")));
app.use("/vendor/dompurify", express.static(path.join(HERE, "node_modules/dompurify/dist")));
app.use("/vendor/katex", express.static(path.join(HERE, "node_modules/katex/dist")));
app.use("/vendor/marked-katex", express.static(path.join(HERE, "node_modules/marked-katex-extension/lib")));

// ---------- MCP（Streamable HTTP，无状态模式）：/mcp/academic、/mcp/english ----------

app.post("/mcp/:domain", auth, async (req, res) => {
  if (!DOMAINS[req.params.domain]) return res.status(404).json({ jsonrpc: "2.0", error: { code: -32000, message: "未知领域" }, id: null });
  const server = await createMcpServer(req.params.domain, { baseUrl: PUBLIC_URL, allowLocalFiles: false });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});
app.all("/mcp/:domain", auth, (req, res) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }),
);

// ---------- REST ----------

app.get("/api/info", auth, (req, res) =>
  res.json({
    publicUrl: PUBLIC_URL,
    auth: !!TOKEN,
    stdioEntry: path.join(HERE, "mcp-stdio.js"),
    dataDir: DATA_DIR,
    domains: Object.values(DOMAINS).map((d) => ({ id: d.id, name: d.name, mcpName: d.mcpName, cli: d.terms.cli })),
  }),
);
for (const id of Object.keys(DOMAINS)) {
  app.use(`/api/${id}`, auth, createApiRouter(id, { publicUrl: PUBLIC_URL }));
  storeFor(DOMAINS[id]).failOrphanParses();
}
app.use("/api", (req, res) => res.status(404).json({ error: `未知接口：${req.method} ${req.originalUrl}` }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || String(err) });
});

app.listen(PORT, HOST, () => {
  console.log(`阅读器：http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${PORT}`);
  for (const d of Object.values(DOMAINS)) console.log(`  ${d.name}：REST ${PUBLIC_URL}/api/${d.id}/ · MCP ${PUBLIC_URL}/mcp/${d.id}${TOKEN ? "（需 Bearer token）" : ""}`);
  console.log(`数据目录：${DATA_DIR}`);
});

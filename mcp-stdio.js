#!/usr/bin/env -S node --no-warnings
// stdio MCP 入口：供本机 agent 以子进程方式启动，参数为领域：
//   node mcp-stdio.js academic   → read-academic（论文）
//   node mcp-stdio.js english    → read-english（CET-6 英语）
// 与 Web 服务共用对应领域的 SQLite 库（WAL 模式，可同时运行）。
import "./lib/env.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./lib/mcp.js";
import { getDomain, storeFor } from "./lib/domains/index.js";

const domain = getDomain(process.argv[2] || process.env.READ_DOMAIN || "academic");
storeFor(domain).failOrphanParses();
// 本机进程可直接导入本地文件
const server = await createMcpServer(domain.id, { allowLocalFiles: true });
await server.connect(new StdioServerTransport());

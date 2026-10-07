#!/usr/bin/env node
// 命令行客户端：供带 shell 但不使用 MCP 的 agent（pi、DeepSeek 等 harness）调用，通过 REST 访问服务端。
//   read-academic <命令>   学术（论文）
//   read-english <命令>    英语（CET-6）
//   node bin/read.js <academic|english> <命令>
// 远程：READ_URL=https://host READ_TOKEN=xxx read-english writings
import fs from "node:fs";
import path from "node:path";

const BASE = (process.env.READ_URL || "http://localhost:5178").replace(/\/$/, "");
const TOKEN = process.env.READ_TOKEN || "";

let argv = process.argv.slice(2);
let domain = path.basename(process.argv[1]).match(/^read-(academic|english)/)?.[1];
if (!domain && ["academic", "english"].includes(argv[0])) domain = argv.shift();

const HELP = `用法：read-academic <命令> | read-english <命令> | node bin/read.js <academic|english> <命令>

库
  docs [--status 阅读中] [--q 关键词] [--kind news]   列出论文 / 材料
  import <arXiv ID | URL | 本地文件> [--kind news|exam|other] [--title 标题] [--parser none]
  parse <id> [parser] [--wait 300]                   重新解析 PDF
  parse-status <id>
  parsers

阅读
  context <id>                       单篇的批注与笔记（含 context_hash）
  domain-context                     学术：文库阅读记录；英语：学习上下文
  text <id> [--from 3 --to 5] [--offset 0 --max 40000]
  search <查询> [--doc id]
  annotations [--tag 标签id] [--q 关键词] [--doc id]
  profile [--set 文件]               查看或设置档案（研究背景 / 学习档案）
  sql "<SELECT ...>" | schema

写作（仅英语）
  writings [--kind essay]
  writing <writing_id>               题目、全部版本与历次反馈
  write --kind essay --title 标题 [--prompt 题目] [--file 正文.txt]      新建写作（正文可从 stdin 读取）
  write --writing <writing_id> [--file 正文.txt]                        追加新版本

词典（仅英语）
  dict-status                        词典与词表状态
  dict-import [--file ecdict.csv]    下载（或从本地文件）导入 ECDICT
  lookup <单词> [单词…]              查词：释义、原形、所属词表
  wordlist-import <名称> <文件>      导入自定义词表（每行一个词）

任务与写回
  tasks
  task <task_id> [--doc id] [--writing id] [--inline]
  save --title <标题> --agent <名称> [--model 模型] [--doc id] [--writing id --version id]
       [--task id] [--context-hash h] [--prompt-hash h] (--file out.md | stdin)
  outputs [--doc id] [--writing id] [--task id]

环境变量：READ_URL（默认 http://localhost:5178）、READ_TOKEN`;

function parseArgs(list) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith("--")) {
      const next = list[i + 1];
      if (next === undefined || next.startsWith("--")) opt[a.slice(2)] = true;
      else opt[a.slice(2)] = list[++i];
    } else pos.push(a);
  }
  return { pos, opt };
}

async function call(method, url, body) {
  const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
  const init = { method, headers };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}/api/${domain}${url}`, init);
  const data = (res.headers.get("content-type") || "").includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(typeof data === "string" ? data : data.error || JSON.stringify(data));
  return data;
}

const qs = (o) => {
  const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== true).map(([k, v]) => [k, String(v)]));
  return p.size ? `?${p}` : "";
};
const out = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
const need = (v, name) => {
  if (!v || v === true) throw new Error(`缺少参数：${name}`);
  return v;
};
const enc = encodeURIComponent;
async function readInput(opt) {
  if (opt.file) return fs.readFileSync(opt.file, "utf8");
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const { pos, opt } = parseArgs(argv);
const [cmd, a1, a2] = pos;

try {
  if (!domain) {
    out(HELP);
    process.exit(cmd ? 1 : 0);
  }
  switch (cmd) {
    case "docs":
      out((await call("GET", `/documents${qs({ status: opt.status, q: opt.q, kind: opt.kind })}`)).map(({ abstract, ...d }) => d));
      break;
    case "import": {
      const src = need(a1, "来源");
      let r;
      if (fs.existsSync(src)) {
        const fd = new FormData();
        fd.append("file", new Blob([fs.readFileSync(src)]), path.basename(src));
        if (opt.parser) fd.append("parser", opt.parser);
        if (opt.kind) fd.append("kind", opt.kind);
        r = await call("POST", "/documents/upload", fd);
      } else {
        r = await call("POST", "/documents/import", { input: src, parser: opt.parser, kind: opt.kind });
      }
      if (!r.existed && opt.title) r.doc = await call("PATCH", `/documents/${enc(r.doc.id)}`, { title: opt.title });
      out({ existed: r.existed, id: r.doc.id, title: r.doc.title, formats: r.doc.formats, textSource: r.doc.textSource, parse: r.parse ?? null, pdfDownload: r.download ?? null, parseError: r.parseError ?? null });
      break;
    }
    case "parsers":
      out(await call("GET", "/parsers"));
      break;
    case "parse": {
      const id = need(a1, "id");
      const job = await call("POST", `/documents/${enc(id)}/parse`, { parser: a2 });
      const deadline = Date.now() + Number(opt.wait || 0) * 1000;
      let cur = job;
      while (Date.now() < deadline && !["done", "failed"].includes(cur.status)) {
        await new Promise((r) => setTimeout(r, 2000));
        cur = (await call("GET", `/documents/${enc(id)}/parses`)).find((j) => j.id === job.id) || cur;
      }
      out(cur);
      break;
    }
    case "parse-status":
      out(await call("GET", `/documents/${enc(need(a1, "id"))}/parses`));
      break;
    case "context": {
      const r = await call("GET", `/documents/${enc(need(a1, "id"))}/context`);
      out(`${r.text}\n\ncontext_hash: ${r.hash}`);
      break;
    }
    case "domain-context": {
      const r = await call("GET", "/context");
      out(`${r.text}\n\ncontext_hash: ${r.hash}`);
      break;
    }
    case "text": {
      const r = await call("GET", `/documents/${enc(need(a1, "id"))}/text${qs({ page_from: opt.from, page_to: opt.to, offset: opt.offset, max_chars: opt.max })}`);
      out(`${r.text}\n\n---\ntotal_chars: ${r.totalChars}, next_offset: ${r.nextOffset ?? "null"}`);
      break;
    }
    case "search":
      out(await call("GET", `/search${qs({ q: need(a1, "查询"), doc_id: opt.doc, limit: opt.limit })}`));
      break;
    case "annotations":
      out((await call("GET", `/annotations${qs({ tag: opt.tag, q: opt.q, doc_id: opt.doc, limit: opt.limit })}`)).map(({ prefix, suffix, start, ...x }) => x));
      break;
    case "profile":
      if (opt.set) {
        await call("PUT", "/profile", { text: fs.readFileSync(opt.set, "utf8") });
        out("已保存");
      } else out((await call("GET", "/profile")).text || "（空）");
      break;
    case "sql":
      out(await call("POST", "/sql", { sql: need(a1, "SQL") }));
      break;
    case "schema":
      out(await call("GET", "/schema"));
      break;
    case "writings":
      out(await call("GET", `/writings${qs({ kind: opt.kind })}`));
      break;
    case "writing": {
      const r = await call("GET", `/writings/${enc(need(a1, "writing_id"))}/context`);
      out(`${r.text}\n\ncontext_hash: ${r.hash}`);
      break;
    }
    case "write": {
      const content = (await readInput(opt)).trim();
      const w = opt.writing
        ? await call("POST", `/writings/${enc(opt.writing)}/versions`, { content: need(content, "正文") })
        : await call("POST", "/writings", { kind: opt.kind || "essay", title: opt.title, prompt: opt.prompt || "", docId: opt.doc, content });
      out({ writing_id: w.id, version_id: w.versions.at(-1)?.id ?? null, versions: w.versions.length });
      break;
    }
    case "dict-status":
      out(await call("GET", "/dict/status"));
      break;
    case "dict-import": {
      if (opt.file) throw new Error("--file 需在服务端本机可读，请改用：node scripts/import-ecdict.js <文件>");
      await call("POST", "/dict/import-ecdict", {});
      let st;
      do {
        await new Promise((r) => setTimeout(r, 2000));
        st = await call("GET", "/dict/status");
        process.stderr.write(`\r${st.importing?.stage ?? ""} ${st.importing?.rows ?? 0} 条`);
      } while (st.importing && !st.importing.error && st.importing.stage !== "done");
      process.stderr.write("\n");
      out(st);
      break;
    }
    case "lookup":
      for (const w of pos.slice(1)) out(await call("GET", `/dict/lookup?w=${enc(w)}`));
      break;
    case "wordlist-import": {
      const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
      const res = await fetch(`${BASE}/api/${domain}/dict/lists/${enc(need(a1, "名称"))}`, { method: "PUT", headers: { ...headers, "Content-Type": "text/plain" }, body: fs.readFileSync(need(a2, "文件"), "utf8") });
      out(await res.json());
      break;
    }
    case "tasks":
      out(await call("GET", "/tasks"));
      break;
    case "task":
      out((await call("GET", `/tasks/${enc(need(a1, "task_id"))}/render${qs({ doc_id: opt.doc, writing_id: opt.writing, include_text: opt.inline ? 1 : undefined })}`)).text);
      break;
    case "save": {
      const content = (await readInput(opt)).trim();
      const r = await call("POST", "/outputs", {
        docId: opt.doc, writingId: opt.writing, versionId: opt.version, taskId: opt.task,
        title: need(opt.title, "--title"), content: need(content, "内容（--file 或 stdin）"), agent: need(opt.agent, "--agent"),
        model: opt.model, contextHash: opt["context-hash"], promptHash: opt["prompt-hash"], meta: { via: "cli" },
      });
      out({ saved: r.id });
      break;
    }
    case "outputs":
      out((await call("GET", `/outputs${qs({ doc_id: opt.doc, writing_id: opt.writing, task_id: opt.task })}`)).map((o) => ({ ...o, content: o.content.slice(0, 200) })));
      break;
    default:
      out(HELP);
      process.exitCode = cmd && cmd !== "help" ? 1 : 0;
  }
} catch (err) {
  console.error(`错误：${err.message}`);
  process.exitCode = 1;
}

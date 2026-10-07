// REST 接口：每个领域一个路由，挂载在 /api/<domain>/。
// 通用部分：文档、正文、批注、笔记、标签、档案、任务、输出、解析、只读 SQL。
// 英语领域额外提供 /writings（写作与版本）；领域级上下文 /context 内容各自不同。
import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { getDomain, storeFor, dictFor } from "./domains/index.js";
import { createImporter } from "./importer.js";
import * as parsers from "./parsers.js";
import * as tasks from "./tasks.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

export function createApiRouter(domainId, { publicUrl }) {
  const domain = getDomain(domainId);
  const store = storeFor(domain);
  const importer = createImporter(store);
  const r = express.Router();

  const needDoc = (req, res) => {
    const d = store.getDocument(req.params.id);
    if (!d) res.status(404).json({ error: `${domain.terms.doc}不存在` });
    return d;
  };
  const extraOf = (b) => (b.kind ? { kind: String(b.kind) } : {});

  r.get("/info", (req, res) =>
    res.json({
      id: domain.id,
      name: domain.name,
      mcpName: domain.mcpName,
      terms: domain.terms,
      kinds: domain.kinds,
      writingKinds: domain.writingKinds ?? null,
      hasWritings: domain.hasWritings,
      hasDictionary: !!domain.hasDictionary,
      profileLabel: domain.profileLabel,
      profilePlaceholder: domain.profilePlaceholder,
    }),
  );

  // ---------- 文档 ----------

  r.get("/documents", (req, res) => res.json(store.listDocuments({ status: req.query.status, query: req.query.q, kind: req.query.kind })));

  r.post(
    "/documents/import",
    wrap(async (req, res) => {
      const input = String(req.body.input || "").trim();
      if (!input) return res.status(400).json({ error: "请输入链接或 arXiv ID" });
      res.json(await importer.importSource(input, { parser: req.body.parser, extra: extraOf(req.body) }));
    }),
  );

  r.post(
    "/documents/upload",
    upload.single("file"),
    wrap(async (req, res) => {
      if (!req.file) return res.status(400).json({ error: "未收到文件" });
      const name = Buffer.from(req.file.originalname, "latin1").toString("utf8");
      res.json(await importer.importUploaded({ buffer: req.file.buffer, name, parser: req.body.parser, extra: extraOf(req.body) }));
    }),
  );

  r.get("/documents/:id", (req, res) => {
    const d = needDoc(req, res);
    if (d) res.json(d);
  });
  r.patch("/documents/:id", (req, res) => {
    if (needDoc(req, res)) res.json(store.updateDocument(req.params.id, req.body));
  });
  r.delete(
    "/documents/:id",
    wrap(async (req, res) => {
      await store.deleteDocument(req.params.id);
      res.json({ ok: true });
    }),
  );

  r.get(
    "/documents/:id/source.pdf",
    wrap(async (req, res) => {
      if (needDoc(req, res)) res.sendFile(store.filePath(req.params.id, "source.pdf"));
    }),
  );
  // 导入的 HTML 已清除脚本，返回时再以 CSP 禁止脚本
  r.get(
    "/documents/:id/source.html",
    wrap(async (req, res) => {
      if (!needDoc(req, res)) return;
      const html = await fs.readFile(store.filePath(req.params.id, "source.html"), "utf8");
      res.set("Content-Security-Policy", "script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'");
      res.type("html").send(html);
    }),
  );
  r.get(
    "/documents/:id/parsed/:parser/*file",
    wrap(async (req, res) => {
      const base = path.resolve(store.filePath(req.params.id, path.join("parsed", req.params.parser)));
      const target = path.resolve(base, ...[].concat(req.params.file));
      if (!target.startsWith(base + path.sep)) return res.status(400).end();
      res.sendFile(target);
    }),
  );

  // Markdown 主文本（按页），供阅读视图渲染与批注定位
  r.get("/documents/:id/markdown", (req, res) => {
    const d = needDoc(req, res);
    if (!d) return;
    const isParser = parsers.PARSERS.some((p) => p.id === d.textSource);
    res.json({
      textSource: d.textSource,
      assetsBase: isParser ? `/api/${domain.id}/documents/${d.id}/parsed/${d.textSource}/` : null,
      pages: store.getChunks(d.id).map(({ page, text }) => ({ page, text })),
    });
  });
  r.get("/documents/:id/text", (req, res) => {
    if (!needDoc(req, res)) return;
    const q = req.query;
    res.json(store.getText(req.params.id, { pageFrom: Number(q.page_from) || undefined, pageTo: Number(q.page_to) || undefined, offset: Number(q.offset) || 0, maxChars: Number(q.max_chars) || 40000 }));
  });
  r.get("/documents/:id/context", (req, res) => {
    if (!needDoc(req, res)) return;
    const c = domain.docContext(store, req.params.id);
    req.query.format === "md" ? res.type("text/markdown").send(c.text) : res.json(c);
  });

  // 解析
  r.get("/parsers", (req, res) => res.json(parsers.availableParsers()));
  r.get("/documents/:id/parses", (req, res) => res.json(store.listParses(req.params.id)));
  r.post(
    "/documents/:id/parse",
    wrap(async (req, res) => {
      if (needDoc(req, res)) res.json(await parsers.enqueueParse(store, req.params.id, req.body.parser || undefined));
    }),
  );

  // 批注
  r.get("/documents/:id/annotations", (req, res) => res.json(store.getAnnotations(req.params.id)));
  r.post("/documents/:id/annotations", (req, res) => {
    if (needDoc(req, res)) res.json(store.addAnnotation(req.params.id, req.body));
  });
  r.patch("/documents/:id/annotations/:annId", (req, res) => {
    const a = store.updateAnnotation(req.params.id, req.params.annId, req.body);
    a ? res.json(a) : res.status(404).json({ error: "批注不存在" });
  });
  r.delete("/documents/:id/annotations/:annId", (req, res) => {
    store.deleteAnnotation(req.params.id, req.params.annId);
    res.json({ ok: true });
  });
  r.get("/annotations", (req, res) => res.json(store.searchAnnotations({ docId: req.query.doc_id, tag: req.query.tag, query: req.query.q, limit: Number(req.query.limit) || 100 })));

  // 笔记
  r.get("/documents/:id/notes", (req, res) => res.json({ text: store.getNotes(req.params.id) }));
  r.put("/documents/:id/notes", (req, res) => {
    if (!needDoc(req, res)) return;
    store.saveNotes(req.params.id, String(req.body.text ?? ""));
    res.json({ ok: true });
  });

  // 检索与只读 SQL
  r.get("/search", (req, res) => res.json(store.searchText(String(req.query.q || ""), { docId: req.query.doc_id, limit: Number(req.query.limit) || 20 })));
  r.post("/sql", (req, res) => {
    try {
      res.json(store.readonlyQuery(String(req.body.sql || ""), req.body.params || []));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  r.get("/schema", (req, res) => res.type("text/plain").send(store.schema()));

  // 标签与档案
  r.get("/tags", (req, res) => res.json(store.getTags()));
  r.put("/tags", (req, res) => {
    if (!Array.isArray(req.body)) return res.status(400).json({ error: "格式错误" });
    res.json(store.saveTags(req.body));
  });
  r.get("/profile", (req, res) => res.json({ text: store.getProfile() }));
  r.put("/profile", (req, res) => {
    store.saveProfile(String(req.body.text ?? ""));
    res.json({ ok: true });
  });

  // 领域级上下文：学术为文库阅读记录，英语为学习上下文
  r.get("/context", (req, res) => {
    const c = domain.domainContext(store, { excludeDocId: req.query.exclude });
    req.query.format === "md" ? res.type("text/markdown").send(c.text) : res.json(c);
  });

  // 任务：渲染后的任务说明可直接交给任意 LLM
  r.get("/tasks", wrap(async (req, res) => res.json((await tasks.listTasks(domain)).map(({ body, ...x }) => x))));
  r.get(
    "/tasks/:taskId/render",
    wrap(async (req, res) => {
      const x = await tasks.renderTask(domain, store, req.params.taskId, {
        docId: req.query.doc_id || undefined,
        writingId: req.query.writing_id || undefined,
        includeText: req.query.include_text === "1",
        baseUrl: publicUrl,
      });
      res.json({ text: x.text, contextHash: x.contextHash, promptHash: x.task.promptHash });
    }),
  );

  // agent 输出
  r.get("/outputs", (req, res) => res.json(store.listOutputs({ docId: req.query.doc_id, writingId: req.query.writing_id, taskId: req.query.task_id })));
  r.post("/outputs", (req, res) => {
    const b = req.body;
    if (!b.title || !b.content || !b.agent) return res.status(400).json({ error: "title、content、agent 为必填" });
    if (b.docId && !store.getDocument(b.docId)) return res.status(404).json({ error: `${domain.terms.doc}不存在` });
    if (b.writingId && !store.getWriting(b.writingId)) return res.status(404).json({ error: "写作不存在" });
    res.json(store.addOutput(b));
  });
  r.delete("/outputs/:oid", (req, res) => {
    store.deleteOutput(req.params.oid);
    res.json({ ok: true });
  });

  // ---------- 写作（仅英语） ----------

  if (domain.hasWritings) {
    const needW = (req, res) => {
      const w = store.getWriting(req.params.wid);
      if (!w) res.status(404).json({ error: "写作不存在" });
      return w;
    };
    r.get("/writings", (req, res) => res.json(store.listWritings({ kind: req.query.kind })));
    r.post("/writings", (req, res) => {
      const b = req.body;
      if (b.kind && !domain.writingKinds[b.kind]) return res.status(400).json({ error: "未知写作类型" });
      res.json(store.createWriting({ kind: b.kind, title: b.title, prompt: b.prompt || "", docId: b.docId || null, content: b.content || "" }));
    });
    r.get("/writings/:wid", (req, res) => {
      const w = needW(req, res);
      if (w) res.json(w);
    });
    r.patch("/writings/:wid", (req, res) => {
      if (needW(req, res)) res.json(store.updateWriting(req.params.wid, req.body));
    });
    r.post("/writings/:wid/versions", (req, res) => {
      if (needW(req, res)) res.json(store.addVersion(req.params.wid, String(req.body.content ?? "")));
    });
    r.delete("/writings/:wid", (req, res) => {
      store.deleteWriting(req.params.wid);
      res.json({ ok: true });
    });
    r.get("/writings/:wid/context", (req, res) => {
      if (!needW(req, res)) return;
      res.json(domain.writingContext(store, req.params.wid));
    });
  }

  // ---------- 词典与词表（仅英语） ----------

  if (domain.hasDictionary) {
    const dict = dictFor(domain);
    r.get("/dict/status", (req, res) => res.json(dict.status()));
    // 后台下载并导入 ECDICT（约 66MB），进度见 /dict/status
    r.post("/dict/import-ecdict", (req, res) => {
      dict.importEcdict(req.body?.source || undefined).catch((err) => console.error("ECDICT 导入失败：", err.message));
      res.json({ started: true });
    });
    r.get("/dict/lookup", (req, res) => res.json(dict.lookup(String(req.query.w || ""))));
    r.post("/dict/mark", (req, res) => {
      const words = Array.isArray(req.body.words) ? req.body.words.slice(0, 50000) : [];
      res.json({ words: dict.mark(words, { include: req.body.include, exclude: req.body.exclude }) });
    });
    r.put("/dict/lists/:name", express.text({ type: "*/*", limit: "10mb" }), (req, res) => {
      try {
        res.json(dict.importWordlist(req.params.name, typeof req.body === "string" ? req.body : String(req.body?.text || "")));
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });
    r.delete("/dict/lists/:name", (req, res) => {
      dict.deleteWordlist(req.params.name);
      res.json({ ok: true });
    });
  }

  return r;
}

// 数据层：每个领域（academic / english）一个独立的 SQLite 库与文件目录，上下文互不可见。
//   data/<domain>/read.db          元数据、正文分块（+ FTS5）、批注、笔记、标签、档案、写作、解析任务、agent 输出
//   data/<domain>/files/<docId>/   原始 PDF / HTML 与解析产物
// 人工数据（annotations / notes / tags / profile / writings）与 agent 输出（outputs）分表存放。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.resolve(process.env.READ_DATA_DIR || path.join(ROOT, "data"));

export const now = () => new Date().toISOString();
export const newId = (prefix = "") => prefix + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
export const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,                   -- arxiv | url | upload
  kind TEXT,                              -- 领域内分类，如 english 的 news / exam
  arxiv_id TEXT,
  url TEXT,
  title TEXT NOT NULL,
  authors TEXT NOT NULL DEFAULT '[]',     -- JSON 数组
  abstract TEXT NOT NULL DEFAULT '',
  published TEXT,
  categories TEXT NOT NULL DEFAULT '[]',
  formats TEXT NOT NULL DEFAULT '[]',     -- 原始文件格式：pdf / html / text
  num_pages INTEGER,
  status TEXT NOT NULL DEFAULT '未读',    -- 未读 | 阅读中 | 已完成
  text_source TEXT NOT NULL DEFAULT 'pdfjs', -- 主文本来源：pdfjs / html / text / paddleocr-cloud …
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Markdown 主文本分块：PDF 按页，网页与纯文本按段落累积
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  page INTEGER,
  text TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id, seq);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0
);

-- 批注：以 Markdown 主文本中的摘录 + 前后文定位，摘录中的公式为 $LaTeX$
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  quote TEXT NOT NULL,
  prefix TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  page INTEGER,
  start INTEGER,                      -- 折叠空白后的文本偏移（定位提示）
  tags TEXT NOT NULL DEFAULT '[]',    -- JSON：tag id 数组
  comment TEXT NOT NULL DEFAULT '',
  text_source TEXT,                   -- 批注时的主文本来源
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS annotations_doc ON annotations(doc_id);

CREATE TABLE IF NOT EXISTS notes (
  doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 档案：领域级的用户自述（研究方向 / 学习目标与当前问题），随上下文提供给 agent
CREATE TABLE IF NOT EXISTS profile (
  key TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 写作：用户的作文、翻译等产出，每次保存一个版本
CREATE TABLE IF NOT EXISTS writings (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- essay | translation | other
  title TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',    -- 题目 / 原文
  doc_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  created_via TEXT NOT NULL DEFAULT 'ui',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS writing_versions (
  id TEXT PRIMARY KEY,
  writing_id TEXT NOT NULL REFERENCES writings(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS writing_versions_w ON writing_versions(writing_id, created_at);

CREATE TABLE IF NOT EXISTS parses (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  parser TEXT NOT NULL,
  status TEXT NOT NULL,             -- queued | running | done | failed
  error TEXT,
  pages INTEGER,
  progress_done INTEGER,
  progress_total INTEGER,
  pid INTEGER,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS parses_doc ON parses(doc_id, created_at);

-- agent 写回的输出：任务结果、写作反馈等，记录来源 agent、模型与输入快照哈希
CREATE TABLE IF NOT EXISTS outputs (
  id TEXT PRIMARY KEY,
  doc_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  writing_id TEXT REFERENCES writings(id) ON DELETE CASCADE,
  version_id TEXT,                  -- 反馈针对的写作版本
  task_id TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT,
  context_hash TEXT,                -- 生成时所依据的上下文哈希
  prompt_hash TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS outputs_doc ON outputs(doc_id, created_at);
CREATE INDEX IF NOT EXISTS outputs_writing ON outputs(writing_id, created_at);
`;

const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

const docRow = (r) =>
  r && {
    id: r.id,
    source: r.source,
    kind: r.kind,
    arxivId: r.arxiv_id,
    url: r.url,
    title: r.title,
    authors: parseJson(r.authors, []),
    abstract: r.abstract,
    published: r.published,
    categories: parseJson(r.categories, []),
    formats: parseJson(r.formats, []),
    numPages: r.num_pages,
    status: r.status,
    textSource: r.text_source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.annotation_count !== undefined && { annotationCount: r.annotation_count }),
    ...(r.output_count !== undefined && { outputCount: r.output_count }),
    ...(r.has_notes !== undefined && { hasNotes: !!r.has_notes }),
  };

const annotationRow = (r) => ({
  id: r.id,
  docId: r.doc_id,
  quote: r.quote,
  prefix: r.prefix,
  suffix: r.suffix,
  page: r.page,
  start: r.start,
  tags: parseJson(r.tags, []),
  comment: r.comment,
  textSource: r.text_source,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const outputRow = (r) => ({
  id: r.id,
  docId: r.doc_id,
  writingId: r.writing_id,
  versionId: r.version_id,
  taskId: r.task_id,
  title: r.title,
  content: r.content,
  agent: r.agent,
  model: r.model,
  contextHash: r.context_hash,
  promptHash: r.prompt_hash,
  meta: parseJson(r.meta, {}),
  createdAt: r.created_at,
});

const parseRow = (r) =>
  r && {
    id: r.id, docId: r.doc_id, parser: r.parser, status: r.status, error: r.error, pages: r.pages,
    progressDone: r.progress_done, progressTotal: r.progress_total, createdAt: r.created_at, finishedAt: r.finished_at,
  };

const stores = new Map();

/** 打开某个领域的存储；defaultTags 仅在新库中写入 */
export function openStore(domain, { defaultTags = [] } = {}) {
  if (stores.has(domain)) return stores.get(domain);
  if (!/^[a-z]+$/.test(domain)) throw new Error(`非法领域：${domain}`);

  const dir = path.join(DATA_DIR, domain);
  const filesDir = path.join(dir, "files");
  fs.mkdirSync(filesDir, { recursive: true });
  const dbPath = path.join(dir, "read.db");
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  if (db.prepare("SELECT COUNT(*) n FROM tags").get().n === 0) {
    const ins = db.prepare("INSERT INTO tags (id, name, color, description, sort) VALUES (?, ?, ?, ?, ?)");
    defaultTags.forEach((t, i) => ins.run(t.id, t.name, t.color, t.description, i));
  }

  const q = (sql) => db.prepare(sql);
  const tx = (fn) => {
    db.exec("BEGIN");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
  const where = (conds) => (conds.length ? "WHERE " + conds.join(" AND ") : "");
  const touch = (docId) => q("UPDATE documents SET updated_at = ? WHERE id = ?").run(now(), docId);
  let ro;

  const s = {
    domain,
    dbPath,

    // ---------- 文件 ----------
    docDir(id) {
      if (!/^[\w.-]+$/.test(id)) throw new Error(`非法 ID：${id}`);
      return path.join(filesDir, id);
    },
    filePath: (id, name) => path.join(s.docDir(id), name),
    async writeFile(id, name, data) {
      await fsp.mkdir(s.docDir(id), { recursive: true });
      await fsp.writeFile(s.filePath(id, name), data);
    },

    // ---------- 文档 ----------
    listDocuments({ status, query, kind } = {}) {
      const c = [];
      const a = [];
      if (status) c.push("d.status = ?"), a.push(status);
      if (kind) c.push("d.kind = ?"), a.push(kind);
      if (query) c.push("(d.title LIKE ? OR d.authors LIKE ?)"), a.push(`%${query}%`, `%${query}%`);
      return q(
        `SELECT d.*,
          (SELECT COUNT(*) FROM annotations x WHERE x.doc_id = d.id) AS annotation_count,
          (SELECT COUNT(*) FROM outputs o WHERE o.doc_id = d.id) AS output_count,
          EXISTS (SELECT 1 FROM notes n WHERE n.doc_id = d.id AND length(trim(n.text)) > 0) AS has_notes
         FROM documents d ${where(c)} ORDER BY d.updated_at DESC`,
      )
        .all(...a)
        .map(docRow);
    },
    getDocument: (id) => docRow(q("SELECT * FROM documents WHERE id = ?").get(id)),
    insertDocument(d, chunks, textSource) {
      const t = now();
      tx(() => {
        q(
          `INSERT INTO documents (id, source, kind, arxiv_id, url, title, authors, abstract, published, categories, formats, num_pages, status, text_source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          d.id, d.source, d.kind ?? null, d.arxivId ?? null, d.url ?? null, d.title,
          JSON.stringify(d.authors || []), d.abstract || "", d.published ?? null,
          JSON.stringify(d.categories || []), JSON.stringify(d.formats || []), d.numPages ?? null,
          d.status || "未读", textSource, t, t,
        );
        const ins = q("INSERT INTO chunks (doc_id, seq, page, text, source) VALUES (?, ?, ?, ?, ?)");
        chunks.forEach((c, i) => ins.run(d.id, i, c.page ?? null, c.text, textSource));
      });
      return s.getDocument(d.id);
    },
    updateDocument(id, patch) {
      for (const k of ["title", "status", "abstract", "url", "kind"]) {
        if (k in patch) q(`UPDATE documents SET ${k} = ? WHERE id = ?`).run(patch[k] == null ? null : String(patch[k]), id);
      }
      if ("authors" in patch) q("UPDATE documents SET authors = ? WHERE id = ?").run(JSON.stringify(patch.authors), id);
      if ("formats" in patch) q("UPDATE documents SET formats = ? WHERE id = ?").run(JSON.stringify(patch.formats), id);
      if ("numPages" in patch) q("UPDATE documents SET num_pages = ? WHERE id = ?").run(patch.numPages ?? null, id);
      touch(id);
      return s.getDocument(id);
    },
    async deleteDocument(id) {
      q("DELETE FROM documents WHERE id = ?").run(id);
      await fsp.rm(s.docDir(id), { recursive: true, force: true });
    },

    // ---------- 主文本 ----------
    replaceChunks(docId, chunks, source) {
      tx(() => {
        q("DELETE FROM chunks WHERE doc_id = ?").run(docId);
        const ins = q("INSERT INTO chunks (doc_id, seq, page, text, source) VALUES (?, ?, ?, ?, ?)");
        chunks.forEach((c, i) => ins.run(docId, i, c.page ?? null, c.text, source));
        q("UPDATE documents SET text_source = ?, updated_at = ? WHERE id = ?").run(source, now(), docId);
      });
    },
    getChunks: (docId) => q("SELECT seq, page, text FROM chunks WHERE doc_id = ? ORDER BY seq").all(docId),
    getText(docId, { pageFrom, pageTo, offset = 0, maxChars = 40000 } = {}) {
      let chunks = s.getChunks(docId);
      if (pageFrom || pageTo) chunks = chunks.filter((c) => c.page == null || ((!pageFrom || c.page >= pageFrom) && (!pageTo || c.page <= pageTo)));
      const full = chunks.map((c) => (c.page ? `[第 ${c.page} 页]\n${c.text}` : c.text)).join("\n\n");
      const text = full.slice(offset, offset + maxChars);
      return { text, offset, totalChars: full.length, nextOffset: offset + text.length < full.length ? offset + text.length : null };
    },
    searchText(query, { docId, limit = 20 } = {}) {
      const args = [query];
      let filter = "";
      if (docId) (filter = "AND c.doc_id = ?"), args.push(docId);
      args.push(limit);
      const stmt = q(
        `SELECT c.doc_id AS docId, d.title, c.page, snippet(chunks_fts, 0, '«', '»', '…', 48) AS snippet
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN documents d ON d.id = c.doc_id
         WHERE chunks_fts MATCH ? ${filter} ORDER BY rank LIMIT ?`,
      );
      try {
        return stmt.all(...args);
      } catch {
        args[0] = `"${query.replace(/"/g, '""')}"`; // 不符合 FTS5 语法时按短语检索
        return stmt.all(...args);
      }
    },

    // ---------- 解析任务 ----------
    addParse(docId, parser) {
      const id = newId("p");
      q("INSERT INTO parses (id, doc_id, parser, status, pid, created_at) VALUES (?, ?, ?, 'queued', ?, ?)").run(id, docId, parser, process.pid, now());
      return s.getParse(id);
    },
    updateParse(id, patch) {
      const map = { status: "status", error: "error", pages: "pages", finishedAt: "finished_at", progressDone: "progress_done", progressTotal: "progress_total" };
      const sets = [];
      const args = [];
      for (const [k, col] of Object.entries(map)) if (k in patch) sets.push(`${col} = ?`), args.push(patch[k]);
      q(`UPDATE parses SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
    },
    listParses: (docId) => q("SELECT * FROM parses WHERE doc_id = ? ORDER BY created_at DESC").all(docId).map(parseRow),
    getParse: (id) => parseRow(q("SELECT * FROM parses WHERE id = ?").get(id)),
    // 所属进程已退出的未完成任务标记为失败
    failOrphanParses() {
      for (const r of q("SELECT id, pid FROM parses WHERE status IN ('queued', 'running')").all()) {
        let alive = false;
        try {
          process.kill(r.pid, 0);
          alive = r.pid !== process.pid;
        } catch {}
        if (!alive) s.updateParse(r.id, { status: "failed", error: "进程中断，任务未完成", finishedAt: now() });
      }
    },

    // ---------- 标签 ----------
    getTags: () => q("SELECT id, name, color, description FROM tags ORDER BY sort").all(),
    saveTags(tags) {
      tx(() => {
        db.exec("DELETE FROM tags");
        const ins = q("INSERT INTO tags (id, name, color, description, sort) VALUES (?, ?, ?, ?, ?)");
        tags.forEach((t, i) => ins.run(String(t.id || newId("t")), String(t.name), String(t.color || "#888888"), String(t.description || ""), i));
      });
      return s.getTags();
    },

    // ---------- 批注 ----------
    getAnnotations: (docId) => q("SELECT * FROM annotations WHERE doc_id = ? ORDER BY page, start, created_at").all(docId).map(annotationRow),
    searchAnnotations({ docId, tag, query, limit = 100 } = {}) {
      const c = [];
      const a = [];
      if (docId) c.push("x.doc_id = ?"), a.push(docId);
      if (tag) c.push("EXISTS (SELECT 1 FROM json_each(x.tags) WHERE value = ?)"), a.push(tag);
      if (query) c.push("(x.quote LIKE ? OR x.comment LIKE ?)"), a.push(`%${query}%`, `%${query}%`);
      a.push(limit);
      return q(`SELECT x.*, d.title AS doc_title FROM annotations x JOIN documents d ON d.id = x.doc_id ${where(c)} ORDER BY x.updated_at DESC LIMIT ?`)
        .all(...a)
        .map((r) => ({ ...annotationRow(r), docTitle: r.doc_title }));
    },
    addAnnotation(docId, x) {
      const t = now();
      const id = newId("a");
      q(
        `INSERT INTO annotations (id, doc_id, quote, prefix, suffix, page, start, tags, comment, text_source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, docId, String(x.quote || ""), String(x.prefix || ""), String(x.suffix || ""), x.page ?? null, x.start ?? null,
        JSON.stringify(x.tags || []), String(x.comment || ""), s.getDocument(docId)?.textSource ?? null, t, t,
      );
      touch(docId);
      return annotationRow(q("SELECT * FROM annotations WHERE id = ?").get(id));
    },
    updateAnnotation(docId, id, patch) {
      if ("tags" in patch) q("UPDATE annotations SET tags = ? WHERE id = ? AND doc_id = ?").run(JSON.stringify(patch.tags), id, docId);
      if ("comment" in patch) q("UPDATE annotations SET comment = ? WHERE id = ? AND doc_id = ?").run(String(patch.comment), id, docId);
      q("UPDATE annotations SET updated_at = ? WHERE id = ?").run(now(), id);
      touch(docId);
      const r = q("SELECT * FROM annotations WHERE id = ? AND doc_id = ?").get(id, docId);
      return r ? annotationRow(r) : null;
    },
    deleteAnnotation(docId, id) {
      q("DELETE FROM annotations WHERE id = ? AND doc_id = ?").run(id, docId);
      touch(docId);
    },

    // ---------- 笔记与档案 ----------
    getNotes: (docId) => q("SELECT text FROM notes WHERE doc_id = ?").get(docId)?.text ?? "",
    saveNotes(docId, text) {
      q("INSERT INTO notes (doc_id, text, updated_at) VALUES (?, ?, ?) ON CONFLICT(doc_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at").run(docId, text, now());
      touch(docId);
    },
    getProfile: () => q("SELECT text FROM profile WHERE key = 'main'").get()?.text ?? "",
    saveProfile(text) {
      q("INSERT INTO profile (key, text, updated_at) VALUES ('main', ?, ?) ON CONFLICT(key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at").run(text, now());
    },

    // ---------- 写作 ----------
    listWritings({ kind, limit = 200 } = {}) {
      const c = [];
      const a = [];
      if (kind) c.push("w.kind = ?"), a.push(kind);
      a.push(limit);
      return q(
        `SELECT w.*,
          (SELECT COUNT(*) FROM writing_versions v WHERE v.writing_id = w.id) AS version_count,
          (SELECT COUNT(*) FROM outputs o WHERE o.writing_id = w.id) AS feedback_count
         FROM writings w ${where(c)} ORDER BY w.updated_at DESC LIMIT ?`,
      )
        .all(...a)
        .map((r) => ({
          id: r.id, kind: r.kind, title: r.title, prompt: r.prompt, docId: r.doc_id, createdVia: r.created_via,
          versionCount: r.version_count, feedbackCount: r.feedback_count, createdAt: r.created_at, updatedAt: r.updated_at,
        }));
    },
    getWriting(id) {
      const r = q("SELECT * FROM writings WHERE id = ?").get(id);
      if (!r) return null;
      return {
        id: r.id, kind: r.kind, title: r.title, prompt: r.prompt, docId: r.doc_id, createdVia: r.created_via,
        createdAt: r.created_at, updatedAt: r.updated_at,
        versions: q("SELECT id, content, created_at AS createdAt FROM writing_versions WHERE writing_id = ? ORDER BY created_at").all(id),
      };
    },
    createWriting({ kind = "essay", title, prompt = "", docId = null, content = "", createdVia = "ui" }) {
      const id = newId("w");
      const t = now();
      tx(() => {
        q("INSERT INTO writings (id, kind, title, prompt, doc_id, created_via, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
          id, kind, String(title || prompt.slice(0, 40) || "未命名"), String(prompt), docId, createdVia, t, t,
        );
        if (content.trim()) q("INSERT INTO writing_versions (id, writing_id, content, created_at) VALUES (?, ?, ?, ?)").run(newId("v"), id, content, t);
      });
      return s.getWriting(id);
    },
    updateWriting(id, patch) {
      for (const [k, col] of Object.entries({ kind: "kind", title: "title", prompt: "prompt", docId: "doc_id" })) {
        if (k in patch) q(`UPDATE writings SET ${col} = ? WHERE id = ?`).run(patch[k] ?? null, id);
      }
      q("UPDATE writings SET updated_at = ? WHERE id = ?").run(now(), id);
      return s.getWriting(id);
    },
    // 内容与最新版本相同时不新增版本
    addVersion(id, content) {
      const last = q("SELECT content FROM writing_versions WHERE writing_id = ? ORDER BY created_at DESC LIMIT 1").get(id);
      if (last?.content !== content) {
        q("INSERT INTO writing_versions (id, writing_id, content, created_at) VALUES (?, ?, ?, ?)").run(newId("v"), id, content, now());
        q("UPDATE writings SET updated_at = ? WHERE id = ?").run(now(), id);
      }
      return s.getWriting(id);
    },
    deleteWriting: (id) => q("DELETE FROM writings WHERE id = ?").run(id),

    // ---------- agent 输出 ----------
    listOutputs({ docId, writingId, taskId, limit = 200 } = {}) {
      const c = [];
      const a = [];
      if (docId) c.push("doc_id = ?"), a.push(docId);
      if (writingId) c.push("writing_id = ?"), a.push(writingId);
      if (taskId) c.push("task_id = ?"), a.push(taskId);
      a.push(limit);
      return q(`SELECT * FROM outputs ${where(c)} ORDER BY created_at DESC LIMIT ?`).all(...a).map(outputRow);
    },
    addOutput(o) {
      const id = newId("o");
      q(
        `INSERT INTO outputs (id, doc_id, writing_id, version_id, task_id, title, content, agent, model, context_hash, prompt_hash, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, o.docId ?? null, o.writingId ?? null, o.versionId ?? null, o.taskId ?? null, String(o.title), String(o.content),
        String(o.agent || "unknown"), o.model ?? null, o.contextHash ?? null, o.promptHash ?? null, JSON.stringify(o.meta || {}), now(),
      );
      return outputRow(q("SELECT * FROM outputs WHERE id = ?").get(id));
    },
    deleteOutput: (id) => q("DELETE FROM outputs WHERE id = ?").run(id),

    // ---------- 只读 SQL ----------
    readonlyQuery(sql, params = [], maxRows = 500) {
      ro ??= new DatabaseSync(dbPath, { readOnly: true });
      if (!/^\s*(select|with|explain|pragma\s+table_info)\b/i.test(sql)) throw new Error("仅允许 SELECT / WITH 查询");
      const rows = ro.prepare(sql).all(...params);
      return { rows: rows.slice(0, maxRows), truncated: rows.length > maxRows, total: rows.length };
    },
    schema: () =>
      q("SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'chunks_fts%' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => r.sql)
        .join(";\n\n"),
  };

  stores.set(domain, s);
  return s;
}

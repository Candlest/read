// 词典与词表（英语领域）：导入 ECDICT（skywind3000/ECDICT，MIT）为本地 SQLite，提供查词、
// 词形还原（exchange 字段）与词表归属（tag 字段：cet4 / cet6 / ky / toefl / ielts / gre 等）。
// 也可导入自定义词表（每行一个词，行内首个单词有效）。词典库独立于学习数据库：data/english/ecdict.db
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { parse } from "csv-parse";

export const ECDICT_URL = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv";
export const LIST_NAMES = { zk: "中考", gk: "高考", cet4: "四级", cet6: "六级", ky: "考研", toefl: "托福", ielts: "雅思", gre: "GRE" };
const FORM_KEYS = ["p", "d", "i", "3", "s", "r", "t"]; // 过去式、过去分词、现在分词、三单、复数、比较级、最高级

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS entries (
  word TEXT PRIMARY KEY COLLATE NOCASE,
  phonetic TEXT, translation TEXT, definition TEXT, tag TEXT, exchange TEXT
);
CREATE TABLE IF NOT EXISTS forms (form TEXT COLLATE NOCASE, lemma TEXT COLLATE NOCASE, PRIMARY KEY (form, lemma));
CREATE TABLE IF NOT EXISTS lists (name TEXT, word TEXT COLLATE NOCASE, PRIMARY KEY (name, word));
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

const norm = (w) => String(w || "").trim().toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, "").replace(/’/g, "'");

export function openDict(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "ecdict.db");
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  const q = (sql) => db.prepare(sql);
  let importing = null; // { stage, rows, error }

  const meta = (k) => q("SELECT value FROM meta WHERE key = ?").get(k)?.value ?? null;
  const setMeta = (k, v) => q("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, String(v));

  const lemmasOf = (w) => q("SELECT lemma FROM forms WHERE form = ? AND lemma <> form").all(w).map((r) => r.lemma);
  const listsOf = (w) => q("SELECT name FROM lists WHERE word = ?").all(w).map((r) => r.name);
  const entry = (w) => q("SELECT word, phonetic, translation, definition, tag FROM entries WHERE word = ?").get(w);

  const d = {
    dbPath,
    status() {
      return {
        entries: q("SELECT COUNT(*) n FROM entries").get().n,
        importedAt: meta("ecdict_imported_at"),
        source: meta("ecdict_source"),
        importing,
        lists: q("SELECT name, COUNT(*) count FROM lists GROUP BY name ORDER BY name")
          .all()
          .map((r) => ({ ...r, label: LIST_NAMES[r.name] || r.name })),
      };
    },

    /** 查词：原形、词形还原后的原形、所属词表 */
    lookup(raw) {
      const w = norm(raw);
      if (!w) return null;
      const e = entry(w);
      const lemmas = lemmasOf(w);
      const lemmaEntries = lemmas.map(entry).filter(Boolean);
      if (!e && !lemmaEntries.length) return { word: w, found: false };
      const shape = (x) => x && { word: x.word, phonetic: x.phonetic, translation: x.translation?.replace(/\\n/g, "\n"), definition: x.definition?.replace(/\\n/g, "\n").slice(0, 600) };
      const lists = [...new Set([w, ...lemmas].flatMap(listsOf))];
      return { word: w, found: true, entry: shape(e), lemmas: lemmaEntries.map(shape), lists: lists.map((n) => ({ name: n, label: LIST_NAMES[n] || n })) };
    },

    /** 判断一批词是否属于 include 词表且不属于 exclude 词表（按原形或还原后的原形判断） */
    mark(words, { include, exclude } = {}) {
      if (!include) return [];
      const inList = q("SELECT 1 FROM lists WHERE name = ? AND word = ?");
      const hit = (name, keys) => keys.some((k) => inList.get(name, k));
      const out = [];
      for (const raw of new Set(words.map(norm).filter(Boolean))) {
        const keys = [raw, ...lemmasOf(raw)];
        if (hit(include, keys) && !(exclude && hit(exclude, keys))) out.push(raw);
      }
      return out;
    },

    importWordlist(name, text) {
      if (!/^[\w-]{1,40}$/.test(name)) throw new Error("词表名只能包含字母、数字、下划线、连字符");
      const words = [...new Set(text.split(/\r?\n/).map((l) => norm(l.trim().split(/[\s,;\t|]+/)[0])).filter((w) => /^[a-z][a-z'-]*$/.test(w)))];
      db.exec("BEGIN");
      try {
        q("DELETE FROM lists WHERE name = ?").run(name);
        const ins = q("INSERT OR IGNORE INTO lists (name, word) VALUES (?, ?)");
        for (const w of words) ins.run(name, w);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return { name, count: words.length };
    },
    deleteWordlist: (name) => q("DELETE FROM lists WHERE name = ?").run(name),

    /** 导入 ECDICT CSV（本地路径或下载）。流式解析，分批事务写入。 */
    async importEcdict(source = ECDICT_URL) {
      if (importing && !importing.error && importing.stage !== "done") throw new Error("正在导入");
      importing = { stage: "downloading", rows: 0, error: null };
      try {
        let input;
        if (/^https?:/.test(source)) {
          const res = await fetch(source);
          if (!res.ok) throw new Error(`下载失败 ${res.status}`);
          input = Readable.fromWeb(res.body);
        } else input = fs.createReadStream(source);
        importing.stage = "importing";

        db.exec("DELETE FROM entries; DELETE FROM forms;");
        for (const name of Object.keys(LIST_NAMES)) q("DELETE FROM lists WHERE name = ?").run(name);
        const insE = q("INSERT OR REPLACE INTO entries (word, phonetic, translation, definition, tag, exchange) VALUES (?, ?, ?, ?, ?, ?)");
        const insF = q("INSERT OR IGNORE INTO forms (form, lemma) VALUES (?, ?)");
        const insL = q("INSERT OR IGNORE INTO lists (name, word) VALUES (?, ?)");

        const parser = input.pipe(parse({ columns: true, relax_quotes: true, relax_column_count: true, skip_records_with_error: true }));
        db.exec("BEGIN");
        for await (const r of parser) {
          const word = r.word?.trim();
          if (!word) continue;
          insE.run(word, r.phonetic || null, r.translation || null, r.definition || null, r.tag || null, r.exchange || null);
          for (const part of (r.exchange || "").split("/")) {
            const [k, v] = part.split(":");
            if (!v) continue;
            if (k === "0") insF.run(word, v); // 本词的原形
            else if (FORM_KEYS.includes(k)) insF.run(v, word); // 本词的变化形式
          }
          for (const t of (r.tag || "").split(/\s+/)) if (LIST_NAMES[t]) insL.run(t, word);
          if (++importing.rows % 20000 === 0) {
            db.exec("COMMIT");
            db.exec("BEGIN");
          }
        }
        db.exec("COMMIT");
        setMeta("ecdict_imported_at", new Date().toISOString());
        setMeta("ecdict_source", source);
        importing.stage = "done";
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        importing.error = err.message;
        throw err;
      }
      return d.status();
    },
  };
  return d;
}

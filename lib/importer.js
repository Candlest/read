// 导入：arXiv ID / URL、PDF 或网页链接、本地上传（PDF / HTML / TXT / Markdown）。
// 所有来源统一转为 Markdown 主文本：
//   PDF   → 先用 pdf.js 提取文本，同时排队解析器（PaddleOCR 等）生成 Markdown
//   网页  → Readability 抽取正文，turndown 转 Markdown（MathML 保留 LaTeX）；抽取失败时转换整页
//   文本  → 原样作为 Markdown
import * as cheerio from "cheerio";
import path from "node:path";
import fs from "node:fs/promises";
import TurndownService from "turndown";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { newId } from "./store.js";
import { enqueueParse, defaultParser } from "./parsers.js";
import { extractPdfText, sanitizeHtml, htmlTitle } from "./extract.js";

const UA = "Mozilla/5.0 (compatible; read/1.0; personal reading tool)";
// arXiv 访问地址。export.arxiv.org 是 arXiv 官方面向程序访问的域名；国内服务器访问 PDF 较慢，可换成可用的代理地址
const ARXIV_BASE = () => (process.env.ARXIV_BASE || "https://export.arxiv.org").replace(/\/$/, "");
const PDF_TIMEOUT_MS = () => Number(process.env.ARXIV_PDF_TIMEOUT_MS || 30 * 60 * 1000);

// 识别 arXiv 标识：2401.12345、2401.12345v2、hep-th/9901001 及各类 arxiv.org 链接
export function parseArxivId(input) {
  const s = input.trim();
  const m =
    s.match(/arxiv\.org\/(?:abs|pdf|html)\/([\w.\-/]+?)(?:\.pdf)?\/?(?:[?#].*)?$/i) ||
    s.match(/^(?:arxiv:)?(\d{4}\.\d{4,5}(?:v\d+)?)$/i) ||
    s.match(/^(?:arxiv:)?([a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/i);
  return m ? m[1] : null;
}

async function fetchOk(url, accept) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept || "*/*" }, redirect: "follow", signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`请求失败 ${res.status}：${url}`);
  return res;
}

async function arxivMeta(arxivId) {
  const res = await fetchOk(`${ARXIV_BASE()}/api/query?id_list=${encodeURIComponent(arxivId)}`);
  const $ = cheerio.load(await res.text(), { xml: true });
  const entry = $("entry").first();
  if (!entry.length || !entry.find("title").text()) throw new Error(`arXiv 未找到：${arxivId}`);
  const clean = (t) => t.replace(/\s+/g, " ").trim();
  return {
    title: clean(entry.find("title").first().text()),
    authors: entry.find("author > name").map((_, el) => clean($(el).text())).get(),
    abstract: clean(entry.find("summary").text()),
    published: entry.find("published").text(),
    categories: entry.find("category").map((_, el) => $(el).attr("term")).get(),
    versionedId: clean(entry.find("id").text()).replace(/^https?:\/\/arxiv\.org\/abs\//, ""),
  };
}

// 按约 4000 字符、在段落边界切分
function toChunks(md) {
  const chunks = [];
  let cur = "";
  for (const para of md.split(/\n{2,}/)) {
    if (cur && cur.length + para.length > 4000) {
      chunks.push({ page: null, text: cur });
      cur = "";
    }
    cur += (cur ? "\n\n" : "") + para;
  }
  if (cur.trim()) chunks.push({ page: null, text: cur });
  return chunks;
}

function turndown(html) {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  td.addRule("math", {
    filter: "math",
    replacement: (_, node) => {
      const tex = node.getAttribute("alttext");
      if (!tex) return node.textContent;
      return node.getAttribute("display") === "block" ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
    },
  });
  td.remove(["style", "nav", "header", "footer", "script", "noscript"]);
  return td.turndown(html);
}

// 网页 → { title, byline, markdown }；Readability 抽取正文，失败时转换整个 body
function htmlToMarkdown(html, url, { readability = true } = {}) {
  if (readability) try {
    const { document } = parseHTML(html);
    const article = new Readability(document).parse();
    if (article?.content && article.textContent.trim().length > 200) {
      return { title: article.title, byline: article.byline, markdown: turndown(sanitizeHtml(article.content, url)) };
    }
  } catch {
    /* 退回整页转换 */
  }
  return { title: htmlTitle(html), byline: null, markdown: turndown(cheerio.load(sanitizeHtml(html, url))("body").html() || "") };
}

function slug(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "doc"
  );
}

const kindOf = (name) => (/\.pdf$/i.test(name) ? "pdf" : /\.x?html?$/i.test(name) ? "html" : /\.(txt|md|markdown)$/i.test(name) ? "text" : null);

export function createImporter(store) {
  // 导入后自动排队解析为 Markdown（parser="none" 跳过）
  async function afterImport(result, parser = defaultParser()) {
    if (!result.existed && parser && parser !== "none" && result.doc.formats.includes("pdf")) {
      try {
        result.parse = await enqueueParse(store, result.doc.id, parser);
      } catch (err) {
        result.parseError = err.message;
      }
    }
    return result;
  }

  // arXiv：元数据与 HTML 版即时获取（HTML 转 Markdown 后可立即阅读，公式为作者 LaTeX）；
  // PDF 在后台下载（国内服务器较慢），完成后交给解析器生成按页 Markdown。
  async function importArxiv(arxivId, extra, parser) {
    const meta = await arxivMeta(arxivId);
    const id = `arxiv-${meta.versionedId.replace(/\//g, "_")}`;
    const existing = store.getDocument(id);
    if (existing) return { doc: existing, existed: true };

    const formats = [];
    let chunks = [{ page: null, text: `# ${meta.title}\n\n**Abstract.** ${meta.abstract}` }];
    let textSource = "abstract";
    try {
      const res = await fetchOk(`${ARXIV_BASE()}/html/${meta.versionedId}`, "text/html");
      const html = await res.text();
      if (html.includes("ltx_document")) {
        const clean = sanitizeHtml(html, res.url);
        await store.writeFile(id, "source.html", clean);
        formats.push("html");
        const md = toChunks(htmlToMarkdown(clean, res.url, { readability: false }).markdown);
        if (md.length) [chunks, textSource] = [md, "arxiv-html"];
      }
    } catch {
      /* 无 HTML 版本或获取失败：先显示摘要 */
    }
    const doc = store.insertDocument(
      {
        id, source: "arxiv", arxivId: meta.versionedId, url: `https://arxiv.org/abs/${meta.versionedId}`, title: meta.title,
        authors: meta.authors, abstract: meta.abstract, published: meta.published, categories: meta.categories, formats, ...extra,
      },
      chunks,
      textSource,
    );
    const download = downloadArxivPdf(id, meta.versionedId, parser);
    return { doc, existed: false, download };
  }

  // 后台下载 PDF；进度记在 parses 表（parser = "arxiv-pdf"，进度单位 KB）
  function downloadArxivPdf(id, versionedId, parser = defaultParser()) {
    const job = store.addParse(id, "arxiv-pdf");
    (async () => {
      store.updateParse(job.id, { status: "running" });
      try {
        const res = await fetch(`${ARXIV_BASE()}/pdf/${versionedId}`, {
          headers: { "User-Agent": UA, Accept: "application/pdf" },
          redirect: "follow",
          signal: AbortSignal.timeout(PDF_TIMEOUT_MS()),
        });
        if (!res.ok) throw new Error(`PDF 下载失败 ${res.status}`);
        const total = Number(res.headers.get("content-length")) || null;
        const parts = [];
        let got = 0;
        let lastReport = 0;
        for await (const chunk of res.body) {
          parts.push(chunk);
          got += chunk.length;
          if (got - lastReport > 64 * 1024) {
            lastReport = got;
            store.updateParse(job.id, { progressDone: Math.round(got / 1024), progressTotal: total && Math.round(total / 1024) });
          }
        }
        const pdf = Buffer.concat(parts);
        if (pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("下载内容不是 PDF");
        await store.writeFile(id, "source.pdf", pdf);
        const { chunks, numPages } = await extractPdfText(pdf);
        const doc = store.getDocument(id);
        store.updateDocument(id, { formats: ["pdf", ...doc.formats.filter((f) => f !== "pdf")], numPages });
        // 只有摘要时先换成 pdf.js 文本
        if (doc.textSource === "abstract") store.replaceChunks(id, chunks, "pdfjs");
        store.updateParse(job.id, { status: "done", progressDone: Math.round(pdf.length / 1024), progressTotal: Math.round(pdf.length / 1024), finishedAt: new Date().toISOString() });
        if (parser && parser !== "none") await enqueueParse(store, id, parser).catch(() => {});
      } catch (err) {
        store.updateParse(job.id, { status: "failed", error: `PDF 下载失败：${err.message}`, finishedAt: new Date().toISOString() });
      }
    })();
    return job;
  }

  async function importBuffer({ buffer, kind, name, url = "", extra = {} }) {
    const id = `${slug(path.parse(name).name)}-${newId().slice(-6)}`;
    let title = "";
    let authors = [];
    let numPages = null;
    let chunks;
    let textSource;
    if (kind === "pdf") {
      ({ chunks, numPages, title } = await extractPdfText(buffer));
      textSource = "pdfjs";
      await store.writeFile(id, "source.pdf", buffer);
    } else if (kind === "html") {
      const html = buffer.toString("utf8");
      const r = htmlToMarkdown(html, url || undefined);
      chunks = toChunks(r.markdown);
      title = r.title;
      if (r.byline) authors = [r.byline];
      textSource = "html";
      await store.writeFile(id, "source.html", sanitizeHtml(html, url || undefined));
    } else {
      chunks = toChunks(buffer.toString("utf8").replace(/\r\n/g, "\n"));
      textSource = "text";
    }
    if (!chunks.length) throw new Error("未提取到正文");
    const doc = store.insertDocument(
      {
        id, source: url ? "url" : "upload", url, title: title || path.parse(name).name, authors,
        formats: kind === "text" ? [] : [kind], numPages, ...extra,
      },
      chunks,
      textSource,
    );
    return { doc, existed: false };
  }

  async function importUrl(url, extra, parser) {
    const arxivId = parseArxivId(url);
    if (arxivId) return importArxiv(arxivId, extra, parser);
    const res = await fetchOk(url, "application/pdf,text/html;q=0.9,text/plain;q=0.8,*/*;q=0.5");
    const type = res.headers.get("content-type") || "";
    const buffer = Buffer.from(await res.arrayBuffer());
    const kind = type.includes("pdf") || buffer.subarray(0, 5).toString() === "%PDF-" ? "pdf" : type.includes("text/plain") ? "text" : "html";
    const u = new URL(res.url);
    return importBuffer({ buffer, kind, name: u.pathname.split("/").filter(Boolean).pop() || u.hostname, url: res.url, extra });
  }

  return {
    /** arXiv ID / URL / 本地路径（allowLocal 时）。extra 为附加元数据，如 { kind: "news" } */
    async importSource(source, { allowLocal = false, parser, extra = {} } = {}) {
      const s = source.trim();
      const arxivId = parseArxivId(s);
      if (arxivId) return importArxiv(arxivId, extra, parser);
      if (/^https?:\/\//i.test(s)) {
        const r = await importUrl(s, extra, parser);
        return r.download ? r : afterImport(r, parser);
      }
      if (!allowLocal) throw new Error("仅支持 arXiv ID 或 http(s) URL");
      const file = path.resolve(s.replace(/^~(?=\/)/, process.env.HOME || "~"));
      const kind = kindOf(file);
      if (!kind) throw new Error("本地文件仅支持 .pdf / .html / .txt / .md");
      return afterImport(await importBuffer({ buffer: await fs.readFile(file), kind, name: path.basename(file), extra }), parser);
    },
    async importUploaded({ buffer, name, parser, extra = {} }) {
      const kind = kindOf(name);
      if (!kind) throw new Error("仅支持 PDF / HTML / TXT / Markdown 文件");
      return afterImport(await importBuffer({ buffer, kind, name, extra }), parser);
    },
  };
}

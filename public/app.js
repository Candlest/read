// 后端地址：同源部署留空；前后端分离时在 config.js 中设置
const API = (window.READ_CONFIG?.apiBase || "").replace(/\/$/, "");
const V = `${API}/vendor`;

const css = document.createElement("link");
css.rel = "stylesheet";
css.href = `${V}/pdfjs/web/pdf_viewer.css`;
document.head.prepend(css);

const pdfjsLib = await import(`${V}/pdfjs/build/pdf.mjs`);
const { marked } = await import(`${V}/marked/marked.esm.js`);
const { default: DOMPurify } = await import(`${V}/dompurify/purify.es.mjs`);
const { default: katex } = await import(`${V}/katex/katex.mjs`);
const { default: markedKatex } = await import(`${V}/marked-katex/index.esm.js`);

const katexCss = document.createElement("link");
katexCss.rel = "stylesheet";
katexCss.href = `${V}/katex/katex.min.css`;
document.head.prepend(katexCss);

// 公式：marked-katex-extension 负责识别 $...$ / $$...$$；渲染时外包一层 .math-src 保存 LaTeX 源，
// 供批注定位与摘录（摘录中公式以 $LaTeX$ 形式保存，便于 agent 阅读）
marked.use(markedKatex({ throwOnError: false, nonStandard: true }));
const texAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const mathRenderer = (token) =>
  `<span class="math-src" data-display="${token.displayMode ? 1 : 0}" data-tex="${texAttr(token.text)}">` +
  katex.renderToString(token.text, { displayMode: token.displayMode, throwOnError: false }) +
  `</span>`;
marked.use({ extensions: [{ name: "inlineKatex", renderer: mathRenderer }, { name: "blockKatex", renderer: (t) => mathRenderer(t) + "\n" }] });
globalThis.pdfjsLib = pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = `${V}/pdfjs/build/pdf.worker.mjs`;
const { PDFViewer, EventBus, PDFLinkService } = await import(`${V}/pdfjs/web/pdf_viewer.mjs`);

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const md = (text) => DOMPurify.sanitize(marked.parse(text || ""));

const state = {
  domain: null, // "academic" | "english"
  info: null, // 当前领域的 /info
  globalInfo: null,
  mode: null, // "doc" | "writing"
  writing: null,
  writings: [],
  papers: [],
  tags: [],
  paper: null,
  doc: null, // { textSource, assetsBase, pages }
  ref: null, // 对照面板："pdf" | "html" | null
  unanchored: new Set(),
  parsers: [],
  annotations: [],
  annFilter: null,
  outputs: [],
  currentRun: null,
  compareIds: new Set(),
  tasks: [],
};

function getToken() {
  try { return localStorage.getItem("readToken") || ""; } catch { return ""; }
}
const authHeaders = () => (getToken() ? { Authorization: `Bearer ${getToken()}` } : {});
// 无法附加请求头的场景（iframe）使用查询参数
const withToken = (url) => (getToken() ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(getToken())}` : url);

async function api(url, opts = {}) {
  const init = { ...opts, headers: { ...authHeaders() } };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    init.headers["Content-Type"] = "application/json";
  }
  const res = await fetch(API + url, init);
  if (res.status === 401) {
    const t = prompt("服务端需要访问令牌（READ_TOKEN）：");
    if (t) {
      try { localStorage.setItem("readToken", t.trim()); } catch {}
      return api(url, opts);
    }
  }
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || data || res.statusText);
  return data;
}

// 当前领域的接口：/api/academic/… 或 /api/english/…
const dapi = (url, opts) => api(`/api/${state.domain}${url}`, opts);

async function copyText(text, btn) {
  await navigator.clipboard.writeText(text);
  if (btn) {
    const old = btn.textContent;
    btn.textContent = "已复制";
    setTimeout(() => (btn.textContent = old), 1200);
  }
}

const tagById = (id) => state.tags.find((t) => t.id === id);
const tagColor = (ann) => tagById(ann.tags[0])?.color || "#f5d90a";

// ======================= 文库 =======================

async function loadLibrary() {
  state.papers = await dapi("/documents");
  renderLibrary();
}

function renderLibrary() {
  const q = $("#lib-search").value.trim().toLowerCase();
  const st = $("#lib-status").value;
  const kind = $("#lib-kind").value;
  const kindName = (k) => state.info.kinds.find((x) => x.id === k)?.name;
  const list = state.papers.filter((p) => (!q || p.title.toLowerCase().includes(q)) && (!st || p.status === st) && (!kind || p.kind === kind));
  $("#paper-list").innerHTML = list
    .map(
      (p) => `<li data-id="${esc(p.id)}" class="${state.paper?.id === p.id ? "active" : ""}">
        <div class="p-title">${esc(p.title)}</div>
        <div class="muted small">${esc((p.authors || []).slice(0, 3).join(", "))}${(p.authors || []).length > 3 ? " 等" : ""}</div>
        <div class="row small"><span class="status s-${esc(p.status)}">${esc(p.status)}</span>
        ${kindName(p.kind) ? `<span class="status">${esc(kindName(p.kind))}</span>` : ""}
        <span class="muted">${p.annotationCount} 条批注</span><span class="muted">${p.formats.join(" / ").toUpperCase() || "TEXT"}</span></div>
      </li>`,
    )
    .join("") || `<li class="muted small empty-li">暂无${state.info.terms.doc}</li>`;
}

$("#paper-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if (li) openPaper(li.dataset.id);
});
$("#lib-search").addEventListener("input", renderLibrary);
$("#lib-status").addEventListener("change", renderLibrary);
$("#lib-kind").addEventListener("change", renderLibrary);
const importKind = () => (state.info.kinds.length ? $("#import-kind").value : undefined);

$("#import-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#import-input").value.trim();
  if (!input) return;
  await doImport(() => dapi("/documents/import", { method: "POST", json: { input, kind: importKind() } }));
  $("#import-input").value = "";
});

$("#upload-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  if (importKind()) fd.append("kind", importKind());
  await doImport(() => dapi("/documents/upload", { method: "POST", body: fd }));
  e.target.value = "";
});

async function doImport(fn) {
  const status = $("#import-status");
  status.textContent = "导入中……";
  try {
    const { doc, existed } = await fn();
    status.textContent = existed ? `库中已存在该${state.info.terms.doc}` : "已完成导入";
    await loadLibrary();
    openPaper(doc.id);
  } catch (err) {
    status.textContent = `导入失败：${err.message}`;
  }
}

// ======================= 打开论文 =======================

async function openPaper(id) {
  closeSelPop();
  if (state.mode === "writing") await autoSaveWriting().catch(() => {});
  const [paper, annotations, notes, outputs] = await Promise.all([
    dapi(`/documents/${id}`),
    dapi(`/documents/${id}/annotations`),
    dapi(`/documents/${id}/notes`),
    dapi(`/outputs?doc_id=${id}`),
  ]);
  Object.assign(state, { mode: "doc", writing: null, paper, annotations, outputs, currentRun: null, annFilter: null, doc: null });
  state.compareIds.clear();
  try { localStorage.setItem(`last-${state.domain}`, id); } catch {}

  $("#empty").hidden = true;
  $("#writing-view").hidden = true;
  setPanelMode("doc");
  $("#reader-toolbar").hidden = false;
  $("#panel").hidden = false;
  $("#md-view").hidden = false;
  $("#paper-title").textContent = paper.title;
  $("#paper-sub").textContent = [paper.authors?.slice(0, 4).join(", "), paper.arxivId && `arXiv:${paper.arxivId}`, `ID: ${paper.id}`]
    .filter(Boolean)
    .join(" · ");
  $("#paper-status").value = paper.status;
  $("#notes").value = notes.text;
  $("#notes-status").textContent = "";
  state.jobSig = undefined;
  renderRefSwitch();

  renderLibrary();
  if (state.info.hasWritings) loadWritings();
  renderTasks();
  renderRuns();
  showRun(null);
  setRef(null);
  await loadDocument();
  refreshParseStatus();
}

$("#paper-status").addEventListener("change", async (e) => {
  state.paper = await dapi(`/documents/${state.paper.id}`, { method: "PATCH", json: { status: e.target.value } });
  loadLibrary();
});

$("#delete-paper").addEventListener("click", async () => {
  if (!confirm(`删除《${state.paper.title}》及其全部批注、笔记与 agent 输出？`)) return;
  await dapi(`/documents/${state.paper.id}`, { method: "DELETE" });
  closeDocView();
  state.mode = null;
  $("#panel").hidden = true;
  $("#empty").hidden = false;
  loadLibrary();
});

// ======================= 解析状态 =======================

const PARSE_LABEL = { queued: "排队中", running: "解析中", done: "已完成", failed: "失败" };
const SOURCE_LABEL = {
  pdfjs: "pdf.js 提取文本", html: "网页转换", text: "纯文本", "arxiv-html": "arXiv HTML", abstract: "摘要",
  "paddleocr-cloud": "PaddleOCR-VL", "paddleocr-api": "PaddleOCR-VL", "mineru-api": "MinerU", "arxiv-pdf": "PDF 下载",
};

function renderRefSwitch() {
  $("#ref-switch").innerHTML =
    `<span class="muted small">对照</span>` + state.paper.formats.map((f) => `<button data-ref="${f}">${f.toUpperCase()}</button>`).join("");
  $$("#ref-switch button").forEach((b) => b.classList.toggle("active", b.dataset.ref === state.ref));
}
let parseTimer = null;

async function loadParsers() {
  const list = (await dapi("/parsers")).filter((p) => p.available);
  state.parsers = list;
  $("#parser-select").innerHTML = list.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  $("#parse-ctl").hidden = !list.length;
}

async function refreshParseStatus() {
  clearTimeout(parseTimer);
  if (!state.paper) return;
  const id = state.paper.id;
  const jobs = await dapi(`/documents/${id}/parses`);
  if (state.paper?.id !== id) return;
  const latest = jobs[0];
  const busy = jobs.some((j) => j.status === "queued" || j.status === "running");

  // 后台任务（PDF 下载、解析）状态变化后，重新读取文档；正文来源变化时重新渲染
  const sig = jobs.map((j) => j.id + j.status).join();
  const changed = state.jobSig !== undefined && sig !== state.jobSig;
  state.jobSig = sig;
  if (changed) {
    state.paper = await dapi(`/documents/${id}`);
    renderRefSwitch();
    if (state.paper.textSource !== state.doc?.textSource) await loadDocument();
  }

  $("#parse-btn").disabled = busy;
  $("#parse-ctl").hidden = !state.parsers?.length || !state.paper.formats.includes("pdf");
  $("#parse-btn").textContent = ["pdfjs", "abstract"].includes(state.paper.textSource) ? "解析" : "重新解析";

  const banner = $("#doc-banner");
  let msg = "";
  const running = jobs.find((j) => j.status === "queued" || j.status === "running");
  if (running?.parser === "arxiv-pdf") {
    const p = running.progressDone ? `，已下载 ${running.progressDone}${running.progressTotal ? ` / ${running.progressTotal}` : ""} KB` : "";
    msg = `正在从 arXiv 下载 PDF${p}。下载完成后自动解析为 Markdown；当前正文为${SOURCE_LABEL[state.paper.textSource] || state.paper.textSource}。`;
  } else if (running) {
    const p = running.progressTotal ? ` ${running.progressDone ?? 0}/${running.progressTotal} 页` : "";
    msg = `${SOURCE_LABEL[running.parser] || running.parser} ${PARSE_LABEL[running.status]}${p}。完成后正文自动替换为解析结果。`;
  } else if (latest?.status === "failed") {
    msg = latest.parser === "arxiv-pdf" ? `${latest.error}` : `解析失败：${latest.error || "原因未返回"}`;
  } else if (state.paper.textSource === "pdfjs") {
    msg = state.parsers?.length ? "当前正文为 pdf.js 提取文本，公式与表格结构不完整。可点击“解析”生成 Markdown。" : "当前正文为 pdf.js 提取文本。配置 PADDLEOCR_TOKEN 后可解析为 Markdown。";
  } else if (state.paper.textSource === "abstract") {
    msg = "当前只有摘要：该论文没有 arXiv HTML 版本，PDF 尚未获取。";
  }
  banner.textContent = msg;
  banner.hidden = !msg;
  banner.classList.toggle("error", latest?.status === "failed" && !busy);
  if (busy) parseTimer = setTimeout(refreshParseStatus, 3000);
}

$("#parse-btn").addEventListener("click", async () => {
  try {
    await dapi(`/documents/${state.paper.id}/parse`, { method: "POST", json: { parser: $("#parser-select").value } });
  } catch (err) {
    alert(err.message);
  }
  refreshParseStatus();
});

// ======================= Markdown 正文 =======================

const view = $("#md-view");

async function loadDocument() {
  const id = state.paper.id;
  const doc = await dapi(`/documents/${id}/markdown`);
  if (state.paper?.id !== id) return;
  state.doc = doc;
  view.innerHTML =
    doc.pages
      .map(
        (p) => `<section class="md-page" data-page="${p.page ?? ""}">
        ${p.page ? `<div class="page-head"><span>第 ${p.page} 页</span>${state.paper.formats.includes("pdf") ? `<button class="ghost tiny" data-goto-page="${p.page}">对照 PDF</button>` : ""}</div>` : ""}
        <div class="md-body">${md(p.text)}</div></section>`,
      )
      .join("") || `<p class="muted">没有正文。</p>`;
  for (const img of view.querySelectorAll("img")) {
    const src = img.getAttribute("src") || "";
    if (doc.assetsBase && src && !/^(https?:|data:|\/)/.test(src)) img.src = withToken(API + doc.assetsBase + src);
  }
  for (const a of view.querySelectorAll("a[href]")) Object.assign(a, { target: "_blank", rel: "noopener noreferrer" });
  $("#doc-source").textContent = `正文：${SOURCE_LABEL[doc.textSource] || doc.textSource}`;
  view.scrollTop = 0;
  await markVocab();
  applyHighlights();
  renderAnnotations();
}

// ======================= 词表标注与查词（英语） =======================

const WORD_RE = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
const vocabModeKey = () => `vocab-mode-${state.domain}`;

function vocabSpec() {
  let v = "";
  try { v = localStorage.getItem(vocabModeKey()) ?? "cet6-new"; } catch {}
  if (!v || !state.dictStatus?.entries) return null;
  if (v === "cet6-new") return { include: "cet6", exclude: "cet4" };
  return { include: v };
}

// 在正文文本节点中把属于词表的单词包进 .vocab（不改变文本内容，批注定位不受影响）
async function markVocab() {
  const spec = state.info?.hasDictionary ? vocabSpec() : null;
  if (!spec) return;
  const nodes = [];
  const walk = (n) => {
    if (n.nodeType === 3) return nodes.push(n);
    if (n.nodeType !== 1 || n.matches(".math-src, .page-head, code, pre, .katex")) return;
    for (const c of n.childNodes) walk(c);
  };
  walk(view);
  const words = new Set();
  for (const n of nodes) for (const m of n.nodeValue.matchAll(WORD_RE)) words.add(m[0].toLowerCase());
  if (!words.size) return;
  const { words: hits } = await dapi("/dict/mark", { method: "POST", json: { words: [...words], ...spec } });
  const set = new Set(hits);
  for (const n of nodes) {
    const text = n.nodeValue;
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(WORD_RE)) {
      if (!set.has(m[0].toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, ""))) continue;
      parts.push(text.slice(last, m.index), m[0]);
      last = m.index + m[0].length;
    }
    if (!parts.length) continue;
    parts.push(text.slice(last));
    const frag = document.createDocumentFragment();
    parts.forEach((p, i) => {
      if (i % 2) {
        const span = document.createElement("span");
        span.className = "vocab";
        span.textContent = p;
        frag.append(span);
      } else if (p) frag.append(p);
    });
    n.replaceWith(frag);
  }
  view.normalize();
}

async function loadDictStatus() {
  state.dictStatus = state.info?.hasDictionary ? await dapi("/dict/status") : null;
  const sel = $("#vocab-mode");
  if (!state.dictStatus) return;
  const lists = state.dictStatus.lists;
  const has = (n) => lists.some((l) => l.name === n);
  const opts = [["", "不标注词表"]];
  if (has("cet6")) opts.push(["cet6-new", "标注六级新增词（不含四级）"], ["cet6", "标注六级词（含四级）"]);
  for (const l of lists) if (!["cet6"].includes(l.name)) opts.push([l.name, `标注${l.label}（${l.count}）`]);
  sel.innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("");
  let cur = "cet6-new";
  try { cur = localStorage.getItem(vocabModeKey()) ?? "cet6-new"; } catch {}
  sel.value = opts.some(([v]) => v === cur) ? cur : "";
}

$("#vocab-mode").addEventListener("change", async (e) => {
  try { localStorage.setItem(vocabModeKey(), e.target.value); } catch {}
  if (state.mode === "doc") await loadDocument();
});

// 选区为 1–4 个词时查词典；任意选区提供 DeepL / Google 翻译链接
async function fillDict(quote) {
  const box = $("#sel-dict");
  const links = $("#sel-links");
  box.hidden = true;
  links.hidden = state.domain !== "english";
  if (state.domain !== "english") return;
  const text = quote.replace(/\$[^$]*\$/g, "").trim();
  links.innerHTML =
    `<a target="_blank" rel="noopener" href="https://www.deepl.com/translator#en/zh/${encodeURIComponent(text)}">DeepL</a>` +
    `<a target="_blank" rel="noopener" href="https://translate.google.com/?sl=en&tl=zh-CN&op=translate&text=${encodeURIComponent(text)}">Google</a>`;
  const words = text.split(/\s+/).filter(Boolean);
  if (!state.dictStatus?.entries || words.length > 4) return;
  const r = await dapi(`/dict/lookup?w=${encodeURIComponent(text)}`).catch(() => null);
  if (pending?.quote !== quote) return;
  if (!r?.found) {
    box.innerHTML = `<div class="muted small">词典中未收录「${esc(text)}」</div>`;
    box.hidden = false;
    return;
  }
  const show = (e, extra = "") =>
    `<div class="dict-head"><strong>${esc(e.word)}</strong>${e.phonetic ? ` <span class="muted">/${esc(e.phonetic)}/</span>` : ""}${extra}</div>` +
    (e.translation ? `<div class="dict-tr">${esc(e.translation).split("\n").slice(0, 5).join("<br>")}</div>` : "");
  const badges = r.lists.map((l) => `<span class="badge b-${esc(l.name)}">${esc(l.label)}</span>`).join("");
  let html = "";
  if (r.entry) html += show(r.entry, badges);
  for (const l of r.lemmas) html += `<div class="muted small">原形</div>` + show(l, r.entry ? "" : badges);
  box.innerHTML = html;
  box.hidden = false;
  positionSelPop();
}

// 文本索引：遍历正文文本节点，公式（.math-src）作为整体以 $LaTeX$ 计入；块元素之间插入换行
const BLOCK = /^(P|LI|H[1-6]|DIV|TR|TD|TH|BLOCKQUOTE|PRE|SECTION|FIGCAPTION|TABLE|UL|OL)$/;

function textIndex() {
  const nodes = [];
  let text = "";
  const walk = (n) => {
    if (n.nodeType === 3) {
      nodes.push({ node: n, start: text.length, end: text.length + n.nodeValue.length });
      text += n.nodeValue;
      return;
    }
    if (n.nodeType !== 1 || n.classList.contains("page-head")) return;
    if (n.classList.contains("math-src")) {
      const tex = n.dataset.display === "1" ? `$$${n.dataset.tex}$$` : `$${n.dataset.tex}$`;
      nodes.push({ node: n, start: text.length, end: text.length + tex.length, atomic: true });
      text += tex;
      return;
    }
    const block = BLOCK.test(n.tagName);
    if (block && text && !text.endsWith("\n")) text += "\n";
    for (const c of n.childNodes) walk(c);
    if (block && text && !text.endsWith("\n")) text += "\n";
  };
  walk(view);
  return { nodes, text };
}

// 空白折叠后的文本及其到原始偏移的映射，用于抗格式差异的定位
function normalize(s) {
  let out = "";
  const map = [];
  let ws = false;
  for (let i = 0; i < s.length; i++) {
    if (/\s/.test(s[i])) {
      if (!ws && out.length) {
        out += " ";
        map.push(i);
      }
      ws = true;
    } else {
      out += s[i];
      map.push(i);
      ws = false;
    }
  }
  return { out, map };
}
const squash = (s) => s.replace(/\s+/g, " ").trim();

function offsetOf(index, container, offset, isEnd) {
  const el = container.nodeType === 1 ? container : container.parentElement;
  const math = el?.closest(".math-src");
  if (math) {
    const e = index.nodes.find((n) => n.node === math);
    return e ? (isEnd ? e.end : e.start) : 0;
  }
  if (container.nodeType === 3) {
    const e = index.nodes.find((n) => n.node === container);
    return e ? e.start + offset : 0;
  }
  const child = container.childNodes[offset];
  if (child) {
    const e = index.nodes.find((n) => child === n.node || child.contains(n.node));
    if (e) return e.start;
  }
  const before = index.nodes.filter((n) => container.contains(n.node)).at(-1);
  return before ? before.end : 0;
}

function locate(norm, a) {
  if (!a.quote) return -1;
  let best = -1;
  let bestScore = -1;
  for (let i = norm.indexOf(a.quote); i !== -1; i = norm.indexOf(a.quote, i + 1)) {
    let score = 0;
    const pre = norm.slice(Math.max(0, i - a.prefix.length), i);
    const suf = norm.slice(i + a.quote.length, i + a.quote.length + a.suffix.length);
    for (let k = 1; k <= Math.min(pre.length, a.prefix.length) && pre.at(-k) === a.prefix.at(-k); k++) score++;
    for (let k = 0; k < Math.min(suf.length, a.suffix.length) && suf[k] === a.suffix[k]; k++) score++;
    score -= Math.abs(i - (a.start ?? i)) / 1e6; // 同分时取接近原位置者
    if (score > bestScore) [best, bestScore] = [i, score];
  }
  return best;
}

function clearHighlights() {
  for (const m of view.querySelectorAll("mark.pr-hl")) m.replaceWith(...m.childNodes);
  for (const m of view.querySelectorAll(".math-src.pr-hl-math")) {
    m.classList.remove("pr-hl-math", "focus");
    m.style.background = "";
    delete m.dataset.ann;
  }
  view.normalize();
}

function applyHighlights() {
  clearHighlights();
  state.unanchored = new Set();
  for (const a of state.annotations) {
    const index = textIndex();
    const { out, map } = normalize(index.text);
    const ns = locate(out, a);
    if (ns < 0) {
      state.unanchored.add(a.id);
      continue;
    }
    const s = map[ns];
    const e = map[ns + a.quote.length - 1] + 1;
    const color = tagColor(a);
    for (const { node, start, end, atomic } of index.nodes) {
      if (end <= s || start >= e) continue;
      if (atomic) {
        node.classList.add("pr-hl-math");
        node.classList.toggle("focus", a.id === state.focusAnn);
        node.dataset.ann = a.id;
        node.style.background = color + "55";
        continue;
      }
      let target = node;
      const from = Math.max(s, start) - start;
      const to = Math.min(e, end) - start;
      if (to < target.nodeValue.length) target.splitText(to);
      if (from > 0) target = target.splitText(from);
      if (!target.nodeValue.trim()) continue;
      const mark = document.createElement("mark");
      mark.className = "pr-hl" + (a.id === state.focusAnn ? " focus" : "");
      mark.dataset.ann = a.id;
      mark.style.background = color + "55";
      target.replaceWith(mark);
      mark.appendChild(target);
    }
  }
}

view.addEventListener("mouseup", (e) => {
  if (e.target.closest("button")) return;
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) {
      const hit = e.target.closest("[data-ann]");
      if (hit) return focusAnnotation(hit.dataset.ann, { scrollList: true });
      // 点击标注的词表单词：选中该词，按选区流程弹出查词与批注
      const vocab = e.target.closest(".vocab");
      if (!vocab) return;
      const r = document.createRange();
      r.selectNodeContents(vocab);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    const range = sel.getRangeAt(0);
    if (!view.contains(range.commonAncestorContainer)) return;
    const index = textIndex();
    const rs = offsetOf(index, range.startContainer, range.startOffset, false);
    const re = offsetOf(index, range.endContainer, range.endOffset, true);
    if (re <= rs) return;
    const { out, map } = normalize(index.text);
    // 原始偏移 → 折叠后偏移
    let ns = map.findIndex((m) => m >= rs);
    let ne = map.findIndex((m) => m >= re);
    if (ns < 0) return;
    if (ne < 0) ne = out.length;
    while (out[ns] === " ") ns++;
    while (ne > ns && out[ne - 1] === " ") ne--;
    const quote = out.slice(ns, ne);
    if (!quote) return;
    const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const page = Number(startEl.closest(".md-page")?.dataset.page) || null;
    openSelPop(range.getBoundingClientRect(), {
      quote,
      prefix: out.slice(Math.max(0, ns - 48), ns),
      suffix: out.slice(ne, ne + 48),
      start: ns,
      page,
    });
  }, 0);
});

view.addEventListener("click", (e) => {
  const b = e.target.closest("[data-goto-page]");
  if (b) openRefPage(Number(b.dataset.gotoPage));
});

// ======================= 对照原文（PDF / HTML，仅查看） =======================

const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus });
const pdfViewer = new PDFViewer({ container: $("#pdf-container"), viewer: $("#pdf-viewer"), eventBus, linkService, textLayerMode: 1 });
linkService.setViewer(pdfViewer);
let pdfDoc = null;
let pdfLoadedFor = null;
let pendingPage = null;
eventBus.on("pagesinit", () => {
  pdfViewer.currentScaleValue = "page-width";
  if (pendingPage) pdfViewer.scrollPageIntoView({ pageNumber: pendingPage });
  pendingPage = null;
});

async function loadPdf() {
  if (pdfLoadedFor === state.paper.id) return;
  if (pdfDoc) await pdfDoc.destroy();
  pdfLoadedFor = state.paper.id;
  pdfDoc = await pdfjsLib.getDocument({ url: `${API}/api/${state.domain}/documents/${state.paper.id}/source.pdf`, httpHeaders: authHeaders() }).promise;
  pdfViewer.setDocument(pdfDoc);
  linkService.setDocument(pdfDoc);
}

const frame = $("#html-frame");
let htmlLoadedFor = null;

async function setRef(kind) {
  state.ref = kind;
  $("#viewer-host").classList.toggle("split", !!kind);
  $("#ref-pane").hidden = !kind;
  $("#pdf-container").hidden = kind !== "pdf";
  frame.hidden = kind !== "html";
  $("#zoom-ctl").hidden = kind !== "pdf";
  $$("#ref-switch button").forEach((b) => b.classList.toggle("active", b.dataset.ref === kind));
  if (kind === "pdf") await loadPdf();
  if (kind === "html" && htmlLoadedFor !== state.paper.id) {
    htmlLoadedFor = state.paper.id;
    frame.src = withToken(`${API}/api/${state.domain}/documents/${state.paper.id}/source.html`);
  }
}

$("#ref-switch").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-ref]");
  if (b) setRef(state.ref === b.dataset.ref ? null : b.dataset.ref);
});

async function openRefPage(page) {
  if (state.ref !== "pdf") {
    pendingPage = page;
    await setRef("pdf");
  }
  if (pdfViewer.pagesCount) pdfViewer.scrollPageIntoView({ pageNumber: page });
}

$("#zoom-ctl").addEventListener("click", (e) => {
  const z = e.target.closest("button")?.dataset.zoom;
  if (!z) return;
  if (z === "fit") pdfViewer.currentScaleValue = "page-width";
  else pdfViewer.currentScale = Math.min(4, Math.max(0.3, pdfViewer.currentScale * (z === "+" ? 1.15 : 1 / 1.15)));
});

// ======================= 选区弹窗 =======================

let pending = null;
let pendingTags = new Set();

function openSelPop(rect, data) {
  pending = data;
  pendingTags = new Set();
  const pop = $("#sel-pop");
  $("#sel-comment").value = "";
  $("#sel-quote").textContent = `「${data.quote.slice(0, 40)}${data.quote.length > 40 ? "…" : ""}」`;
  renderSelTags();
  pop.hidden = false;
  selRect = rect;
  fillDict(data.quote);
  positionSelPop();
}

let selRect = null;
function positionSelPop() {
  const pop = $("#sel-pop");
  if (pop.hidden || !selRect) return;
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let top = selRect.bottom + 8;
  if (top + h > innerHeight - 8) top = Math.max(8, selRect.top - h - 8);
  pop.style.top = `${top}px`;
  pop.style.left = `${Math.min(Math.max(8, selRect.left), innerWidth - w - 8)}px`;
}

function renderSelTags() {
  $("#sel-tags").innerHTML = state.tags
    .map(
      (t, i) => `<button class="chip ${pendingTags.has(t.id) ? "on" : ""}" data-tag="${esc(t.id)}" style="--c:${esc(t.color)}" title="${esc(t.description)}">
        ${i < 9 ? `<kbd>${i + 1}</kbd>` : ""}${esc(t.name)}</button>`,
    )
    .join("");
}

function closeSelPop() {
  $("#sel-pop").hidden = true;
  pending = null;
}

$("#sel-tags").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tag]");
  if (!b) return;
  pendingTags.has(b.dataset.tag) ? pendingTags.delete(b.dataset.tag) : pendingTags.add(b.dataset.tag);
  renderSelTags();
});

document.addEventListener("keydown", (e) => {
  if ($("#sel-pop").hidden) return;
  if (e.key === "Escape") return closeSelPop();
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") return saveSelection();
  if (document.activeElement !== $("#sel-comment") && /^[1-9]$/.test(e.key)) {
    const t = state.tags[Number(e.key) - 1];
    if (t) {
      pendingTags.has(t.id) ? pendingTags.delete(t.id) : pendingTags.add(t.id);
      renderSelTags();
    }
  }
  if (document.activeElement !== $("#sel-comment") && e.key === "Enter") saveSelection();
});

$("#sel-cancel").addEventListener("click", closeSelPop);
$("#sel-save").addEventListener("click", saveSelection);

async function saveSelection() {
  if (!pending) return;
  const ann = await dapi(`/documents/${state.paper.id}/annotations`, {
    method: "POST",
    json: { ...pending, tags: [...pendingTags], comment: $("#sel-comment").value },
  });
  closeSelPop();
  window.getSelection().removeAllRanges();
  state.annotations.push(ann);
  state.focusAnn = ann.id;
  applyHighlights();
  renderAnnotations();
  bumpPaperCount();
}

function bumpPaperCount() {
  const p = state.papers.find((p) => p.id === state.paper.id);
  if (p) p.annotationCount = state.annotations.length;
  renderLibrary();
}

// ======================= 批注列表 =======================

function renderAnnotations() {
  $("#ann-count").textContent = state.annotations.length || "";
  const counts = new Map();
  for (const a of state.annotations) for (const t of a.tags) counts.set(t, (counts.get(t) || 0) + 1);
  $("#ann-filter").innerHTML =
    `<button class="chip ${!state.annFilter ? "on" : ""}" data-filter="" style="--c:#888">全部</button>` +
    state.tags
      .filter((t) => counts.has(t.id))
      .map((t) => `<button class="chip ${state.annFilter === t.id ? "on" : ""}" data-filter="${esc(t.id)}" style="--c:${esc(t.color)}">${esc(t.name)} ${counts.get(t.id)}</button>`)
      .join("");

  const list = state.annotations
    .filter((a) => !state.annFilter || a.tags.includes(state.annFilter))
    .sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || (a.start ?? 0) - (b.start ?? 0) || a.createdAt.localeCompare(b.createdAt));
  $("#ann-list").innerHTML =
    list
      .map((a) => {
        const lost = state.unanchored?.has(a.id);
        return `<li data-ann="${a.id}" class="${a.id === state.focusAnn ? "focus" : ""} ${lost ? "lost" : ""}" style="--c:${esc(tagColor(a))}">
        <div class="row between small muted"><span>${a.page ? `第 ${a.page} 页` : "正文"}${lost ? ` · <span class="warn" title="正文已更新（${esc(a.textSource || "")} → ${esc(state.doc?.textSource || "")}），未找到原摘录">未定位</span>` : ""}</span>
          <button class="ghost tiny danger" data-del="${a.id}">删除</button></div>
        <blockquote>${esc(a.quote)}</blockquote>
        <div class="chips">${state.tags
          .map((t) => `<button class="chip tiny ${a.tags.includes(t.id) ? "on" : ""}" data-toggle="${esc(t.id)}" style="--c:${esc(t.color)}">${esc(t.name)}</button>`)
          .join("")}</div>
        <textarea class="ann-comment" rows="2" placeholder="评论">${esc(a.comment)}</textarea>
      </li>`;
      })
      .join("") || `<li class="muted small empty-li">在正文中选中文字以添加批注。</li>`;
}

$("#ann-filter").addEventListener("click", (e) => {
  const b = e.target.closest("[data-filter]");
  if (!b) return;
  state.annFilter = b.dataset.filter || null;
  renderAnnotations();
});

$("#ann-list").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-ann]");
  if (!li) return;
  const id = li.dataset.ann;
  const ann = state.annotations.find((a) => a.id === id);
  if (e.target.dataset.del) {
    if (!confirm("删除这条批注？")) return;
    await dapi(`/documents/${state.paper.id}/annotations/${id}`, { method: "DELETE" });
    state.annotations = state.annotations.filter((a) => a.id !== id);
    applyHighlights();
    renderAnnotations();
    bumpPaperCount();
    return;
  }
  if (e.target.dataset.toggle) {
    const t = e.target.dataset.toggle;
    const tags = ann.tags.includes(t) ? ann.tags.filter((x) => x !== t) : [...ann.tags, t];
    Object.assign(ann, await dapi(`/documents/${state.paper.id}/annotations/${id}`, { method: "PATCH", json: { tags } }));
    applyHighlights();
    renderAnnotations();
    return;
  }
  if (e.target.tagName === "TEXTAREA") return;
  focusAnnotation(id, { scrollDoc: true });
});

$("#ann-list").addEventListener(
  "blur",
  async (e) => {
    if (!e.target.classList.contains("ann-comment")) return;
    const id = e.target.closest("li").dataset.ann;
    const ann = state.annotations.find((a) => a.id === id);
    if (ann.comment === e.target.value) return;
    Object.assign(ann, await dapi(`/documents/${state.paper.id}/annotations/${id}`, { method: "PATCH", json: { comment: e.target.value } }));
  },
  true,
);

function focusAnnotation(id, { scrollDoc = false, scrollList = false } = {}) {
  state.focusAnn = id;
  $$("#ann-list li").forEach((li) => li.classList.toggle("focus", li.dataset.ann === id));
  $$("#md-view [data-ann]").forEach((el) => el.classList.toggle("focus", el.dataset.ann === id));
  switchTab("annotations");
  if (scrollList) $(`#ann-list li[data-ann="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  if (scrollDoc) {
    const el = view.querySelector(`[data-ann="${id}"]`);
    const ann = state.annotations.find((a) => a.id === id);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    else if (ann?.page) view.querySelector(`.md-page[data-page="${ann.page}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }
}

// ======================= 笔记 =======================

let notesTimer = null;
$("#notes").addEventListener("input", () => {
  $("#notes-status").textContent = "编辑中";
  clearTimeout(notesTimer);
  notesTimer = setTimeout(saveNotes, 800);
});

async function saveNotes() {
  clearTimeout(notesTimer);
  if (!state.paper) return;
  await dapi(`/documents/${state.paper.id}/notes`, { method: "PUT", json: { text: $("#notes").value } });
  $("#notes-status").textContent = `已保存 ${new Date().toLocaleTimeString()}`;
}

const NOTES_TEMPLATE = `## 一句话总结

## 研究问题

## 方法要点

## 实验与结果

## 我的看法

## 与我的研究的联系

## 待解决的问题
`;
$("#notes-template").addEventListener("click", () => {
  const ta = $("#notes");
  ta.value = ta.value ? `${ta.value.trimEnd()}\n\n${NOTES_TEMPLATE}` : NOTES_TEMPLATE;
  ta.dispatchEvent(new Event("input"));
});

// ======================= 标签页 =======================

function switchTab(name) {
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((s) => (s.hidden = s.id !== `tab-${name}`));
}
$(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (b) switchTab(b.dataset.tab);
});

// ======================= Agent =======================

async function loadTasks() {
  state.tasks = await dapi("/tasks");
}

// 当前视图可用的任务：打开文档时为 document 与 none，打开写作时为 writing 与 none
function visibleTasks() {
  const target = state.mode === "writing" ? "writing" : "document";
  return state.tasks.filter((t) => t.target === target || t.target === "none");
}

function renderTasks() {
  const list = visibleTasks();
  $("#paste-form [name=taskId]").innerHTML =
    `<option value="">（自由分析）</option>` + list.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
  $("#task-list").innerHTML =
    list
      .map(
        (t) => `<li class="task">
        <div class="row between"><strong>${esc(t.name)}</strong>
          <button class="ghost small" data-copy-task="${esc(t.id)}">复制任务说明</button></div>
        <div class="muted small">${esc(t.description)}</div>
        <div class="muted tiny-text">MCP prompt：<code>${esc(t.id)}</code>${t.domainContext ? ` · 含${state.domain === "english" ? "学习上下文" : "文库上下文"}` : ""}</div>
      </li>`,
      )
      .join("") || `<li class="muted small empty-li">没有适用于当前视图的任务模板。</li>`;
  $("#task-inline-row").hidden = state.mode !== "doc";
}

function taskQuery(task) {
  const q = new URLSearchParams();
  if (task.target === "document" && state.paper) q.set("doc_id", state.paper.id);
  if (task.target === "writing" && state.writing) q.set("writing_id", state.writing.id);
  if (state.mode === "doc" && $("#task-inline").checked) q.set("include_text", "1");
  return q.size ? `?${q}` : "";
}

$("#task-list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-copy-task]");
  if (!b) return;
  if (state.mode === "doc") await saveNotes().catch(() => {});
  if (state.mode === "writing") await autoSaveWriting().catch(() => {});
  const task = state.tasks.find((t) => t.id === b.dataset.copyTask);
  try {
    const r = await dapi(`/tasks/${task.id}/render${taskQuery(task)}`);
    await copyText(r.text, b);
  } catch (err) {
    alert(err.message);
  }
});

$("#copy-reading").addEventListener("click", async (e) => {
  await saveNotes().catch(() => {});
  const r = await dapi(`/documents/${state.paper.id}/context`);
  await copyText(r.text, e.target);
});

async function renderConnect() {
  const info = state.globalInfo;
  const d = state.info;
  const name = d.mcpName;
  const auth = info.auth ? ` --header "Authorization: Bearer <READ_TOKEN>"` : "";
  const tokenHeader = info.auth ? `,\n      "headers": { "Authorization": "Bearer <READ_TOKEN>" }` : "";
  const snippets = [
    ["Claude Code（本地 stdio）", `claude mcp add ${name} -- node ${info.stdioEntry} ${d.id}`],
    ["Claude Code（远程 HTTP）", `claude mcp add --transport http ${name} ${info.publicUrl}/mcp/${d.id}${auth}`],
    ["Codex（~/.codex/config.toml）", `[mcp_servers.${name}]\ncommand = "node"\nargs = ["${info.stdioEntry}", "${d.id}"]`],
    ["通用 JSON 配置（HTTP，如 Open WebUI 等支持 MCP 的客户端）", `{\n  "mcpServers": {\n    "${name}": {\n      "type": "http",\n      "url": "${info.publicUrl}/mcp/${d.id}"${tokenHeader}\n    }\n  }\n}`],
    ["CLI（pi、DeepSeek 等）", `${d.terms.cli} help\n# 远程：READ_URL=${info.publicUrl} READ_TOKEN=<token> ${d.terms.cli} …`],
    ...(d.id === "english" ? [["FreshRSS 分享到本应用（自定义分享 URL）", `${info.publicUrl}/?d=english&import=~LINK~`]] : []),
  ];
  $("#connect-body").innerHTML = snippets
    .map(([title, code]) => `<div class="snippet"><div class="row between"><strong>${esc(title)}</strong><button class="ghost tiny" data-copy>复制</button></div><pre>${esc(code)}</pre></div>`)
    .join("");
}
$("#connect-body").addEventListener("click", (e) => {
  if (e.target.dataset.copy !== undefined) copyText(e.target.closest(".snippet").querySelector("pre").textContent, e.target);
});

async function showRun(run) {
  state.currentRun = run;
  $$("#run-list li").forEach((li) => li.classList.toggle("active", li.dataset.run === run?.id));
  if (!run) {
    $("#run-view").hidden = true;
    return;
  }
  $("#run-view").hidden = false;
  $("#run-title").textContent = run.title;
  $("#run-output").innerHTML = md(run.content);
  const meta = [run.agent, run.model, run.taskId && `任务 ${run.taskId}`, new Date(run.createdAt).toLocaleString()];
  if (run.writingId && state.writing?.id === run.writingId) {
    const n = state.writing.versions.findIndex((v) => v.id === run.versionId);
    meta.push(n >= 0 ? `针对第 ${n + 1} 版${n < state.writing.versions.length - 1 ? "（之后已有新版本）" : ""}` : "版本未记录");
  }
  $("#run-meta").textContent = meta.filter(Boolean).join(" · ");
  // 仅对单篇文档任务比较阅读记录是否变化
  const task = state.tasks.find((t) => t.id === run.taskId);
  if (run.docId && run.contextHash && task?.target === "document" && !task.domainContext && state.paper?.id === run.docId) {
    const { hash } = await dapi(`/documents/${run.docId}/context`);
    if (hash !== run.contextHash) $("#run-meta").textContent += " · 阅读记录在此次输出后有变化";
  }
  $("#run-view").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

async function refreshOutputs() {
  const q = state.mode === "writing" ? `writing_id=${state.writing?.id}` : state.mode === "doc" ? `doc_id=${state.paper?.id}` : null;
  if (!q) return;
  state.outputs = await dapi(`/outputs?${q}`);
  renderRuns();
}

function renderRuns() {
  $("#out-count").textContent = state.outputs.length || "";
  $("#run-list").innerHTML =
    state.outputs
      .map(
        (r) => `<li data-run="${r.id}" class="${state.currentRun?.id === r.id ? "active" : ""}">
        <input type="checkbox" data-cmp="${r.id}" ${state.compareIds.has(r.id) ? "checked" : ""} title="选择以对比" />
        <div><div>${esc(r.title)}</div>
        <div class="muted small">${esc(r.agent)}${r.model ? ` · ${esc(r.model)}` : ""} · ${new Date(r.createdAt).toLocaleString()}</div></div>
      </li>`,
      )
      .join("") || `<li class="muted small empty-li">暂无输出。agent 通过 MCP 工具 save_output 或 CLI 写回后显示在这里。</li>`;
  $("#compare-runs").disabled = state.compareIds.size !== 2;
}

$("#run-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-run]");
  if (!li) return;
  if (e.target.dataset.cmp) {
    const id = e.target.dataset.cmp;
    e.target.checked ? state.compareIds.add(id) : state.compareIds.delete(id);
    if (state.compareIds.size > 2) state.compareIds.delete([...state.compareIds][0]);
    renderRuns();
    return;
  }
  showRun(state.outputs.find((r) => r.id === li.dataset.run));
});

$("#run-delete").addEventListener("click", async () => {
  const r = state.currentRun;
  if (!r || !confirm("删除这条输出？")) return;
  await dapi(`/outputs/${r.id}`, { method: "DELETE" });
  state.compareIds.delete(r.id);
  await refreshOutputs();
  showRun(null);
});

$("#compare-runs").addEventListener("click", () => {
  const runs = [...state.compareIds].map((id) => state.outputs.find((r) => r.id === id)).filter(Boolean);
  runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const col = (r) => `<div class="cmp-col">
      <div class="cmp-head"><strong>${esc(r.title)}</strong>
      <div class="muted small">${esc(r.agent)} · ${esc(r.model || "模型未记录")} · ${new Date(r.createdAt).toLocaleString()}</div>
      <div class="muted small">模板 ${esc(r.promptHash || "—")} · 上下文 ${esc(r.contextHash || "—")}${r.versionId ? ` · 版本 ${esc(r.versionId)}` : ""}</div></div>
      <div class="md">${md(r.content)}</div></div>`;
  const diff = [];
  if (runs[0].taskId !== runs[1].taskId) diff.push("任务不同");
  if (runs[0].promptHash !== runs[1].promptHash) diff.push("任务模板不同");
  if (runs[0].contextHash !== runs[1].contextHash) diff.push("上下文不同");
  if (runs[0].versionId !== runs[1].versionId) diff.push("写作版本不同");
  if (runs[0].agent !== runs[1].agent) diff.push("agent 不同");
  if (runs[0].model !== runs[1].model) diff.push("模型不同");
  $("#compare-body").innerHTML = `<p class="muted small">差异项：${diff.join("、") || "无"}</p><div class="cmp-grid">${runs.map(col).join("")}</div>`;
  $("#compare-dialog").showModal();
});
$("#compare-close").addEventListener("click", () => $("#compare-dialog").close());

// 粘贴来自 Open WebUI、网页版 LLM 等渠道的结果
$("#paste-output").addEventListener("click", () => {
  $("#paste-form").reset();
  $("#paste-dialog").showModal();
});
$("#paste-cancel").addEventListener("click", () => $("#paste-dialog").close());
$("#paste-form [name=taskId]").addEventListener("change", (e) => {
  const t = state.tasks.find((t) => t.id === e.target.value);
  const title = $("#paste-form [name=title]");
  if (t && !title.value) title.value = t.name;
});
$("#paste-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const task = state.tasks.find((t) => t.id === f.taskId);
  const body = { taskId: f.taskId || null, title: f.title, content: f.content, agent: f.agent, model: f.model || null, promptHash: task?.promptHash ?? null, meta: { via: "paste" } };
  if (state.mode === "doc") Object.assign(body, { docId: state.paper.id, contextHash: (await dapi(`/documents/${state.paper.id}/context`)).hash });
  if (state.mode === "writing") Object.assign(body, { writingId: state.writing.id, versionId: state.writing.versions.at(-1)?.id ?? null });
  await dapi("/outputs", { method: "POST", json: body });
  $("#paste-dialog").close();
  await refreshOutputs();
});

// agent 在后台写回时自动刷新
setInterval(() => {
  if (!document.hidden && state.mode && !$("#tab-agent").hidden) refreshOutputs().catch(() => {});
}, 5000);

// ======================= 写作（英语） =======================

const countWords = (s) => (s.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;

async function loadWritings() {
  if (!state.info.hasWritings) return;
  state.writings = await dapi("/writings");
  $("#writing-list").innerHTML =
    state.writings
      .map(
        (w) => `<li data-wid="${w.id}" class="${state.writing?.id === w.id ? "active" : ""}">
        <div class="p-title">${esc(w.title)}</div>
        <div class="row small muted"><span class="status">${esc(state.info.writingKinds[w.kind] || w.kind)}</span>
        <span>${w.versionCount} 版</span><span>${w.feedbackCount} 条反馈</span>${w.createdVia === "agent" ? "<span>来自对话</span>" : ""}</div>
      </li>`,
      )
      .join("") || `<li class="muted small empty-li">暂无写作</li>`;
}

$("#writing-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-wid]");
  if (li) openWriting(li.dataset.wid);
});

$("#new-writing").addEventListener("click", async () => {
  const w = await dapi("/writings", { method: "POST", json: { kind: "essay", title: "未命名作文" } });
  await loadWritings();
  await openWriting(w.id);
  $("#w-title").select();
});

function closeDocView() {
  closeSelPop();
  state.paper = null;
  $("#reader-toolbar").hidden = true;
  $("#doc-banner").hidden = true;
  $("#md-view").hidden = true;
  setRef(null);
}

async function openWriting(id) {
  if (state.mode === "writing") await autoSaveWriting().catch(() => {});
  const w = await dapi(`/writings/${id}`);
  closeDocView();
  Object.assign(state, { mode: "writing", writing: w, currentRun: null });
  state.compareIds.clear();
  try { localStorage.setItem(`last-${state.domain}`, `w:${id}`); } catch {}
  $("#empty").hidden = true;
  $("#writing-view").hidden = false;
  $("#panel").hidden = false;
  setPanelMode("writing");
  $("#w-kind").innerHTML = Object.entries(state.info.writingKinds).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  $("#w-kind").value = w.kind;
  $("#w-title").value = w.title;
  $("#w-prompt").value = w.prompt;
  $("#w-doc").innerHTML = `<option value="">（不关联材料）</option>` + state.papers.map((p) => `<option value="${esc(p.id)}">${esc(p.title.slice(0, 60))}</option>`).join("");
  $("#w-doc").value = w.docId || "";
  renderVersions(w.versions.length - 1);
  wDirty = false;
  $("#w-status").textContent = "";
  renderLibrary();
  await loadWritings();
  renderTasks();
  await refreshOutputs();
  showRun(null);
}

function renderVersions(index) {
  const vs = state.writing.versions;
  $("#w-version").innerHTML = vs.length
    ? vs.map((v, i) => `<option value="${i}">第 ${i + 1} 版 · ${new Date(v.createdAt).toLocaleString()}</option>`).join("")
    : `<option value="-1">尚未保存</option>`;
  $("#w-version").value = String(index);
  $("#w-content").value = vs[index]?.content ?? "";
  updateCount();
}

function updateCount() {
  const n = countWords($("#w-content").value);
  $("#w-count").textContent = state.writing?.kind === "essay" ? `${n} 词（六级作文要求 150–200 词）` : `${n} 词`;
}

// 仅在编辑过后才在切换视图时自动保存，避免查看旧版本后切走时把旧内容存为新版本
let wDirty = false;
for (const sel of ["#w-content", "#w-prompt", "#w-title"]) {
  $(sel).addEventListener("input", () => {
    wDirty = true;
    updateCount();
    $("#w-status").textContent = "未保存";
  });
}
for (const sel of ["#w-kind", "#w-doc"]) $(sel).addEventListener("change", () => (wDirty = true));
const autoSaveWriting = () => (wDirty ? saveWriting() : Promise.resolve());
$("#w-version").addEventListener("change", (e) => renderVersions(Number(e.target.value)));

async function saveWriting() {
  if (!state.writing) return;
  wDirty = false;
  const id = state.writing.id;
  await dapi(`/writings/${id}`, {
    method: "PATCH",
    json: { kind: $("#w-kind").value, title: $("#w-title").value.trim() || "未命名", prompt: $("#w-prompt").value, docId: $("#w-doc").value || null },
  });
  const content = $("#w-content").value;
  state.writing = content.trim() ? await dapi(`/writings/${id}/versions`, { method: "POST", json: { content } }) : await dapi(`/writings/${id}`);
  renderVersions(state.writing.versions.length - 1);
  $("#w-status").textContent = `已保存（共 ${state.writing.versions.length} 版）`;
  await loadWritings();
}

$("#w-save").addEventListener("click", saveWriting);
$("#w-content").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
    saveWriting();
  }
});
$("#w-delete").addEventListener("click", async () => {
  if (!confirm(`删除写作《${state.writing.title}》及其全部版本与反馈？`)) return;
  await dapi(`/writings/${state.writing.id}`, { method: "DELETE" });
  state.writing = null;
  state.mode = null;
  $("#writing-view").hidden = true;
  $("#panel").hidden = true;
  $("#empty").hidden = false;
  await loadWritings();
});

// ======================= 档案 =======================

$("#edit-profile").addEventListener("click", async () => {
  $("#profile-title").textContent = state.info.profileLabel;
  $("#profile-text").placeholder = state.info.profilePlaceholder;
  $("#profile-text").value = (await dapi("/profile")).text;
  $("#profile-dialog").showModal();
});
$("#profile-cancel").addEventListener("click", () => $("#profile-dialog").close());
$("#profile-save").addEventListener("click", async () => {
  await dapi("/profile", { method: "PUT", json: { text: $("#profile-text").value } });
  $("#profile-dialog").close();
});

// ======================= 词典管理（英语） =======================

async function renderDictDialog() {
  const st = (state.dictStatus = await dapi("/dict/status"));
  const builtin = ["zk", "gk", "cet4", "cet6", "ky", "toefl", "ielts", "gre"];
  $("#dict-info").innerHTML = st.entries
    ? `ECDICT 已导入 ${st.entries.toLocaleString()} 条（${new Date(st.importedAt).toLocaleString()}）`
    : "尚未导入词典。";
  $("#dict-progress").textContent = st.importing && st.importing.stage !== "done"
    ? st.importing.error ? `导入失败：${st.importing.error}` : `${st.importing.stage === "downloading" ? "下载中" : "导入中"}：${st.importing.rows.toLocaleString()} 条`
    : "";
  $("#dict-lists").innerHTML =
    st.lists
      .map((l) => `<li><span class="badge b-${esc(l.name)}">${esc(l.label)}</span> ${l.count} 词 ${builtin.includes(l.name) ? `<span class="muted">（ECDICT 标签）</span>` : `<button class="ghost tiny danger" data-del-list="${esc(l.name)}">删除</button>`}</li>`)
      .join("") || `<li class="muted">无</li>`;
  return st;
}

$("#open-dict").addEventListener("click", async () => {
  await renderDictDialog();
  $("#dict-dialog").showModal();
});
$("#dict-close").addEventListener("click", async () => {
  $("#dict-dialog").close();
  await loadDictStatus();
  if (state.mode === "doc") await loadDocument();
});
$("#dict-import").addEventListener("click", async () => {
  await dapi("/dict/import-ecdict", { method: "POST", json: {} });
  const poll = async () => {
    const st = await renderDictDialog();
    if (st.importing && !st.importing.error && st.importing.stage !== "done") setTimeout(poll, 1500);
  };
  poll();
});
$("#dict-lists").addEventListener("click", async (e) => {
  const name = e.target.dataset.delList;
  if (!name || !confirm(`删除词表 ${name}？`)) return;
  await dapi(`/dict/lists/${encodeURIComponent(name)}`, { method: "DELETE" });
  renderDictDialog();
});
$("#wordlist-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#wordlist-name").value.trim();
  const file = $("#wordlist-file").files[0];
  if (!name || !file) return;
  const res = await fetch(`${API}/api/${state.domain}/dict/lists/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "text/plain", ...authHeaders() },
    body: await file.text(),
  });
  const r = await res.json();
  $("#wordlist-msg").textContent = res.ok ? `已导入 ${r.count} 词` : r.error;
  e.target.reset();
  renderDictDialog();
});

// ======================= 视图与领域 =======================

// 文档视图显示批注、笔记、Agent；写作视图只显示 Agent（反馈）
function setPanelMode(mode) {
  $$(".tabs [data-tab=annotations], .tabs [data-tab=notes]").forEach((b) => (b.hidden = mode === "writing"));
  $("#agent-tab-label").textContent = mode === "writing" ? "反馈" : "Agent";
  switchTab(mode === "writing" ? "agent" : "annotations");
}

async function switchDomain(id) {
  if (state.mode === "writing") await autoSaveWriting().catch(() => {});
  if (state.mode === "doc") await saveNotes().catch(() => {});
  closeDocView();
  Object.assign(state, { domain: id, mode: null, writing: null, outputs: [], annotations: [], doc: null });
  try { localStorage.setItem("domain", id); } catch {}
  $$("#domain-switch button").forEach((b) => b.classList.toggle("active", b.dataset.domain === id));
  $("#writing-view").hidden = true;
  $("#panel").hidden = true;
  $("#empty").hidden = false;

  state.info = await dapi("/info");
  const english = id === "english";
  document.body.dataset.domain = id;
  $("#doc-heading").textContent = english ? "材料" : "论文";
  $("#import-input").placeholder = english ? "新闻 / 文章链接、PDF 链接" : "arXiv ID / arXiv 链接 / PDF 或 HTML URL";
  $("#empty").innerHTML = english
    ? "导入英文新闻或六级真题后阅读，选中文字标记想吸收的表达。<br />左侧“写作”中提交作文与翻译，agent 的批改显示在右侧。"
    : "从左侧导入或选择一篇论文。<br />PDF 导入后自动解析为 Markdown，在正文中选中文字即可添加标签与评论。";
  const kindOpts = state.info.kinds.map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join("");
  $("#import-kind").innerHTML = kindOpts;
  $("#import-kind").hidden = !english;
  $("#lib-kind").innerHTML = `<option value="">全部类别</option>${kindOpts}`;
  $("#lib-kind").hidden = !english;
  $("#writing-section").hidden = !state.info.hasWritings;
  $("#edit-profile").textContent = state.info.profileLabel;

  $("#vocab-mode").hidden = !state.info.hasDictionary;
  $("#open-dict").hidden = !state.info.hasDictionary;
  state.tags = await dapi("/tags");
  await Promise.all([loadLibrary(), loadTasks(), loadParsers(), loadWritings(), renderConnect(), loadDictStatus()]);
  renderTasks();

  let last = null;
  try { last = localStorage.getItem(`last-${id}`); } catch {}
  if (last?.startsWith("w:") && state.writings?.some((w) => w.id === last.slice(2))) await openWriting(last.slice(2));
  else if (last && state.papers.some((p) => p.id === last)) await openPaper(last);
}

$("#domain-switch").addEventListener("click", (e) => {
  const b = e.target.closest("[data-domain]");
  if (b && b.dataset.domain !== state.domain) switchDomain(b.dataset.domain);
});

// ======================= 标签管理 =======================

function tagRow(t) {
  return `<tr><td><input type="color" value="${esc(t.color)}" data-k="color"></td>
    <td><input value="${esc(t.name)}" data-k="name"></td>
    <td><input value="${esc(t.description)}" data-k="description" class="wide"></td>
    <td><input type="hidden" value="${esc(t.id)}" data-k="id"><button class="ghost tiny danger" data-rm>删除</button></td></tr>`;
}

$("#manage-tags").addEventListener("click", () => {
  $("#tag-table tbody").innerHTML = state.tags.map(tagRow).join("");
  $("#tag-dialog").showModal();
});
$("#tag-add").addEventListener("click", () => {
  $("#tag-table tbody").insertAdjacentHTML("beforeend", tagRow({ id: `t${Date.now().toString(36)}`, name: "", color: "#888888", description: "" }));
});
$("#tag-table").addEventListener("click", (e) => {
  if (e.target.dataset.rm !== undefined) e.target.closest("tr").remove();
});
$("#tag-cancel").addEventListener("click", () => $("#tag-dialog").close());
$("#tag-save").addEventListener("click", async () => {
  const tags = $$("#tag-table tbody tr")
    .map((tr) => Object.fromEntries($$("input", tr).map((i) => [i.dataset.k, i.value.trim()])))
    .filter((t) => t.name);
  state.tags = await dapi("/tags", { method: "PUT", json: tags });
  $("#tag-dialog").close();
  renderAnnotations();
  if (state.paper) applyHighlights();
});

// ======================= 启动 =======================

state.globalInfo = await api("/api/info");
const params = new URLSearchParams(location.search);
let startDomain = params.get("d");
try { startDomain ||= localStorage.getItem("domain"); } catch {}
await switchDomain(state.globalInfo.domains.some((d) => d.id === startDomain) ? startDomain : "academic");

// 从 FreshRSS 等阅读器分享：/?d=english&import=<链接>
if (params.get("import")) {
  const input = params.get("import");
  history.replaceState(null, "", location.pathname);
  await doImport(() => dapi("/documents/import", { method: "POST", json: { input, kind: state.domain === "english" ? "news" : undefined } }));
}

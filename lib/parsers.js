// 解析器适配层：把 PDF 交给外部解析服务，统一转换为按页的 Markdown。
// Markdown 是阅读、批注定位和 agent 读取的主文本；PDF / HTML 仅作对照。
//   - paddleocr-cloud：PaddleOCR 云端异步任务 API（默认，PADDLEOCR_TOKEN）
//   - paddleocr-api：自部署 PaddleOCR-VL 服务的 /layout-parsing
//   - mineru-api：MinerU V1 API（自部署 mineru-kit api-server 或官方服务）
// 解析产物（paper.md、图片）保存在 data/<domain>/files/<id>/parsed/<parser>/。
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { unzipSync } from "fflate";
import { now } from "./store.js";

const env = process.env;
const timeoutMs = () => Number(env.READ_PARSE_TIMEOUT_MS || 60 * 60 * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 通用 ----------

async function writeAsset(outDir, name, data) {
  const target = path.resolve(outDir, name);
  if (!target.startsWith(path.resolve(outDir) + path.sep)) return; // 防止路径穿越
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`下载失败 ${res.status}：${url.slice(0, 120)}`);
  return Buffer.from(await res.arrayBuffer());
}

// PaddleOCR 的 Markdown 中公式写作 "$ x $"、" $$ x $$ "，去掉定界符内侧空格，便于 Markdown 渲染器识别。
// 行内公式按从左到右的顺序成对匹配 $，避免把两个公式之间的正文误当作公式。
export function normalizeMath(md) {
  return md
    .replace(/[ \t]*\$\$[ \t]*([^$]+?)[ \t]*\$\$[ \t]*/g, (_, tex) => `\n\n$$\n${tex.trim()}\n$$\n\n`)
    .split(/(\n\$\$\n[\s\S]*?\n\$\$\n)/)
    .map((part, i) => (i % 2 ? part : part.replace(/\$([^$\n]+)\$/g, (_, tex) => `$${tex.trim()}$`)))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// PaddleOCR 结果页 → 分块，并把图片保存到本地（云端返回的图片地址带过期签名）
async function paddlePagesToChunks(pages, outDir) {
  const chunks = [];
  for (const [i, r] of pages.entries()) {
    const text = normalizeMath(r.markdown?.text || "");
    if (text) chunks.push({ page: i + 1, text });
    for (const [name, data] of Object.entries(r.markdown?.images || {})) {
      await writeAsset(outDir, name, /^https?:/.test(data) ? await download(data) : Buffer.from(data, "base64"));
    }
  }
  if (!chunks.length) throw new Error("PaddleOCR 未返回内容");
  return chunks;
}

// ---------- PaddleOCR 云端异步任务 ----------

const paddleCloud = {
  id: "paddleocr-cloud",
  name: "PaddleOCR-VL（云端 API）",
  available: () => !!env.PADDLEOCR_TOKEN,
  async parse(pdfPath, outDir, onProgress) {
    const jobUrl = (env.PADDLEOCR_JOB_URL || "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs").replace(/\/$/, "");
    const headers = { Authorization: `bearer ${env.PADDLEOCR_TOKEN}` };
    const api = async (url, init) => {
      const res = await fetch(url, { ...init, headers: { ...headers, ...init?.headers }, signal: AbortSignal.timeout(120000) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || (body.code !== undefined && body.code !== 0)) throw new Error(`PaddleOCR API ${res.status}：${body.msg || JSON.stringify(body).slice(0, 300)}`);
      return body.data;
    };

    const form = new FormData();
    form.append("model", env.PADDLEOCR_MODEL || "PaddleOCR-VL-1.6");
    form.append("optionalPayload", JSON.stringify({ useDocOrientationClassify: false, useDocUnwarping: false, useChartRecognition: false }));
    form.append("file", new Blob([await fs.readFile(pdfPath)], { type: "application/pdf" }), path.basename(pdfPath));
    const { jobId } = await api(jobUrl, { method: "POST", body: form });

    const deadline = Date.now() + timeoutMs();
    let data;
    for (;;) {
      await sleep(5000);
      data = await api(`${jobUrl}/${jobId}`);
      const p = data.extractProgress;
      if (p?.totalPages) onProgress(p.extractedPages ?? 0, p.totalPages);
      if (data.state === "done") break;
      if (data.state === "failed") throw new Error(`PaddleOCR 任务失败：${data.errorMsg || "原因未返回"}`);
      if (Date.now() > deadline) throw new Error(`PaddleOCR 任务超时：${jobId}`);
    }

    // 结果为 JSONL，每行一个 result，内含若干页
    const lines = (await download(data.resultUrl.jsonUrl)).toString("utf8").trim().split("\n").filter(Boolean);
    const pages = lines.flatMap((l) => JSON.parse(l).result?.layoutParsingResults || []);
    return paddlePagesToChunks(pages, outDir);
  },
};

// ---------- 自部署 PaddleOCR-VL 服务 ----------

const paddleApi = {
  id: "paddleocr-api",
  name: "PaddleOCR-VL（自部署服务）",
  available: () => !!env.PADDLEOCR_API_URL,
  async parse(pdfPath, outDir) {
    const res = await fetch(env.PADDLEOCR_API_URL.replace(/\/$/, "") + "/layout-parsing", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(env.PADDLEOCR_API_KEY ? { Authorization: `Bearer ${env.PADDLEOCR_API_KEY}` } : {}) },
      body: JSON.stringify({ file: (await fs.readFile(pdfPath)).toString("base64"), fileType: 0 }),
      signal: AbortSignal.timeout(timeoutMs()),
    });
    if (!res.ok) throw new Error(`PaddleOCR 服务 ${res.status}：${(await res.text()).slice(0, 300)}`);
    return paddlePagesToChunks((await res.json()).result?.layoutParsingResults || [], outDir);
  },
};

// ---------- MinerU V1 API ----------

function blockText(block) {
  const flat = (v) => {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map(flat).join("");
    if (typeof v === "object") return flat(v.markdown ?? v.latex ?? v.html ?? v.text ?? v.content ?? "");
    return String(v);
  };
  const text = flat(block.content).trim();
  if (!text) return "";
  if (block.type === "title") return `## ${text}`;
  if (block.type === "equation" || block.type === "interline_equation") return text.startsWith("$$") ? text : `$$\n${text}\n$$`;
  return text;
}

const mineruApi = {
  id: "mineru-api",
  name: "MinerU（V1 API）",
  available: () => !!env.MINERU_API_URL,
  async parse(pdfPath, outDir) {
    const base = env.MINERU_API_URL.replace(/\/$/, "");
    const auth = env.MINERU_API_KEY ? { Authorization: `Bearer ${env.MINERU_API_KEY}` } : {};
    const call = async (url, init = {}) => {
      const res = await fetch(base + url, { ...init, headers: { ...auth, ...init.headers } });
      if (!res.ok) throw new Error(`MinerU API ${res.status}：${(await res.text()).slice(0, 300)}`);
      return res;
    };
    const bytes = await fs.readFile(pdfPath);
    const sha256sum = crypto.createHash("sha256").update(bytes).digest("hex");
    let up = await (
      await call("/v1/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: path.basename(pdfPath), bytes: bytes.length, mime_type: "application/pdf", purpose: "parse", sha256sum }),
      })
    ).json();
    if (up.status === "pending") {
      // 仅同源上传地址附带 API key，避免凭据发往对象存储
      const uploadUrl = new URL(up.upload_url, base + "/");
      const sameOrigin = uploadUrl.origin === new URL(base).origin;
      const res = await fetch(uploadUrl, { method: up.upload_method || "PUT", headers: { ...(up.upload_headers || {}), ...(sameOrigin ? auth : {}) }, body: bytes });
      if (!res.ok) throw new Error(`MinerU 上传失败 ${res.status}`);
      up = await (await call(`/v1/uploads/${up.id}/complete`, { method: "POST" })).json();
    }
    let job = await (
      await call("/v1/parse/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: [{ source: { type: "file_id", file_id: up.file.id } }], tier: env.MINERU_TIER || "standard", output_formats: ["zip"] }),
      })
    ).json();
    const deadline = Date.now() + timeoutMs();
    while (!["completed", "partial", "failed", "canceled"].includes(job.status)) {
      if (Date.now() > deadline) throw new Error(`MinerU 任务超时：${job.job_id}`);
      await sleep(3000);
      job = await (await call(`/v1/parse/jobs/${job.job_id}`)).json();
    }
    const zipId = (job.files || []).find((f) => f.status === "completed")?.output_files?.zip?.file_id;
    if (!zipId) throw new Error(`MinerU 任务状态 ${job.status}：${JSON.stringify(job.files?.[0]?.error ?? "")}`);
    const files = unzipSync(new Uint8Array(await (await call(`/v1/files/${zipId}/content`)).arrayBuffer()));
    for (const [name, data] of Object.entries(files)) await writeAsset(outDir, name, data);

    const decoder = new TextDecoder();
    const find = (n) => Object.keys(files).find((k) => k === n || k.endsWith("/" + n));
    const sc = find("structured_content.json");
    if (sc) {
      const pages = JSON.parse(decoder.decode(files[sc])).pages || [];
      const chunks = pages.map((p) => ({ page: p.page_idx + 1, text: (p.blocks || []).map(blockText).filter(Boolean).join("\n\n") })).filter((c) => c.text);
      if (chunks.length) return chunks;
    }
    const md = find("markdown.md");
    if (!md) throw new Error("MinerU 输出中未找到 markdown.md");
    return [{ page: null, text: decoder.decode(files[md]) }];
  },
};

export const PARSERS = [paddleCloud, paddleApi, mineruApi];

export function availableParsers() {
  return PARSERS.map((p) => ({ id: p.id, name: p.name, available: p.available() }));
}

// 导入后自动解析所用的解析器：READ_AUTO_PARSER，未设置时取第一个可用解析器
export function defaultParser() {
  if (env.READ_AUTO_PARSER !== undefined) return env.READ_AUTO_PARSER === "none" ? null : env.READ_AUTO_PARSER;
  return PARSERS.find((p) => p.available())?.id ?? null;
}

// ---------- 任务队列（进程内串行） ----------

let queue = Promise.resolve();

export async function enqueueParse(store, docId, parserId = defaultParser()) {
  const doc = store.getDocument(docId);
  if (!doc) throw new Error(`文档不存在：${docId}`);
  if (!doc.formats.includes("pdf")) throw new Error("仅支持解析 PDF");
  const parser = PARSERS.find((p) => p.id === parserId);
  if (!parser) throw new Error(`未知解析器：${parserId}，可选：${PARSERS.map((p) => p.id).join(", ")}`);
  if (!parser.available()) throw new Error(`解析器 ${parserId} 未配置`);

  const job = store.addParse(docId, parserId);
  queue = queue.then(async () => {
    store.updateParse(job.id, { status: "running" });
    const outDir = store.filePath(docId, path.join("parsed", parserId));
    try {
      await fs.rm(outDir, { recursive: true, force: true });
      await fs.mkdir(outDir, { recursive: true });
      const chunks = await parser.parse(store.filePath(docId, "source.pdf"), outDir, (done, total) =>
        store.updateParse(job.id, { progressDone: done, progressTotal: total }),
      );
      await fs.writeFile(path.join(outDir, "paper.md"), chunks.map((c) => (c.page ? `<!-- 第 ${c.page} 页 -->\n\n` : "") + c.text).join("\n\n"));
      store.replaceChunks(docId, chunks, parserId);
      store.updateParse(job.id, { status: "done", pages: chunks.length, finishedAt: now() });
    } catch (err) {
      store.updateParse(job.id, { status: "failed", error: String(err.message || err).slice(0, 2000), finishedAt: now() });
    }
  });
  return job;
}

export async function waitParse(store, jobId, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const j = store.getParse(jobId);
    if (!j || ["done", "failed"].includes(j.status) || Date.now() > deadline) return j;
    await sleep(1000);
  }
}

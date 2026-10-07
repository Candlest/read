// 任务模板：prompts/<domain>/*.md。frontmatter 字段：
//   name / description
//   target: document | writing | none —— 任务作用对象（默认 document）
//   context: domain —— 附带领域级上下文（学术为文库阅读记录，英语为学习上下文）
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROMPTS_DIR = path.resolve(process.env.READ_PROMPTS_DIR || path.join(ROOT, "prompts"));

function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { attrs: {}, body: raw.trim() };
  const attrs = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) attrs[kv[1]] = kv[2].trim();
  }
  return { attrs, body: m[2].trim() };
}

export async function listTasks(domain) {
  const dir = path.join(PROMPTS_DIR, domain.id);
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith(".md")).sort();
  const tasks = [];
  for (const f of files) {
    const { attrs, body } = parseFrontmatter(await fs.readFile(path.join(dir, f), "utf8"));
    const id = path.parse(f).name.replace(/^\d+-/, "");
    tasks.push({
      id,
      name: attrs.name || id,
      description: attrs.description || "",
      target: attrs.target || "document",
      domainContext: attrs.context === "domain",
      body,
      promptHash: sha256(domain.principles + "\n" + body),
    });
  }
  return tasks;
}

export async function getTask(domain, taskId) {
  const t = (await listTasks(domain)).find((x) => x.id === taskId);
  if (!t) throw new Error(`任务不存在：${taskId}`);
  return t;
}

/**
 * 渲染可直接交给任意 agent / LLM 的任务说明：原则 + 上下文 + 任务 + 写回要求。
 * args: { docId, writingId, includeText, baseUrl }
 */
export async function renderTask(domain, store, taskId, args = {}) {
  const task = await getTask(domain, taskId);
  if (task.target === "document" && !args.docId) throw new Error(`任务 ${task.id} 需要 ${domain.terms.docParam}`);
  if (task.target === "writing" && !args.writingId) throw new Error(`任务 ${task.id} 需要 writing_id`);

  const parts = [`<principles>\n${domain.principles}\n</principles>`];
  const hashParts = [];
  if (task.domainContext || task.target === "none") {
    const c = domain.domainContext(store, { excludeDocId: args.docId, excludeWritingId: args.writingId });
    parts.push(c.text);
    hashParts.push(c.text);
  }
  if (task.target === "writing") {
    const c = domain.writingContext(store, args.writingId);
    parts.push(c.text);
    hashParts.push(c.text);
  }
  const docId = args.docId || (task.target === "writing" ? store.getWriting(args.writingId)?.docId : null);
  if (docId) {
    const c = domain.docContext(store, docId);
    parts.push(c.text);
    hashParts.push(c.text);
    if (args.includeText) {
      parts.push(`<document_text>\n${store.getText(docId, { maxChars: Infinity }).text}\n</document_text>`);
    } else {
      const doc = store.getDocument(docId);
      const lines = [
        `- ${domain.terms.textTool}(${domain.terms.docParam}="${docId}") 分页读取正文 Markdown（正文来源：${doc.textSource}，与用户阅读的文本及页码一致）`,
        `- search_text 在全文中检索`,
      ];
      if (doc.formats.includes("pdf")) {
        lines.push(
          args.baseUrl
            ? `- 原始 PDF（查看图表原貌时使用）：${args.baseUrl}/api/${domain.id}/documents/${docId}/source.pdf（需 Bearer token）`
            : `- 原始 PDF（查看图表原貌时使用）：${store.filePath(docId, "source.pdf")}`,
        );
      }
      parts.push(`<document_access>\n正文未内联，按需读取：\n${lines.join("\n")}\n</document_access>`);
    }
  }
  parts.push(`<task id="${task.id}" name="${task.name}">\n${task.body}\n</task>`);

  const contextHash = sha256(hashParts.join("\n"));
  const target = [
    docId && `${domain.terms.docParam}="${docId}"`,
    args.writingId && `writing_id="${args.writingId}"`,
    args.writingId && `version_id="${store.getWriting(args.writingId)?.versions.at(-1)?.id ?? ""}"`,
  ]
    .filter(Boolean)
    .join("，");
  parts.push(
    `<save>\n完成后写回结果（二选一）：\n` +
      `- MCP：save_output(${target ? target + "，" : ""}task_id="${task.id}"，title="${task.name}"，context_hash="${contextHash}"，prompt_hash="${task.promptHash}"，content=完整 Markdown，agent=实际 agent 名称，model=实际模型 ID)\n` +
      `- CLI：${domain.terms.cli} save${docId ? ` --doc ${docId}` : ""}${args.writingId ? ` --writing ${args.writingId} --version ${store.getWriting(args.writingId)?.versions.at(-1)?.id ?? ""}` : ""} --task ${task.id} --title "${task.name}" --context-hash ${contextHash} --prompt-hash ${task.promptHash} --agent <agent> --model <模型> --file <输出文件>\n</save>`,
  );
  return { text: parts.join("\n\n"), task, contextHash };
}

// 学术领域：论文阅读。上下文 = 单篇论文的批注与笔记；领域级上下文 = 文库中其他论文的阅读记录。
import { sha256 } from "../store.js";

const defaultTags = [
  { id: "contribution", name: "核心贡献", color: "#e5484d", description: "论文声称的主要贡献或创新点" },
  { id: "method", name: "方法", color: "#3e63dd", description: "方法、模型结构、算法步骤" },
  { id: "experiment", name: "实验", color: "#30a46c", description: "实验设置、数据集、指标与结果" },
  { id: "claim", name: "结论", color: "#8e4ec6", description: "作者给出的结论或论断" },
  { id: "question", name: "疑问", color: "#f76b15", description: "阅读时未理解或存疑的内容，需要解答" },
  { id: "limitation", name: "局限", color: "#6f6e77", description: "方法或实验的局限、假设、潜在问题" },
  { id: "reuse", name: "可借鉴", color: "#12a594", description: "可用于自己研究的思路、技巧或代码" },
  { id: "background", name: "背景", color: "#ad7f58", description: "相关工作、定义、背景知识" },
];

const principles = `用户手工阅读论文（Markdown 版本，公式为 LaTeX），留下了批注（原文摘录 + 标签 + 评论）和阅读笔记。处理这些数据时遵循以下原则：
- 用户的批注与笔记是阅读的主体。agent 的输出用于检验、补充和延伸用户的理解，不替代用户的阅读，不修改用户的批注和笔记。
- 论断须以原文为依据，引用原文时注明页码或章节；原文中找不到依据时写“原文未提及”。
- 区分原文内容、用户的理解、agent 的推断三类内容，推断部分须标明。
- 原因或结论无法从原文确认时，写“原因未查明”或“结论待定”，不补充未经验证的解释。
- 使用中文，术语保留英文原名，使用标准术语与直接表述。
- 产出完成后通过 MCP 工具 save_output 或 CLI 命令 read-academic save 写回，填写 agent 与实际使用的 model，并原样传入 context_hash 与 prompt_hash。`;

function formatAnnotation(a, tagMap) {
  const tags = a.tags.map((t) => tagMap.get(t)?.name || t).join("、") || "无标签";
  let s = `- [${tags}]（${a.page ? `第 ${a.page} 页` : "正文"}）摘录：「${a.quote.trim()}」`;
  if (a.comment.trim()) s += `\n  评论：${a.comment.trim()}`;
  return s;
}

function docContext(store, docId) {
  const p = store.getDocument(docId);
  if (!p) throw new Error(`论文不存在：${docId}`);
  const anns = store.getAnnotations(docId);
  const notes = store.getNotes(docId);
  const tags = store.getTags();
  const tagMap = new Map(tags.map((t) => [t.id, t]));
  const used = tags.filter((t) => anns.some((a) => a.tags.includes(t.id)));
  const profile = store.getProfile().trim();
  const parts = [];
  if (profile) parts.push(`<my_research_profile>\n${profile}\n</my_research_profile>`);
  parts.push(
    `<paper_meta>\nID：${p.id}\n标题：${p.title}\n作者：${p.authors.join(", ") || "未知"}` +
      (p.arxivId ? `\narXiv：${p.arxivId}` : "") +
      (p.numPages ? `\n页数：${p.numPages}` : "") +
      `\n正文来源：${p.textSource}\n阅读状态：${p.status}\n</paper_meta>`,
  );
  if (p.abstract) parts.push(`<abstract>\n${p.abstract}\n</abstract>`);
  if (used.length) parts.push(`<tag_definitions>\n${used.map((t) => `- ${t.name}：${t.description}`).join("\n")}\n</tag_definitions>`);
  parts.push(`<my_annotations count="${anns.length}">\n${anns.map((a) => formatAnnotation(a, tagMap)).join("\n") || "（无批注）"}\n</my_annotations>`);
  parts.push(`<my_notes>\n${notes.trim() || "（无笔记）"}\n</my_notes>`);
  const text = parts.join("\n\n");
  return { text, hash: sha256(text) };
}

// 文库：其他带笔记或批注的论文
function domainContext(store, { excludeDocId } = {}) {
  const tagMap = new Map(store.getTags().map((t) => [t.id, t]));
  const items = [];
  for (const p of store.listDocuments()) {
    if (p.id === excludeDocId) continue;
    const notes = store.getNotes(p.id);
    const anns = store.getAnnotations(p.id);
    if (!notes.trim() && !anns.length) continue;
    items.push(
      `<library_paper id="${p.id}">\n标题：${p.title}\n笔记：\n${notes.trim() || "（无）"}\n批注：\n` +
        `${anns.map((a) => formatAnnotation(a, tagMap)).join("\n") || "（无）"}\n</library_paper>`,
    );
  }
  const text = items.length ? `<my_library>\n${items.join("\n\n")}\n</my_library>` : "<my_library>（文库中没有其他带笔记的论文）</my_library>";
  return { text, hash: sha256(text) };
}

export default {
  id: "academic",
  name: "学术",
  mcpName: "read-academic",
  defaultTags,
  principles,
  kinds: [],
  profileLabel: "研究背景",
  profilePlaceholder: "研究方向、正在做的课题、关心的问题……（随阅读记录提供给 agent）",
  terms: {
    doc: "论文",
    docTool: "paper", // 工具名后缀：list_papers / get_paper_text …
    docParam: "paper_id",
    textTool: "get_paper_text",
    annTool: "search_annotations",
    contextTool: "get_reading_context",
    domainContextTool: "get_library_context",
    cli: "read-academic",
  },
  instructions:
    "学术论文阅读文库。用户在 Web 界面中阅读论文的 Markdown 版本，手工打标签、写评论和笔记，这些人工数据通过本服务提供给 agent。\n" +
    "常用流程：list_papers → get_reading_context → get_paper_text / search_text → 完成分析 → save_output。\n" +
    "导入：agent 自行检索论文（可配合 arxiv-mcp-server 等工具）后调用 import_paper；PDF 会自动解析为 Markdown，get_parse_status 查看进度。\n" +
    "任务模板：list_tasks 查看，get_task 取得完整任务说明（已包含阅读记录与写回参数）。复杂统计可用 query_sql（只读）。",
  docContext,
  domainContext,
  writingContext: () => {
    throw new Error("学术领域不包含写作");
  },
  hasWritings: false,
};

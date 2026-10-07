// 英语领域：CET-6 备考。方法取向为连接主义与行为主义：大量高质量输入（新闻、真题），
// 在与 AI 的对话和批改中获得反馈。不提供语法分析、词汇统计类功能。
// 上下文 = 学习档案 + 近期输入中标记的表达 + 写作及其反馈历史。
import { sha256 } from "../store.js";

const defaultTags = [
  { id: "expression", name: "好表达", color: "#3e63dd", description: "想吸收并在写作、口语中使用的地道表达" },
  { id: "pattern", name: "句式", color: "#8e4ec6", description: "值得模仿的句子结构" },
  { id: "idea", name: "观点素材", color: "#30a46c", description: "可用于作文论证的观点、事实、例子" },
  { id: "unclear", name: "没读懂", color: "#f76b15", description: "读不懂或不确定含义的句子" },
  { id: "translation", name: "翻译素材", color: "#12a594", description: "可用于汉译英的对应说法" },
  { id: "vocab", name: "生词", color: "#e5484d", description: "需要记住的单词或词组" },
];

const principles = `用户在备考大学英语六级（CET-6），方法取向为连接主义与行为主义：通过大量高质量输入（英文新闻、六级真题）建立语感，通过写作和对话中的反馈调整输出。用户阅读材料时标记想吸收的表达，并提交作文、翻译等写作。处理这些数据时遵循以下原则：
- 反馈以示范为主：给出改写后的完整版本和逐句对照（原句 → 改写），用重述代替规则讲解，不使用语法术语，不做词频、词汇等级等统计分析。
- 改写保留用户的原意和观点，只改表达；需要补充观点时单独列出并标明。
- 优先复用用户在阅读材料中标记的表达（学习上下文中给出），使输入与输出相连。
- 评价参照六级写作、翻译的评分要求；无法确定档次时写“结论待定”。
- 说明使用中文，示范内容使用英文。
- 产出完成后通过 MCP 工具 save_output 或 CLI 命令 read-english save 写回，填写 agent 与实际使用的 model，并原样传入 context_hash、prompt_hash 以及 writing_id、version_id。`;

const KINDS = [
  { id: "news", name: "新闻" },
  { id: "exam", name: "真题" },
  { id: "other", name: "其他" },
];
const WRITING_KINDS = { essay: "作文", translation: "翻译", retell: "复述", other: "其他" };

function formatHighlight(a, tagMap) {
  const tags = a.tags.map((t) => tagMap.get(t)?.name || t).join("、") || "无标签";
  let s = `- [${tags}] ${a.quote.trim()}`;
  if (a.comment.trim()) s += `\n  备注：${a.comment.trim()}`;
  return s;
}

function docContext(store, docId) {
  const d = store.getDocument(docId);
  if (!d) throw new Error(`材料不存在：${docId}`);
  const tagMap = new Map(store.getTags().map((t) => [t.id, t]));
  const anns = store.getAnnotations(docId);
  const notes = store.getNotes(docId);
  const kind = KINDS.find((k) => k.id === d.kind)?.name || "未分类";
  const text = [
    `<material id="${d.id}">\n标题：${d.title}\n类别：${kind}${d.url ? `\n来源：${d.url}` : ""}\n阅读状态：${d.status}\n</material>`,
    `<my_highlights count="${anns.length}">\n${anns.map((a) => formatHighlight(a, tagMap)).join("\n") || "（无标记）"}\n</my_highlights>`,
    `<my_notes>\n${notes.trim() || "（无笔记）"}\n</my_notes>`,
  ].join("\n\n");
  return { text, hash: sha256(text) };
}

const latest = (w) => w.versions.at(-1)?.content ?? "";

// 学习上下文：档案 + 近期输入的标记表达 + 近期写作与最近一次反馈
function domainContext(store, { recentDocs = 10, recentWritings = 5, excludeWritingId } = {}) {
  const tagMap = new Map(store.getTags().map((t) => [t.id, t]));
  const parts = [];
  const profile = store.getProfile().trim();
  parts.push(`<learner_profile>\n${profile || "（未填写）"}\n</learner_profile>`);

  const docs = store.listDocuments().filter((d) => d.annotationCount > 0).slice(0, recentDocs);
  parts.push(
    `<recent_input count="${docs.length}">\n` +
      docs
        .map((d) => `<material id="${d.id}" title="${d.title.replace(/"/g, "'")}">\n${store.getAnnotations(d.id).map((a) => formatHighlight(a, tagMap)).join("\n")}\n</material>`)
        .join("\n") +
      `\n</recent_input>`,
  );

  const ws = store
    .listWritings({ limit: recentWritings + 1 })
    .filter((w) => w.id !== excludeWritingId)
    .slice(0, recentWritings)
    .map((w) => store.getWriting(w.id));
  parts.push(
    `<recent_writings count="${ws.length}">\n` +
      ws
        .map((w) => {
          const fb = store.listOutputs({ writingId: w.id, limit: 1 })[0];
          return (
            `<writing id="${w.id}" kind="${WRITING_KINDS[w.kind] || w.kind}" versions="${w.versions.length}">\n题目：${w.title}\n最新版本：\n${latest(w) || "（空）"}\n` +
            (fb ? `最近一次反馈（${fb.agent}${fb.model ? ` / ${fb.model}` : ""}）：\n${fb.content.slice(0, 1500)}\n` : "") +
            `</writing>`
          );
        })
        .join("\n") +
      `\n</recent_writings>`,
  );
  const text = parts.join("\n\n");
  return { text, hash: sha256(text) };
}

// 单篇写作：题目、全部版本、历次反馈
function writingContext(store, writingId) {
  const w = store.getWriting(writingId);
  if (!w) throw new Error(`写作不存在：${writingId}`);
  const fbs = store.listOutputs({ writingId }).reverse();
  const text = [
    `<writing id="${w.id}" kind="${WRITING_KINDS[w.kind] || w.kind}">\n标题：${w.title}\n题目 / 原文：\n${w.prompt || "（未填写）"}\n</writing>`,
    ...w.versions.map((v, i) => `<version n="${i + 1}" id="${v.id}" created="${v.createdAt}">\n${v.content}\n</version>`),
    ...fbs.map((o) => `<previous_feedback agent="${o.agent}" model="${o.model || ""}" version_id="${o.versionId || ""}">\n${o.content}\n</previous_feedback>`),
  ].join("\n\n");
  return { text, hash: sha256(text) };
}

export default {
  id: "english",
  name: "英语",
  mcpName: "read-english",
  defaultTags,
  principles,
  kinds: KINDS,
  writingKinds: WRITING_KINDS,
  profileLabel: "学习档案",
  profilePlaceholder: "目标分数、考试时间、当前写作与口语中的问题、感兴趣的话题……（随学习上下文提供给 agent 与对话）",
  terms: {
    doc: "材料",
    docTool: "material",
    docParam: "material_id",
    textTool: "get_material_text",
    annTool: "search_highlights",
    contextTool: "get_material_context",
    domainContextTool: "get_learning_context",
    cli: "read-english",
  },
  instructions:
    "CET-6 英语学习库。用户阅读英文新闻与六级真题并标记想吸收的表达，提交作文、翻译等写作；本服务向 agent 提供这些数据并接收反馈。\n" +
    "对话练习前先调用 get_learning_context 取得学习档案、近期输入的标记表达与写作历史。\n" +
    "批改流程：list_writings → get_task(task_id=essay-feedback 或 translation-feedback, writing_id) → 按说明批改 → save_output（带 writing_id 与 version_id）。\n" +
    "用户在对话中写下的作文或翻译可用 save_writing 保存，再进行批改。\n" +
    "导入材料：import_material（新闻链接会抽取正文；真题 PDF 自动解析为 Markdown）。\n" +
    "lookup_word 查本地词典（ECDICT）的释义、词形原形与所属词表（四级、六级、考研等）。\n" +
    "不提供语法分析、词汇统计类功能，反馈以示范和重述为主。",
  docContext,
  domainContext,
  writingContext,
  hasWritings: true,
  hasDictionary: true,
};

// MCP 服务：每个领域一个独立服务（read-academic / read-english），工具名、参数与上下文各自独立。
// 同一份定义用于 stdio（本机 agent）与 Streamable HTTP（/mcp/<domain>）。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDomain, storeFor, dictFor } from "./domains/index.js";
import { createImporter } from "./importer.js";
import * as parsers from "./parsers.js";
import * as tasks from "./tasks.js";

const json = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const text = (value) => ({ content: [{ type: "text", text: value }] });
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export async function createMcpServer(domainId, { baseUrl = process.env.READ_PUBLIC_URL || "", allowLocalFiles = false } = {}) {
  const domain = getDomain(domainId);
  const store = storeFor(domain);
  const importer = createImporter(store);
  const t = domain.terms;
  const docArg = { [t.docParam]: z.string() };
  const docIdOf = (a) => a?.[t.docParam];
  const need = (id) => {
    if (!store.getDocument(id)) throw new Error(`${t.doc}不存在：${id}`);
    return id;
  };

  const server = new McpServer({ name: domain.mcpName, version: "1.0.0" }, { instructions: `${domain.instructions}\n\n${domain.principles}` });

  // ---------- 文档与正文 ----------

  server.registerTool(
    `list_${t.docTool}s`,
    {
      title: `列出${t.doc}`,
      description: `列出库中的${t.doc}及批注数、是否有笔记、agent 输出数。可按阅读状态、关键词${domain.kinds.length ? "、类别" : ""}过滤。`,
      inputSchema: {
        status: z.enum(["未读", "阅读中", "已完成"]).optional(),
        query: z.string().optional(),
        ...(domain.kinds.length && { kind: z.enum(domain.kinds.map((k) => k.id)).optional() }),
      },
      annotations: READ_ONLY,
    },
    async ({ status, query, kind }) =>
      json(
        store.listDocuments({ status, query, kind }).map((d) => ({
          id: d.id, title: d.title, kind: d.kind ?? undefined, authors: d.authors.slice(0, 5), arxivId: d.arxivId ?? undefined,
          status: d.status, textSource: d.textSource, annotationCount: d.annotationCount, hasNotes: d.hasNotes, outputCount: d.outputCount, updatedAt: d.updatedAt,
        })),
      ),
  );

  server.registerTool(
    t.contextTool,
    {
      title: `${t.doc}阅读记录`,
      description: `返回某篇${t.doc}的元数据与用户的批注（摘录 + 标签 + 评论）、笔记，以及 context_hash。这是用户的第一手阅读数据。`,
      inputSchema: docArg,
      annotations: READ_ONLY,
    },
    async (a) => {
      const c = domain.docContext(store, need(docIdOf(a)));
      return text(`${c.text}\n\ncontext_hash: ${c.hash}`);
    },
  );

  server.registerTool(
    t.textTool,
    {
      title: `读取${t.doc}正文`,
      description: `分页读取${t.doc}的 Markdown 正文（与用户阅读的文本一致；PDF 解析结果带“[第 N 页]”标记，公式为 LaTeX）。next_offset 不为空时可继续读取。`,
      inputSchema: {
        ...docArg,
        page_from: z.number().int().positive().optional(),
        page_to: z.number().int().positive().optional(),
        offset: z.number().int().min(0).optional(),
        max_chars: z.number().int().positive().max(200000).optional(),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      const r = store.getText(need(docIdOf(a)), { pageFrom: a.page_from, pageTo: a.page_to, offset: a.offset ?? 0, maxChars: a.max_chars ?? 40000 });
      return text(`${r.text}\n\n---\ntotal_chars: ${r.totalChars}, next_offset: ${r.nextOffset ?? "null"}`);
    },
  );

  server.registerTool(
    `get_${t.docTool}_file`,
    {
      title: "原始文件位置",
      description: `返回${t.doc}原始 PDF / HTML 与解析产物（Markdown、图片）的本地路径与 HTTP 地址。`,
      inputSchema: docArg,
      annotations: READ_ONLY,
    },
    async (a) => {
      const id = need(docIdOf(a));
      const d = store.getDocument(id);
      const url = (p) => (baseUrl ? `${baseUrl}/api/${domain.id}/documents/${id}/${p}` : null);
      const out = Object.fromEntries(d.formats.map((f) => [f, { localPath: store.filePath(id, `source.${f}`), url: url(`source.${f}`) }]));
      out.parsed = [...new Set(store.listParses(id).filter((j) => j.status === "done").map((j) => j.parser))].map((p) => ({
        parser: p,
        markdownPath: store.filePath(id, `parsed/${p}/paper.md`),
        url: url(`parsed/${p}/paper.md`),
      }));
      out.textSource = d.textSource;
      return json(out);
    },
  );

  server.registerTool(
    "search_text",
    {
      title: "全文检索",
      description: `在库中全部${t.doc}（或指定${t.doc}）的正文中检索，返回位置与片段。查询至少 3 个字符，支持 FTS5 语法。`,
      inputSchema: { query: z.string().min(3), [t.docParam]: z.string().optional(), limit: z.number().int().positive().max(100).optional() },
      annotations: READ_ONLY,
    },
    async (a) => json(store.searchText(a.query, { docId: docIdOf(a), limit: a.limit ?? 20 })),
  );

  server.registerTool(
    t.annTool,
    {
      title: "检索批注",
      description: `跨${t.doc}检索用户的批注，可按标签 id（见 list_tags）、关键词、${t.doc}过滤。`,
      inputSchema: { tag: z.string().optional(), query: z.string().optional(), [t.docParam]: z.string().optional(), limit: z.number().int().positive().max(500).optional() },
      annotations: READ_ONLY,
    },
    async (a) => json(store.searchAnnotations({ tag: a.tag, query: a.query, docId: docIdOf(a), limit: a.limit }).map(({ prefix, suffix, start, ...x }) => x)),
  );

  server.registerTool(
    "list_tags",
    { title: "标签定义", description: "用户的标签体系：id、名称、含义说明。", annotations: READ_ONLY },
    async () => json(store.getTags()),
  );

  server.registerTool(
    t.domainContextTool,
    {
      title: domain.id === "english" ? "学习上下文" : "文库阅读记录",
      description:
        domain.id === "english"
          ? "返回学习档案、近期输入材料中标记的表达、近期写作与最近一次反馈。对话练习、批改前先读取。"
          : "汇总文库中所有带笔记或批注的论文的阅读记录，用于跨论文关联分析。内容可能较长。",
      inputSchema: domain.id === "english" ? {} : { exclude_paper_id: z.string().optional() },
      annotations: READ_ONLY,
    },
    async (a) => {
      const c = domain.domainContext(store, { excludeDocId: a?.exclude_paper_id });
      return text(`${c.text}\n\ncontext_hash: ${c.hash}`);
    },
  );

  // ---------- 写作（英语） ----------

  if (domain.hasWritings) {
    const kindEnum = z.enum(Object.keys(domain.writingKinds));
    server.registerTool(
      "list_writings",
      { title: "写作列表", description: "列出用户的作文、翻译、复述等写作（版本数、反馈数）。", inputSchema: { kind: kindEnum.optional() }, annotations: READ_ONLY },
      async ({ kind }) => json(store.listWritings({ kind })),
    );
    server.registerTool(
      "get_writing",
      { title: "读取写作", description: "返回一篇写作的题目、全部版本与历次反馈。", inputSchema: { writing_id: z.string() }, annotations: READ_ONLY },
      async ({ writing_id }) => {
        const c = domain.writingContext(store, writing_id);
        return text(`${c.text}\n\ncontext_hash: ${c.hash}`);
      },
    );
    server.registerTool(
      "save_writing",
      {
        title: "保存写作",
        description:
          "保存用户写下的作文、翻译或复述（例如在对话中写的）。传 writing_id 时为已有写作追加新版本，否则新建。只保存用户本人写的内容，agent 的改写放在 save_output 中。",
        inputSchema: {
          writing_id: z.string().optional(),
          kind: kindEnum.optional(),
          title: z.string().optional(),
          prompt: z.string().optional().describe("题目；翻译为中文原文"),
          material_id: z.string().optional(),
          content: z.string(),
        },
        annotations: WRITE,
      },
      async (a) => {
        const w = a.writing_id
          ? store.getWriting(a.writing_id) && store.addVersion(a.writing_id, a.content)
          : store.createWriting({ kind: a.kind, title: a.title, prompt: a.prompt, docId: a.material_id, content: a.content, createdVia: "agent" });
        if (!w) throw new Error(`写作不存在：${a.writing_id}`);
        return json({ writing_id: w.id, version_id: w.versions.at(-1)?.id, versions: w.versions.length });
      },
    );
  }

  // ---------- 词典（英语） ----------

  if (domain.hasDictionary) {
    const dict = dictFor(domain);
    server.registerTool(
      "lookup_word",
      {
        title: "查词",
        description: "查本地词典（ECDICT）：音标、中文释义、英文释义、词形原形（如 complained → complain）、所属词表（四级、六级、考研、托福、雅思、GRE 及用户导入的词表）。",
        inputSchema: { words: z.array(z.string()).min(1).max(50) },
        annotations: READ_ONLY,
      },
      async ({ words }) => {
        if (!dict.status().entries) throw new Error("词典尚未导入：在界面中导入 ECDICT，或运行 read-english dict-import");
        return json(words.map((w) => dict.lookup(w)));
      },
    );
    server.registerTool(
      "filter_wordlist",
      {
        title: "按词表筛选",
        description: "从一批单词中筛出属于某词表的词（按原形判断），例如 include=cet6、exclude=cet4 得到六级新增词。用于出题、选择示范用词时对照考纲词表。",
        inputSchema: { words: z.array(z.string()).max(5000), include: z.string(), exclude: z.string().optional() },
        annotations: READ_ONLY,
      },
      async (a) => json(dict.mark(a.words, { include: a.include, exclude: a.exclude })),
    );
  }

  // ---------- SQL ----------

  server.registerTool(
    "get_schema",
    { title: "数据库结构", description: "返回本领域 SQLite 表结构，配合 query_sql 使用。JSON 列可用 json_each 展开。", annotations: READ_ONLY },
    async () => text(store.schema()),
  );
  server.registerTool(
    "query_sql",
    {
      title: "只读 SQL 查询",
      description: "在只读连接上执行 SELECT / WITH 查询，最多返回 500 行。",
      inputSchema: { sql: z.string(), params: z.array(z.union([z.string(), z.number(), z.null()])).optional() },
      annotations: READ_ONLY,
    },
    async ({ sql, params }) => json(store.readonlyQuery(sql, params ?? [])),
  );

  // ---------- 任务 ----------

  server.registerTool(
    "list_tasks",
    { title: "任务模板", description: "列出任务模板（id、名称、说明、作用对象 target、prompt_hash）。", annotations: READ_ONLY },
    async () => json((await tasks.listTasks(domain)).map(({ body, ...x }) => x)),
  );

  server.registerTool(
    "get_task",
    {
      title: "获取任务说明",
      description: "渲染任务模板，返回完整任务说明（原则、上下文、正文获取方式与写回参数）。按说明执行后调用 save_output。",
      inputSchema: {
        task_id: z.string(),
        [t.docParam]: z.string().optional().describe("target 为 document 的任务必填"),
        ...(domain.hasWritings && { writing_id: z.string().optional().describe("target 为 writing 的任务必填") }),
        include_text: z.boolean().optional().describe("内联正文全文"),
      },
      annotations: READ_ONLY,
    },
    async (a) => text((await tasks.renderTask(domain, store, a.task_id, { docId: docIdOf(a), writingId: a.writing_id, includeText: a.include_text, baseUrl })).text),
  );

  // 任务模板同时注册为 MCP prompt
  for (const task of await tasks.listTasks(domain)) {
    const argsSchema = task.target === "document" ? { [t.docParam]: z.string() } : task.target === "writing" ? { writing_id: z.string() } : undefined;
    server.registerPrompt(task.id, { title: task.name, description: task.description, ...(argsSchema && { argsSchema }) }, async (a) => ({
      description: task.name,
      messages: [
        { role: "user", content: { type: "text", text: (await tasks.renderTask(domain, store, task.id, { docId: docIdOf(a), writingId: a?.writing_id, baseUrl })).text } },
      ],
    }));
  }

  // ---------- 导入与解析 ----------

  const parserIds = parsers.PARSERS.map((p) => p.id);
  server.registerTool(
    `import_${t.docTool}`,
    {
      title: `导入${t.doc}`,
      description:
        `把${t.doc}加入库中：arXiv ID / 链接、PDF 或网页 URL` +
        (allowLocalFiles ? "、本机文件路径" : "") +
        "，或 base64 文件内容（content_base64 + filename，支持 .pdf/.html/.txt/.md）。网页抽取正文转为 Markdown；PDF 自动在后台解析为 Markdown。已存在的直接返回。",
      inputSchema: {
        source: z.string().optional(),
        content_base64: z.string().optional(),
        filename: z.string().optional(),
        title: z.string().optional(),
        ...(domain.kinds.length && { kind: z.enum(domain.kinds.map((k) => k.id)).optional() }),
        parser: z.enum([...parserIds, "none"]).optional(),
      },
      annotations: { ...WRITE, idempotentHint: true, openWorldHint: true },
    },
    async (a) => {
      const extra = a.kind ? { kind: a.kind } : {};
      let r;
      if (a.content_base64) {
        if (!a.filename) throw new Error("content_base64 需要 filename");
        r = await importer.importUploaded({ buffer: Buffer.from(a.content_base64, "base64"), name: a.filename, parser: a.parser, extra });
      } else if (a.source) {
        r = await importer.importSource(a.source, { allowLocal: allowLocalFiles, parser: a.parser, extra });
      } else throw new Error("需要 source 或 content_base64");
      if (!r.existed && a.title) r.doc = store.updateDocument(r.doc.id, { title: a.title });
      return json({ existed: r.existed, [t.docParam]: r.doc.id, title: r.doc.title, formats: r.doc.formats, textSource: r.doc.textSource, parse: r.parse ?? null, pdfDownload: r.download ?? null, parseError: r.parseError ?? null });
    },
  );

  server.registerTool(
    `parse_${t.docTool}`,
    {
      title: "解析 PDF",
      description: "用 PaddleOCR-VL / MinerU 重新解析 PDF 为按页 Markdown，完成后替换正文。wait_seconds 内未完成时返回任务状态。",
      inputSchema: { ...docArg, parser: z.enum(parserIds).optional(), wait_seconds: z.number().int().min(0).max(600).optional() },
      annotations: { ...WRITE, openWorldHint: true },
    },
    async (a) => {
      const job = await parsers.enqueueParse(store, need(docIdOf(a)), a.parser);
      return json(a.wait_seconds ? await parsers.waitParse(store, job.id, a.wait_seconds * 1000) : job);
    },
  );
  server.registerTool(
    "get_parse_status",
    { title: "解析状态", description: "列出解析任务与当前正文来源。", inputSchema: docArg, annotations: READ_ONLY },
    async (a) => json({ textSource: store.getDocument(docIdOf(a))?.textSource, jobs: store.listParses(docIdOf(a)) }),
  );
  server.registerTool(
    "list_parsers",
    { title: "可用解析器", description: "列出解析器及其是否已配置。", annotations: READ_ONLY },
    async () => json(parsers.availableParsers()),
  );

  // ---------- 写回 ----------

  server.registerTool(
    "save_output",
    {
      title: "保存 agent 输出",
      description:
        "把分析或反馈写回，在用户界面中展示，并可与其他 agent / 模型的输出对比。不修改用户数据。执行任务模板时原样传入任务说明中的 context_hash 与 prompt_hash" +
        (domain.hasWritings ? "；写作反馈须带 writing_id 与 version_id。" : "。"),
      inputSchema: {
        [t.docParam]: z.string().optional(),
        ...(domain.hasWritings && { writing_id: z.string().optional(), version_id: z.string().optional() }),
        task_id: z.string().optional(),
        title: z.string(),
        content: z.string().describe("Markdown 正文"),
        agent: z.string().describe("agent 名称，如 claude-code / codex / pi / deepseek / open-webui"),
        model: z.string().optional(),
        context_hash: z.string().optional(),
        prompt_hash: z.string().optional(),
        meta: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: WRITE,
    },
    async (a) => {
      const docId = docIdOf(a);
      if (docId) need(docId);
      if (a.writing_id && !store.getWriting(a.writing_id)) throw new Error(`写作不存在：${a.writing_id}`);
      const o = store.addOutput({
        docId, writingId: a.writing_id, versionId: a.version_id, taskId: a.task_id, title: a.title, content: a.content,
        agent: a.agent, model: a.model, contextHash: a.context_hash, promptHash: a.prompt_hash, meta: a.meta,
      });
      return text(`已保存，output_id: ${o.id}`);
    },
  );

  server.registerTool(
    "list_outputs",
    {
      title: "历史输出",
      description: "列出已保存的 agent 输出，用于参考此前的分析或对比不同模型。",
      inputSchema: {
        [t.docParam]: z.string().optional(),
        ...(domain.hasWritings && { writing_id: z.string().optional() }),
        task_id: z.string().optional(),
        include_content: z.boolean().optional(),
      },
      annotations: READ_ONLY,
    },
    async (a) =>
      json(
        store
          .listOutputs({ docId: docIdOf(a), writingId: a.writing_id, taskId: a.task_id })
          .map((o) => (a.include_content ? o : { ...o, content: o.content.slice(0, 200) })),
      ),
  );

  return server;
}

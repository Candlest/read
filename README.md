# read

轻量阅读器，包含两个相互隔离的领域：

| 领域 | 用途 | 输入 | 输出 |
|---|---|---|---|
| 学术（academic） | 读论文 | arXiv、论文 PDF、网页 | 批注、笔记；agent 的分析（理解复核、疑问解答、审稿视角等） |
| 英语（english） | 备考 CET-6 | 英文新闻、六级真题 | 标记的表达、作文与翻译；agent 的批改与对话陪练 |

两个领域使用独立的 SQLite 库、文件目录、标签、档案、任务模板，以及独立的 REST 接口和 MCP 服务，上下文互不可见。

应用本身不调用任何 LLM。人在浏览器中阅读、标记、写作；agent（Claude Code、Codex、pi、DeepSeek harness、Open WebUI 等）通过 MCP、CLI 或 REST 读取这些数据并写回结果。

## 设计

- **Markdown 为主文本**：PDF 由 PaddleOCR-VL 解析为按页 Markdown（公式为 LaTeX、表格与图片保留），网页由 Readability 抽取正文后转为 Markdown。阅读、批注定位、全文检索、agent 读取使用同一份文本。PDF / HTML 原文在右侧对照查看，不在其上批注。
- **人工数据为主体**：批注、笔记、档案、写作与 agent 输出分表存储。agent 只写入输出表（以及代用户保存其本人写下的写作），不修改批注与笔记。
- **可重跑、可对比**：任务模板（`prompts/<domain>/*.md`）与上下文一起交给 agent。每条输出记录 `agent`、`model`、`context_hash`、`prompt_hash`（写作反馈另记 `version_id`），同一份数据可交给新模型重跑并与旧输出对比。
- **英语领域的方法取向**：连接主义与行为主义，即大量高质量输入，在写作和对话的反馈中调整输出。反馈以改写示范和逐句重述为主，不提供语法分析、词汇统计类功能。字数显示仅用于对照六级作文的篇幅要求。

## 复用的项目

| 用途 | 项目 |
|---|---|
| PDF 解析为 Markdown | PaddleOCR-VL 云端 API（默认）；也可接自部署 PaddleOCR-VL 服务或 MinerU V1 API |
| 网页正文抽取 | @mozilla/readability + linkedom |
| HTML → Markdown | turndown |
| Markdown 与公式渲染 | marked、marked-katex-extension、KaTeX、DOMPurify |
| 对照原文 | pdf.js |
| agent 接口 | MCP TypeScript SDK |
| 存储与检索 | Node 内置 `node:sqlite`，FTS5 trigram 索引 |
| 英语词典与考试词表 | ECDICT（skywind3000/ECDICT，MIT，约 77 万条，含四级、六级、考研等词表标签与词形变化） |
| 整句划词翻译（外部） | 浏览器扩展 kiss-translator、陪读蛙 Read Frog 或沉浸式翻译，直接作用于本应用页面 |
| 英语新闻订阅（外部） | FreshRSS / Miniflux，通过“分享”把文章发到本应用 |
| 英语对话（外部） | Open WebUI 等支持 MCP 的对话界面，连接 `/mcp/english` |

## 运行

需要 Node.js ≥ 22.13。

```bash
npm install
cp .env.example .env   # 填写 PADDLEOCR_TOKEN
npm start              # http://localhost:5178
```

左上角切换“学术 / 英语”。

### 学术

- 导入 arXiv ID、arXiv 链接、PDF / 网页 URL，或上传 PDF / HTML / TXT / Markdown。
  - arXiv：立即获取元数据与 arXiv HTML 版（作者 LaTeX 生成，转为 Markdown 后可立即阅读；无 HTML 版时先显示摘要），PDF 在后台下载，完成后自动交给 PaddleOCR 解析并替换正文。提示条显示下载与解析进度。
  - 其他 PDF：先显示 pdf.js 提取文本，后台 PaddleOCR 解析完成后自动替换为 Markdown。
- 在正文中选中文字，用数字键选标签、填写评论后保存。选区可跨公式，公式按 `$LaTeX$` 计入摘录。
- 笔记栏写阅读笔记；“研究背景”档案随阅读记录提供给 agent。

### 英语

- 材料：导入新闻链接（类别选“新闻”）、六级真题 PDF / TXT（类别选“真题”）。选中文字标记想吸收的表达（好表达、句式、观点素材、没读懂、翻译素材）。
- 写作：左侧“写作”中新建作文、翻译或复述，填写题目（翻译填中文原文），每次保存生成一个版本。右侧“反馈”列出 agent 的批改，并标注每条反馈针对第几版。
- 学习档案：目标分数、当前问题等，随学习上下文提供给 agent 与对话模型。
- 词典与词表：左下“词典”中点“下载并导入 ECDICT”（约 66MB，导入约 20 秒），或运行 `npm run dict:import [ecdict.csv]`。导入后：
  - 工具栏选择要标出的词表（默认“六级新增词”，即六级词表中不属于四级的词），正文中这些词加点状下划线。判断按原形进行，complained 视为 complain。
  - 选中 1–4 个词或点击标出的词，弹窗显示音标、释义、原形与所属词表，可直接标为“生词”。任意选区提供 DeepL / Google 翻译链接。
  - 可导入自定义词表（每行一个词），例如其他来源的六级词书。
  - ECDICT 的词表标签来自常见考试词书，与考试中心公布的考纲词表是否一致未核验。
- 整句翻译：安装 kiss-translator 等浏览器扩展即可在阅读页划词翻译。扩展的翻译按钮与本应用的批注弹窗同时出现时的交互未验证。
- FreshRSS 分享：在 FreshRSS 中添加自定义分享方式，URL 为 `http://localhost:5178/?d=english&import=~LINK~`，阅读时点分享即导入为新闻材料。

## 接口

### REST

| 前缀 | 说明 |
|---|---|
| `GET /api/info` | 全局信息与领域列表 |
| `/api/academic/…` | 学术：documents、annotations、notes、tags、profile、context（文库阅读记录）、tasks、outputs、parsers、search、sql |
| `/api/english/…` | 英语：以上全部，另有 `writings`（写作、版本）；`context` 为学习上下文 |

主要路径（两个领域相同的部分）：

```
GET/POST   /documents, /documents/import, /documents/upload
GET        /documents/:id/markdown | /text | /context | /source.pdf | /source.html | /parsed/:parser/*
GET/POST   /documents/:id/annotations, PATCH/DELETE /documents/:id/annotations/:annId
GET/PUT    /documents/:id/notes, /profile, /tags
GET        /context, /search?q=, /annotations?tag=, /schema;  POST /sql
GET        /tasks, /tasks/:taskId/render?doc_id=&writing_id=&include_text=1
GET/POST   /outputs, DELETE /outputs/:id
POST       /documents/:id/parse, GET /documents/:id/parses, /parsers
```

英语领域额外：

```
GET        /dict/status, /dict/lookup?w=
POST       /dict/import-ecdict, /dict/mark  {words, include, exclude}
PUT/DELETE /dict/lists/:name               （PUT 正文为文本词表）
GET/POST   /writings
GET/PATCH/DELETE /writings/:wid
POST       /writings/:wid/versions
GET        /writings/:wid/context
```

### MCP

| 服务 | stdio | HTTP |
|---|---|---|
| `read-academic` | `node mcp-stdio.js academic` | `/mcp/academic` |
| `read-english` | `node mcp-stdio.js english` | `/mcp/english` |

| 类别 | read-academic | read-english |
|---|---|---|
| 列表 / 正文 | `list_papers` `get_paper_text` `get_paper_file` | `list_materials` `get_material_text` `get_material_file` |
| 单篇上下文 | `get_reading_context` | `get_material_context` |
| 领域上下文 | `get_library_context`（文库阅读记录） | `get_learning_context`（档案、近期标记、近期写作与反馈） |
| 批注 | `search_annotations` | `search_highlights` |
| 词典 | — | `lookup_word` `filter_wordlist` |
| 写作 | — | `list_writings` `get_writing` `save_writing` |
| 导入 / 解析 | `import_paper` `parse_paper` | `import_material` `parse_material` |
| 共有 | `search_text` `list_tags` `get_schema` `query_sql` `list_tasks` `get_task` `get_parse_status` `list_parsers` `save_output` `list_outputs` | 同左 |

任务模板同时注册为 MCP prompt：学术为 `understanding-check`、`answer-questions`、`reading-card`、`critique`、`connect-library`；英语为 `essay-feedback`、`translation-feedback`、`retell`、`conversation`。

接入示例：

```bash
claude mcp add read-academic -- node /绝对路径/read/mcp-stdio.js academic
claude mcp add read-english  -- node /绝对路径/read/mcp-stdio.js english
claude mcp add --transport http read-english https://<host>/mcp/english --header "Authorization: Bearer <READ_TOKEN>"
```

```toml
# Codex：~/.codex/config.toml
[mcp_servers.read-english]
command = "node"
args = ["/绝对路径/read/mcp-stdio.js", "english"]
```

各领域的配置片段在界面右侧“连接 agent”中列出。

### CLI

```bash
npm link    # 安装 read-academic、read-english 命令；或使用 node bin/read.js <academic|english>
read-academic docs
read-academic task critique --doc <paper_id> > task.md
read-english domain-context
read-english write --kind essay --title "..." --prompt "..." --file essay.txt
read-english task essay-feedback --writing <writing_id>
read-english save --writing <id> --version <id> --task essay-feedback --title 作文批改 --agent pi --model <模型> --file out.md
# 远程：READ_URL=https://<host> READ_TOKEN=<token> read-english writings
```

### Skill

`skills/read-academic/SKILL.md` 与 `skills/read-english/SKILL.md` 分别说明两个领域的访问方式、原则与流程。复制到对应 agent 的 skills 目录即可，例如 Claude Code 为 `~/.claude/skills/`。

### 不使用 agent

右侧“复制任务说明”得到完整提示词（可勾选内联正文），粘贴给任意对话式 LLM；结果用“粘贴结果”保存。

## 解析器

| 解析器 | 条件 | 环境变量 |
|---|---|---|
| `paddleocr-cloud` | PaddleOCR 云端异步任务 API（默认） | `PADDLEOCR_TOKEN`；可选 `PADDLEOCR_JOB_URL`、`PADDLEOCR_MODEL`（默认 PaddleOCR-VL-1.6） |
| `paddleocr-api` | 自部署 PaddleOCR-VL 服务（`/layout-parsing`） | `PADDLEOCR_API_URL`、`PADDLEOCR_API_KEY` |
| `mineru-api` | MinerU V1 API | `MINERU_API_URL`、`MINERU_API_KEY`、`MINERU_TIER` |

导入 PDF 时自动使用第一个已配置的解析器；`READ_AUTO_PARSER` 可指定，设为 `none` 关闭。云端返回的图片带过期签名，解析时下载到本地。PaddleOCR 输出的公式定界符（`$ x $`、` $$ x $$ `）入库前统一为 `$x$` 与独立成行的 `$$` 块。

## 部署

```bash
READ_TOKEN=$(openssl rand -hex 24) READ_PUBLIC_URL=https://read.example.com docker compose up -d
```

| 变量 | 说明 |
|---|---|
| `READ_TOKEN` | 访问令牌，作用于 REST 与 MCP。监听非本机地址时必须设置（或显式设置 `READ_ALLOW_NO_AUTH=1`） |
| `HOST` / `PORT` | 默认 `127.0.0.1:5178`；仅监听本机时校验 Host 头 |
| `READ_PUBLIC_URL` | 对外地址，用于生成 agent 配置与文件链接 |
| `READ_DATA_DIR` | 数据目录，默认 `./data` |
| `READ_CORS_ORIGINS` | 前后端分离部署时允许的前端来源 |
| `ARXIV_BASE` | arXiv 访问地址，默认 `https://export.arxiv.org`（arXiv 官方面向程序访问的域名）；可换成可用的代理地址 |
| `ARXIV_PDF_TIMEOUT_MS` | 后台下载 arXiv PDF 的超时，默认 30 分钟 |

国内服务器实测（阿里云广州，2026-10-07）：export.arxiv.org 的元数据与 HTML 1–2 秒返回；PDF 下载约 14–22 KB/s，2–4MB 的论文需 2–4 分钟；xxx.itp.ac.cn 镜像无法连接。

配置写在 `.env`（已被 git 与 Docker 忽略）。前后端分离时把 `public/` 部署到静态托管，修改 `public/config.js` 的 `apiBase`。

## 数据

```
data/
  academic/read.db, academic/files/<id>/
  english/read.db,  english/files/<id>/
  english/ecdict.db                词典与词表（独立于学习数据）
    source.pdf | source.html     原始文件（HTML 已清除脚本）
    parsed/<parser>/paper.md     解析产物与图片
```

每个库的表：`documents`、`chunks`（+ FTS5）、`annotations`、`notes`、`tags`、`profile`、`writings`、`writing_versions`、`parses`、`outputs`。表结构可通过 `get_schema` 或 `read-<domain> schema` 查看。备份 `data/` 即可完整迁移。

## 任务模板

`prompts/academic/*.md`、`prompts/english/*.md`。frontmatter 字段：

| 字段 | 取值 |
|---|---|
| `name` / `description` | 显示名称与说明 |
| `target` | `document`（默认）/ `writing` / `none`，决定任务需要的参数 |
| `context` | `domain` 时附带领域级上下文（学术为文库阅读记录，英语为学习上下文） |

修改模板后 `prompt_hash` 随之变化。文件名前缀数字仅用于排序。

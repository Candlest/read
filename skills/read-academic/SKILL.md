---
name: read-academic
description: 访问用户的论文阅读文库（手工批注、标签、笔记）并执行阅读任务。用户提到读过的论文、批注、阅读笔记、文献对比，或要求导入 arXiv / PDF 论文、解析 PDF 公式与表格、复核理解、解答阅读疑问时使用。
---

# 论文阅读文库（学术领域）

用户在 Web 界面中阅读论文的 Markdown 版本（PDF 经 PaddleOCR-VL 解析，公式为 LaTeX），手工打标签、写评论和笔记。批注摘录中的公式以 `$LaTeX$` 形式保存。本 skill 说明 agent 如何读取这些数据、导入与解析论文、执行阅读任务并写回结果。

## 访问方式

两种方式访问同一份数据，按当前环境选择其一：

- **MCP**：已配置 `read-academic` MCP 服务（stdio：`node mcp-stdio.js academic`；HTTP：`/mcp/academic`）时，直接使用其工具（`list_papers`、`get_reading_context` 等）。
- **CLI**：有 shell 时使用 `read-academic`（未全局安装时为 `node <项目目录>/bin/read.js academic`）。远程服务需设置 `READ_URL` 与 `READ_TOKEN`。运行 `read-academic help` 查看全部命令。

| 操作 | MCP 工具 | CLI |
|---|---|---|
| 列出论文 | `list_papers` | `read-academic docs` |
| 用户阅读记录 | `get_reading_context` | `read-academic context <id>` |
| 正文（分页） | `get_paper_text` | `read-academic text <id> [--from N --to M]` |
| 全文检索 | `search_text` | `read-academic search "<查询>"` |
| 跨论文批注 | `search_annotations` | `read-academic annotations --tag question` |
| 只读 SQL | `query_sql` / `get_schema` | `read-academic sql "SELECT ..."` |
| 导入 | `import_paper` | `read-academic import <arXiv ID / URL / 路径>` |
| 解析 PDF | `parse_paper` | `read-academic parse <id> --wait 600` |
| 任务说明 | `get_task` / MCP prompts | `read-academic task <task_id> --doc <id>` |
| 写回结果 | `save_output` | `read-academic save ... --file out.md` |

## 原则

1. 用户的批注与笔记是阅读主体。agent 输出用于检验、补充、延伸用户的理解，不修改用户的批注与笔记（工具层面也不提供修改接口）。
2. 论断以原文为依据，注明页码或章节；原文找不到依据时写“原文未提及”。
3. 区分原文内容、用户理解、agent 推断，推断部分须标明。
4. 无法确认的原因或结论写“原因未查明”或“结论待定”。

## 流程

### 执行阅读任务

1. `list_tasks` 查看模板（理解复核、疑问解答、阅读卡片、审稿视角、文库关联等）。
2. `get_task(task_id, paper_id)` 取得完整任务说明，其中已包含用户阅读记录、原文获取方式和写回参数。
3. 按说明读取原文：默认使用 `get_paper_text`（Markdown，与用户阅读的文本一致，页码一致）。需要查看图表原貌时，用 `get_paper_file` 取得原始 PDF 或解析产物中的图片路径。`get_reading_context` 中的“正文来源”为 pdfjs 时，文本尚未经过解析，公式与表格结构不完整。
4. 完成后写回，原样传入任务说明中的 `context_hash` 与 `prompt_hash`，并如实填写 `agent` 与 `model`。

### 导入论文

用户要求“找几篇关于 X 的论文加入文库”时：先用可用的检索工具（如 arxiv-mcp-server、网页搜索）确定论文，再调用 `import_paper`。本地文件或缺少元数据的 PDF 需同时填写 `title`。

### 解析 PDF

PDF 导入后自动提交解析（默认 PaddleOCR 云端 API），用 `get_parse_status` 查看进度。需要重新解析或更换解析器时调用 `parse_paper`；`list_parsers` 查看已配置的解析器。

### 自由分析

不对应任务模板的分析也可写回：`save_output` 不填 `task_id`；跨论文的输出不填 `paper_id`。

### 范围

本 skill 只处理学术论文。英语学习（CET-6）数据在独立的 `read-english` 服务中，两者的数据与上下文互不可见。

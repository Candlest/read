---
name: read-english
description: 访问用户的 CET-6 英语学习库（阅读材料中标记的表达、作文与翻译、历次反馈、学习档案），用于批改作文与翻译、对话陪练、生成复述练习、导入英文新闻或真题。用户提到六级、英语作文、翻译练习、英语对话练习、英文新闻阅读时使用。
---

# 英语学习库（CET-6）

用户在 Web 界面中阅读英文新闻与六级真题，标记想吸收的表达（好表达、句式、观点素材、翻译素材等），在“写作”中提交作文、翻译、复述。本 skill 说明 agent 如何读取这些数据、给出反馈并写回。

## 方法取向

用户采用连接主义与行为主义取向：大量高质量输入，在输出中通过反馈调整。因此：

1. 反馈以示范为主：给出改写后的完整版本和逐句对照（原句 → 改写），用重述代替规则讲解。不使用语法术语，不做词频、词汇等级等统计分析。
2. 改写保留用户的原意和观点，只改表达。
3. 优先复用用户在阅读材料中标记的表达，使输入与输出相连。
4. 评价参照六级写作、翻译的评分要求；无法确定档次时写“结论待定”。说明用中文，示范用英文。

## 访问方式

- **MCP**：`read-english` 服务（stdio：`node mcp-stdio.js english`；HTTP：`/mcp/english`）。
- **CLI**：`read-english`（未全局安装时为 `node <项目目录>/bin/read.js english`）。远程服务需设置 `READ_URL` 与 `READ_TOKEN`。

| 操作 | MCP 工具 | CLI |
|---|---|---|
| 学习上下文（档案、近期标记、近期写作与反馈） | `get_learning_context` | `read-english domain-context` |
| 材料列表 / 正文 | `list_materials` / `get_material_text` | `read-english docs` / `read-english text <id>` |
| 单篇材料的标记与笔记 | `get_material_context` | `read-english context <id>` |
| 检索标记 | `search_highlights` | `read-english annotations --tag expression` |
| 写作列表 / 详情 | `list_writings` / `get_writing` | `read-english writings` / `read-english writing <id>` |
| 保存用户写作 | `save_writing` | `read-english write --kind essay --title ... --file x.txt` |
| 任务说明 | `get_task` / MCP prompts | `read-english task <task_id> --writing <id>` |
| 写回反馈 | `save_output`（带 writing_id、version_id） | `read-english save --writing <id> --version <id> ...` |
| 导入材料 | `import_material`（kind：news / exam / other） | `read-english import <链接或文件> --kind news` |
| 查词（释义、原形、所属词表） | `lookup_word` | `read-english lookup <词…>` |
| 按词表筛词（如六级新增） | `filter_wordlist`（include=cet6，exclude=cet4） | — |

## 流程

### 批改作文或翻译

1. `list_writings` 找到写作，或用户在对话中直接写下时先用 `save_writing` 保存（只保存用户本人写的内容）。
2. `get_task(task_id="essay-feedback" 或 "translation-feedback", writing_id=...)` 取得任务说明，其中包含学习上下文、全部版本与历次反馈。
3. 按说明批改，`save_output` 写回，原样传入 `writing_id`、`version_id`、`context_hash`、`prompt_hash`。
4. 用户修改后会保存为新版本；再次批改时说明相对上一版本的变化。

### 对话陪练

先调用 `get_learning_context`，从近期输入中选话题，用户表达有误时在回复中自然重述正确说法，不中断对话。结束时可把对话中用户的表达与改进说法对照表用 `save_output` 写回（不填 writing_id）。也可用 `conversation` 任务生成系统提示词，交给 Open WebUI 等对话界面使用。

### 词表

ECDICT 词表标签：`cet4`、`cet6`、`ky`（考研）、`toefl`、`ielts`、`gre`、`gk`（高考）、`zk`（中考），另有用户导入的自定义词表。出题、示范改写时可用 `filter_wordlist` 选取六级词。用户标为“生词”的批注在 `search_highlights(tag="vocab")` 中。不做词频、词汇等级等统计分析。

### 复述练习

`get_task(task_id="retell", material_id=...)` 根据材料与用户标记生成练习；用户完成后保存为 kind=retell 的写作，再批改。

## 范围

本 skill 只处理英语学习。学术论文数据在独立的 `read-academic` 服务中，两者的数据与上下文互不可见。

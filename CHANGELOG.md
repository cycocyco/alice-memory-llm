# 更新日志

本仓库是 [alice-memory](https://github.com/cycocyco/alice-memory) 的 **LLM 提炼支线**，从主线 v3.0.0 派生，但**版本号独立**——从 `1.0.0` 起算，不再跟主线的数字对齐。

主线继续走「逐条规则捕获、零模型调用」；本仓库把「什么值得记」交给主对话模型，代价是每次提炼一次模型调用。

## 1.0.0 — 2026-11-10

首个支线版本。数据格式与主线 v3.0.0 兼容，共用同一个数据目录。

### 变了：capture 从「逐条规则闸门」改成「粗筛 + LLM 批量提炼」

规则只能拦形式，拦不住内容——随口闲聊、追问、纯问句照样满足所有形式条件被写进库。这一版把裁决权交给 LLM：

- **粗筛降级**：原有规则（撤销命令、斜杠命令、纯应答词、纯标点/emoji、自产文本、< 3 字、全局开关）保留，职责从「是否入库」改成「是否进入待提炼池」；`min_prose = 25` 这类长度闸门移除，避免误伤。
- **只存条目**：内存池 `pendingTurns` 装原文，`turn/end` 标记轮次完成；静默满 `idleMs`（默认 5 分钟）触发唯一一次 flush，LLM 输出一句话条目数组，只把条目写进 SQLite，`user_text` / `assistant_text` 留空。池内原文不落盘、崩溃即丢、不补提。
- **复用主模型**：`capture.model = "inherit"` 时从 `agent/pre-step` 的 `modelSelection` 拿 provider/model，从 `$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers` 拿 `baseURL` 和 `apiKeyEnv`，凭证走 env / `.env` / `.credentials.yaml refs`，不需要第三把 key。每次 flush 重新解析，换模型、改网关都立即生效。独立 HTTP 请求，不复用主对话 session，也不与主对话排队。
- **单事务**：插入本批全部条目 + 推进 `lastProcessedTurnId` + 记一次提炼，全成功才提交。LLM 报错、超时、JSON 解析失败、DB 报错一律回滚，游标不动，下次空闲自动重提。空数组是合法输出，仍推进游标并报 `count=0`。
- **白盒化**：不做任何语义相似度去重，只保留 `content` 的 sha256 完全一致跳过；重复、过时、错误由用户用现有删除工具自行清理。

### 配置

`capture` 换成 `{ enabled, idleMs: 300000, model: "inherit", maxDailyExtractions: 50 }`。

原 `daily_cap = 150`（每日条数）改为每日 LLM 提炼次数上限，计数存 `meta` 表（`extract_count:YYYY-MM-DD`），重启不清零。**失败也算一次**：LLM 报错、超时、JSON 解析失败都会烧掉一个额度，否则解析一直失败就会每 5 分钟重试到天亮，把上限睡成摆设。

`embed_retry_minutes` 保留给补向量定时器。

### 数据与兼容

- 启动时幂等加两列 `memory_type` / `extract_meta`，旧库不用迁移；已用真实库副本验过加列前后行数、FTS 行数不变。
- 数据目录沿用主线的 `$DSH_HOME/alice-memory`，两条线可以来回切换而不丢记忆。
- WAL + `busy_timeout = 5000` 沿用 `store.mjs` 的初始化。
- 手动通道 `alice_memory_save` 完全不变，绕过粗筛直接写、pinned + importance 1.5。
- `memory-capture:start` / `:success`（带 `count`）/ `:failed` 三个事件已预留，UI 本版不实现；失败静默重试。

### 修掉一个只有上真机才暴露的坑：宿主劫持了 `globalThis.fetch`

后端第一次跑真实提炼时，日志里每 5 分钟一条 `extraction failed: extractor returned no content`，游标一直不动。根因不在 prompt 也不在模型：DSH 后端在 `@deepseek-ai/dsh-llm` 里执行了 `globalThis.fetch = carrierFetch`，全局 fetch 被换成宿主自己的实现，响应形状和标准 fetch 不一致，于是请求拿到 200 但解析不出 `choices[0].message.content`。

同一个网关、同样的 payload，在插件进程外手搓 15 次全部成功——差别只在那个被替换的 `globalThis.fetch`。

修法：新增 `lib/http.mjs`，提炼与 embedding 都改走 `node:http` / `node:https` 原生 socket，完全绕开宿主的 fetch。顺手把 `max_tokens` 从 512 提到 2048（给推理型模型留 reasoning 余量），并在 `content` 为空时回退读 `reasoning_content`，报错信息带上 `finish_reason` 和 `completion_tokens`。

验证方式很直接：把 `globalThis.fetch` 换成「一调就抛」的假实现，提炼、补向量、召回三段全部正常。

### 提炼 prompt 收紧过一次

第一版 prompt 上线后实测：4 条里 3 条是助手自己的操作汇报（「已清理死代码」「当前流水线顺序是…」）。改法是禁止清单加三条——助手的操作汇报与进度说明、助手的技术解释与方案对比、只对本次任务有效的中间结论；任务段收窄成只认三类来源（用户偏好 / 用户交代的长期事实 / 双方拍板或用户纠错）。同一批对话对照：旧 prompt 出 4 条噪声，新 prompt 出 1 条精准条目。

### 注意

- 改动要重启 DSH 后端才生效（插件是后端 cordis 插件，没有热重载）。
- 全局单池按规格不带 sessionId 字段，多会话并发时同一 `turnId` 可能混入不同会话的消息。
- 重启会丢弃池内尚未提炼的原文，不接受补提。

## 上游历史

本仓库从主线 v3.0.0 派生，之前的版本历史看 [alice-memory 的 CHANGELOG](https://github.com/cycocyco/alice-memory/blob/main/CHANGELOG.md)：

- **3.0.0** — 一个数据目录只有一个库文件，自动并掉 v2 的双库布局
- **2.0.0** — 首个发布，零第三方依赖
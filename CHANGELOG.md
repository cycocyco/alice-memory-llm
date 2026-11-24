# 更新日志

## 1.5.5 — 2026-11-24

### 修了：超时是空闲超时，不是总时限

`req.setTimeout()` 只在 socket **空闲**时触发。对端如果一直慢速滴数据，它就永远不触发——配置写的是 3 次 × 15s = 48 秒封顶，实测却跑出 61 秒。现在换成独立计时器兜死：DNS + 建连 + 握手 + 读 body 全部算在同一个截止时间里，到点直接掐断。

实测本地造两种极端服务：对端完全不响应、对端每 300ms 滴一个字节（永不空闲），两者都在设定时间准时切断，不再无限拖。

### 新增：域名解析结果缓存（10 分钟）

每次请求都是新连接（`agent: false`，为了躲开跨境僵连接），不缓存就等于每次重付一次解析成本。跨境链路上 `sslip.io` 这类通配符域名解析可能要好几秒，三次重试就是三次。

- 连解析出的 IP，按原域名补回 `Host` 头与 TLS `servername`，证书校验照常
- 优先取 IPv4：双栈环境解析器常先给 `::1`，而服务多半只监听 IPv4，直连会 `ECONNREFUSED`
- 连接层失败时清掉该域名的缓存，下次重新解析

## 1.5.4 — 2026-11-24

### 新增：AI 请求串行闸门（`lib/ai-lock.mjs`）

向量与提炼共用一把进程内锁，同一时刻只放一个请求出去。自建端点上两个模型同时驻留、机器又只有两个核时，并发只会让两边各分到半台 CPU——单次更慢、更容易超时。串行之后每个请求吃满核心，总量不变。

### 变了：embedding 重试更耐抖动

自建推理服务偶发连接重置很正常，而请求本身很便宜（实测单条 0.2~0.5s）。放弃了就得等 5 分钟后的 backfill，期间这条记忆只剩词法召回。

- 尝试次数 2 → **4**（`embedding.retry_attempts` 可配）
- 线性退避 + 抖动：800/1600/2400ms 起算，加 0~300ms 随机，避免多个失败请求同时重扑
- 只有 `408/425/429/5xx` 才重试；鉴权错、参数错、维度不符直接认输

### 新增：置顶可以解除（`store.setPinned` / `ops.setPinnedMany`）

置顶的语义是「不衰减、不参与容量竞争」。以前只能设、不能撤，于是置顶比例只涨不跌——实测到一个库 51% 都置顶，warm 层被挤得失去意义。现在可以批量解除，内容与向量都不动。

### 提示：批量大小受单次耗时约束

`embedding.batch` 越大，单次请求越久，越容易撞超时。实测 4 条真实正文约 6 秒，所以 `timeout_ms` 要按批大小给余量，不能只看单条延迟。

## 1.5.2 — 2026-11-24

### 修了：换 embedding 模型后向量静默失效

模型换了、维度恰好还是 1024 时，旧向量会被当成合格数据参与相似度计算——两个不同向量空间算出来的余弦全是噪声，而这个「不匹配」用维度根本发现不了。表现是召回悄悄退化成纯关键词，日志里一句提示都没有。

- `vectorsFor` / `allVectors` 只认当前 `model` + `dimensions` 的向量。
- 启动时检测到别的模型建的向量，把这些记忆打回 `pending` 并排队用当前模型重嵌（向量按 `memory_id` 覆盖，不留垃圾）。

### 修了：原生 HTTP 请求不带 content-length，慢 50 倍

`req.write(body)` 不给长度时 Node 自动走 chunked，对方网关对分块上传的处理极慢：同一个 embedding 接口实测 **chunked 9.9s / 带长度 0.2s**。慢到必然撞上 embedding 的 3.5s 超时，表现为「向量永远生成不出来」。

现在显式写入 `content-length`；同时禁用连接复用（`agent: false` + `connection: close`）——跨境 TLS 链路上踩到被对端静默丢弃的 keep-alive socket，会等几十秒后报 ECONNRESET。

提炼请求走同一个 transport，同样受益。

## 1.5.1 — 2026-11-24

### 变了：提炼提示词瘦身，输出更短

提示词从「八条禁止清单 + 分点任务说明 + 带 confidence/source_turn_ids 的格式示例」压成一句约束加四类来源，输出格式只要求 `{"items":[{"content","type"}]}`——`confidence` 与 `source_turn_ids` 只写入元数据、不参与任何判断，不必让模型生造。实测同一段对话：prompt 从 394 token 降到 298，输出从 3 条重复降到 3 条不重复、48 token。

慢机器上 prefill 是硬开销，这 100 token 换来的是每次提炼少等几秒。

### 新增：`capture.max_tokens`

提炼输出上限可配置，`0` 用内置默认 2048。CPU 推理或慢网关可压到 512，既省等待也防跑飞。

### 新增：`capture.max_turns_per_extract`

每批最多送几轮，`0` 不限制。池里攒了几十轮时 prefill 会线性膨胀，慢机器上设 4~8 可以把单次提炼压在可控时间内，多余的轮次留到下次空闲继续（游标只推进到本批最后一轮）。

### 变了：只提炼含用户发言的轮次

用户那句已被初筛拦掉、只剩助手独白时，这条轮次不再进提示词——没有可提炼的源头，白烧 token。整批都是独白时直接跳过调用，游标照常推进。

## 1.5.0 — 2026-11-24

### 变了：冷热分层改成自适应分位

以前按绝对容量切层（`hot_max: 3000`）——库里没到 3000 条时，所有记忆都是 `hot`，分层等于没有信息量；一旦真到几千条，又会让「1000 条里谁是热的」由硬编码数字决定，而不是由实际分布决定。

现在按**热度名次的分位点**切：top 20% = `hot`，接下来 30% = `warm`，其余 `cold`。100 条有 100 条的冷热，十万条有十万条的冷热，阈值随规模自己缩放（`memory.hot_ratio` / `memory.warm_ratio`）。另留一道绝对地板：热度跌破 `memory.warm_out` 的条目不管名次一律 `cold`。

### 变了：索引容量与分层解耦

这是这次改动的关键。原来向量索引只装 `tier IN ('hot','warm')` 的行——分层一改就顺手把记忆踢出召回范围。现在分成两件事：

- **分层**是语义标签（新鲜度 / 重要度），只影响展示与整理。
- **索引容量**是性能旋钮（`memory.index_capacity`），按热度取前 N 条进索引，与层无关。

于是小库的所有记忆都在索引里，分层再细也不会降低召回率。

### 新增：热度与置顶参与排序微调

RRF 融合之后，按 `effectiveHeat` 和 `pinned` 给分数乘一个克制的系数（最大 1.5% / 2%）。RRF 相邻名次的分差约 1.6%，所以这档力度只在相关性打平时才起作用，不会把不相关的记忆顶上来。

### 新增：召回主题去重（MMR）

入库允许同话题存多条，但召回坑位有限时容易被同一件事的几种说法占满。现在按分数遍历候选，与已选条目余弦超过 `search.mmr_threshold`（默认 0.85）的先跳过，凑不满再回填。

### 修了：中文查询的分词与问句词

- `queryTerms` 对长度 ≥ 4 的中文片段按常见虚词/助词再切一刀，抬高没有向量时的纯关键词兜底命中率（实测 R@1 从 7/40 提到 14/40）。
- 过滤问句脚手架词（「是什么」「怎么」「如何」「请问」等）。此前一条正文里恰好含「是什么」的记忆会被无关查询当命中捞出来——不是词频问题，是问句的语法词被当成了检索证据。

### 新增：提炼可直连独立端点

`capture.base_url` + `capture.api_key` 配好就走自己的端点，不再读宿主 `settings.yaml` 和主对话模型。适配自建/云端推理服务。

### 变了：提炼超时 30s → 2min

CPU 推理的自建端点常常 15~20s 才出一条，30s 太紧，超时就静默丢掉一轮提炼。

## 1.4.0 — 2026-11-13

### 新增：整理记忆库的能力

与主线 `alice-memory` v3.1.0 同一套实现（`lib/ops.mjs`、`lib/tidy.mjs`、`lib/store.mjs` 逐字节一致），只是捕捉入口不同。摘要如下，细节见 [TIDY.md](TIDY.md)。

- **`alice_memory_tidy` 工具**：`scan` 出候选 / `list` 翻条目 / `delete` 按 id 批删 / `merge` 合并。默认只出 diff，`apply=true` 才落地。
- **`lib/tidy.mjs`**：代码裁剪候选，模型裁决语义。重复检测走现成向量，余弦相似度 ≥ 0.78 连成簇；空壳只认确定性高的形态（手记、pinned、高重要度一律不碰）。
- **增量窗口**：锚点存 `meta.tidy_anchor_at`，整理完自动推进，下次只看新增。
- **CLI**：`list` / `tidy` / `merge` / `tidy-anchor`，`forget` 支持 `--ids`。

### 变了：`forget --query` 不再命中即删

关键词模糊匹配，命中即删在整理时最容易带走该留的那条。现在默认只返回命中清单，带 `confirm` 才真删；按 `id` / `ids` 删除不受影响。

### 关于定时整理

插件不做定时。要不要定期整理、报告投递到哪，都是使用者自己的事；`TIDY.md` 末尾有一份可直接喂给 agent 的任务说明。

本仓库是 [alice-memory](https://github.com/cycocyco/alice-memory) 的 **LLM 提炼支线**，从主线 v3.0.0 派生，但**版本号独立**——从 `1.0.0` 起算，不再跟主线的数字对齐。

主线继续走「逐条规则捕获、零模型调用」；本仓库把「什么值得记」交给主对话模型，代价是每次提炼一次模型调用。

## 1.3.0 — 2026-11-12

### 删了：提炼指示器

用下来的结论是它几乎没有被看见过——触发都发生在空闲期，盯着屏幕的人等不到它转。整个客户端半边下线：

- 删除 `client.js`（浏览器侧 DOM 指示器）与 `lib/status.mjs`（SSE 路由 `GET /alice-memory-llm/status`），`package.json` 相应去掉 `./client` 导出、`files` 条目和 `dsh.client` 声明。
- `index.mjs` 摘掉 webServer 路由注册与 `onEvent` 接线；`createCapturePool` 移除可选 `onEvent` 参数。
- 保留 Cordis 事件 `memory-capture:start / :success / :failed`（宿主侧仍可自行订阅，测试也靠它验收）。

提炼行为本身零变化。测试 53 项全绿（撤掉指示器相关 9 项）。

## 1.2.0 — 2026-11-11

### 变了：提炼成本瘦身——入池截断 + 判重搬家

实测提炼一次 ~2.2k token，大头是原文块。这一版三刀：

- **入池截断 `capture.max_turn_chars`**：默认 user 500 / assistant 200 字，超出部分压缩空白后补 `…`。数字配置 = 两个角色同一上限。提炼目标本来就在用户侧，助手长回复与贴进来的长日志尾部全是噪音。
- **参考块整个删除**：提炼提示词不再携带库内记忆 top-5 命中，提示词成本从此不随记忆库变大而增长；「与已有记忆是否重复」改由入库前的向量判重裁决，提示词里不再要求模型自查。
- **入库前向量判重闸 `lib/dedup.mjs`（`capture.dedup`）**：top1 相似度 ≥ `near_dup`（0.9）判近重复跳过；相似度 ≥ `similar_floor`（0.75）的条数 > `similar_max`（3）判同话题已记满，不再进；同批内换说法的重复只留第一条。embedding 不可用或失败整道闸放行（fail-open）——判重是省钱优化，不能反过来变成丢记忆。被拦条目游标照常推进，不会反复重提；`commitExtraction` 里的 sha256 完全一致去重保留作最后防线。

省账：单次提炼从 ~2.2k 降到 ~0.7-1.1k token，且不再随库增长；代价是每次 flush 多一次批量 embedding（≤ 条目数，远小于省下的模型调用）。

### 变了：默认空闲触发 5 → 10 分钟

`capture.idleMs` 默认 `600000`。切窗口查资料、接个电话这类短中断不再单独烧一次提炼，攒更多轮一次性解决；想更快触发把 `idleMs` 调回去即可。

测试 62 项全绿（新增判重闸单测 6 项、端到端 2 项、截断 2 项）。

## 1.1.0 — 2026-11-10

### 新增：提炼指示器（客户端半边）

1.0.0 留了 `memory-capture:start / :success / :failed` 三个事件却没给 UI。这一版把它们接成了一个小指示器：

- `lib/status.mjs`：进程内状态广播 + `GET /alice-memory-llm/status`（SSE，只认 loopback）。连上来先发当前快照；正在 `working` 的那一帧超过 5 分钟主动作废，避免宿主崩溃留下永久转圈；`success` / `failed` 广播 6 秒后自动落回 `idle`，晚打开的页面不会再看见一轮绿圈。
- `client.js`：客户端插件（`dsh.client.platform = web`），注册到 `conversation.session.header.utilities` 插槽，再把 DOM portal 进 View 标签行，排在「更多视图」后面——就是会话头部那片空白。
- 表现：提炼中 = 转圈 + 「记忆生成中...」；成功 = 圈变绿、字消失、停 1 秒渐隐；失败 = 不变绿、不报错、不通知，直接渐隐；平时不渲染任何节点。
- 没有 `webServer` 的载体（桌面版）自动跳过这条路由，其余行为不变。

### 变了：pool 多一个 `onEvent`

`createCapturePool` 新增可选 `onEvent(kind, payload)`，与原有 `ctx.emit` 并行触发，让 UI 状态不必依赖 Cordis 事件名注册。原有调用方不受影响。

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
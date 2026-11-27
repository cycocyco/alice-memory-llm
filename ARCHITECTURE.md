# 架构与实现细节

本文档记录 `alice-memory-llm` 的底层运行机制、存储结构、模型解析链路与开发测试规范。快速上手与常用配置请见 [README.md](./README.md)。

---

## 一、提炼管线与设计决策

```
消息进入
  → 粗筛（撤销命令 / 斜杠命令 / 纯应答词 / 纯标点 emoji / 自产文本 / 过短输入）
  → 通过则进内存池 pendingTurns（带轮次号，不落盘）
        ↓
  一轮对话结束 → 起闲置计时（每条新消息都会重置）
        ↓
  静默满 idleMs → 取 turnId > lastProcessedTurnId 的已完成轮次（原文按角色截断入池）
        ↓
  LLM 提炼（独立请求，固定规则前置吃满缓存，只输出结构化条目）
        ↓
  向量判重与三态分流（NOOP 丢弃 / REPLACE 软覆盖旧条 / ADD 放行）
        ↓
  SQLite 单事务：写条目 + 软覆盖标记 + 推进游标 + 记一次提炼（全成功才提交）
        ↓
  发状态事件 memory-capture:start / :success / :failed（Cordis 事件，仅供宿主侧订阅）
```

几个刻意的设计决定：

- **只处理已完成的轮次。** assistant 还在生成时到点触发，不会截断，那一轮留到下次。
- **失败静默重试，游标不动。** 断网、超时、JSON 解析失败、DB 报错，一律回滚，下次空闲自动重提。失败也计一次额度，否则解析一直失败就会每 10 分钟重试到天亮。
- **空数组是合法输出。** 没值得记的就 `[]`，照样推进游标、照样报 `count=0`，不硬凑。
- **只存条目，不存原文。** 池里的原文不落盘，进程一崩就丢，接受这个损失，不做启动补提，也不做崩溃恢复。
- **没有串行队列。** 提炼请求走独立通道，绝不跟主对话请求排队。

### 软覆盖与向量判重（三态分流）

已有记忆不进提炼提示词，提示词成本不随记忆库变大而变贵。提炼结果在入库前先算向量，与热区/温区索引比对：

- **高相似且有词法话题交集（`NOOP` / `REPLACE`）**：通过确定性值标记对比（数字、路径、开关词等）判断——值标记相同则判为真重复丢弃（`NOOP`）；值标记不同（如偏好变更）则对旧条目写入 `superseded_by` 软覆盖标记，新条目正常入库（`REPLACE`）。
- **同话题超量**：相似度 `≥ similar_floor` 的条数超过 `similar_max` 时不再进库。
- **灰区与兜底**：落在灰区的条目先放行入库，交由 `alice_memory_tidy` 定期扫描兜底合并；`embedding` 挂了整道闸放行（fail-open），不因判重服务异常而丢记忆。

### prompt 结构

固定规则与约束前置（`system`），动态对话原文 `{{turns}}` 放在末尾，以尽可能复用推理后端的 KV / Prefix Cache：

- **禁止提取**：寒暄、应答词、追问、纯问句、情绪表达；「用户+动词」的过程叙述；只对本次任务有效的临时指令。
- **只认四类**：`preference`（偏好/习惯）、`fact`（长期事实）、`decision`（拍板决定）、`correction`（纠错结论）。
- **输出格式**：`{"items":[{"content":"一句话记忆","type":"preference|fact|decision|correction"}]}`。

---

## 二、召回与分层热度

```
用户这轮的话（'first' 模式下先过短输入/纯应答闸门，不消耗首轮名额）
   └─ embed（带超时预算，超长粘贴与代码块先骨架化截断）
        ├─ hot + warm 内存扫描（SharedArrayBuffer + worker 线程）
        ├─ FTS5 全文（始终跑，兜住精确词与术语）
        └─ 命中不足 → worker 扫全库冷层
   └─ RRF 融合 → 过滤已覆盖条目 → 热度与置顶微调 → MMR 话题去重 → 注入上下文
```

- **热度不进 SQL。** 存 `heat0 / reinforced_at / half_life_days`，衰减在 JS 里现算。
- **分层与滞回。** `hot_max` 3000、`warm_max` 12000，超了按热度往下压；双阈值滞回（hot 进 0.6 / 出 0.4，warm 进 0.3 / 出 0.15）。
- **只有真的被注入上下文才强化。** 候选集里没用上的不加热度；自动注入路径默认不刷热度。

实测（Windows 11 / Node 26 / 1 万条 × 1024 维）：热区向量扫描 20–30ms、FTS5 约 3ms、端到端召回 289ms，大头是 embedding 网络往返（200–380ms）。

---

## 三、数据表结构、脱敏与隐私

**一个数据目录只有一个库文件**：`<data_dir>/memories.sqlite3`，WAL 模式。正文、向量、墓碑、FTS 全在同一个 SQLite 里，单事务写入。

`memories` 表在本支线新增两列：

| 列 | 说明 |
| --- | --- |
| `memory_type` | `preference` / `fact` / `decision` / `correction`，手工 `remember` 为 `NULL`（覆盖时视为通配） |
| `extract_meta` | JSON：`confidence` 和 `source_turn_ids` |

`source` 列区分来源：`extracted`（本版提炼）、`manual`（手动记）、`auto`（主线规则捕获的历史行）。

**两处会出网**：
1. **embedding**：正文会发给你配的 embedding 服务商。不想外发就换本地模型，或把 `embedding.url` 指到自己的网关。
2. **提炼请求**：会给你的模型网关发一次独立请求，请求体里带待提炼的对话原文（仅过路，不落盘）。

**脱敏**：入库前会擦 `sk-`、`ghp_`、`github_pat_`、`xoxb-`、`AKIA`、`Bearer`、JWT、长 hex、base64 块、`-----BEGIN ... PRIVATE KEY-----`。

---

## 四、`inherit` 模型解析链路

默认 `capture.model = "inherit"`，含义是「跟当前主对话一样」。三层来源：

| 要什么 | 从哪来 | 什么时候读 |
| --- | --- | --- |
| provider 和 model | `agent/pre-step` 事件里的 `modelSelection` | **每一轮**都刷新 |
| `baseURL` 和凭证变量名 | `$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers.<provider>` | **每次提炼**重新读盘，不缓存 |
| 真实密钥 | 环境变量 → `$DSH_HOME/.env` → `$DSH_HOME/.credentials.yaml` 的 `refs:` | 每次提炼 |

- 在 GUI 里换模型，下一轮提炼跟着换；手改 `settings.yaml` 里的 `baseURL` 不用重启立刻生效。
- 写死具体模型名（如 `capture.model = "workbuddy/hy4free"`）时，插件会按模型名去 `providers` 里找归属，网关和凭证一起跟着换；也可直接配 `capture.base_url` 走独立端点。
- 主模型不在 `providers` 里就明确报错，不会把 key 发到错的网关。

---

## 五、开发、测试与目录结构

```bash
node --test test/     # 全量单测，不联网
```

测试全程 mock：`FakeEmbedder` 给确定性 hash 向量，`test/extract.test.mjs` 用假 transport 模拟提炼，`test/plugin.test.mjs` 起本机 http 假网关跑端到端，`test/upgrade.test.mjs` 守 v2 双库升级路径。

```
index.mjs                 插件入口：hook 挂载、工具注册、定时器
cli.mjs                   命令行
lib/config.mjs            配置合并 + 路径与 key 解析
lib/http.mjs              原生 http/https 传输
lib/store.mjs             SQLite：建表、写入、检索、分层、清理
lib/migrate.mjs           单文件库收束：旧双库并库、散落库导入
lib/vector-index.mjs      热区连续缓冲 + worker 调度
lib/vector-worker.mjs     worker：热区扫描 + 冷层全库扫
lib/embedding.mjs         HTTP embedding（可换 Fake）
lib/search.mjs            RRF 融合 + MMR 去重
lib/recall.mjs            召回 + 超时降级
lib/heat.mjs              热度与分层
lib/capture.mjs           粗筛规则 + 向量 backfill
lib/pool.mjs              待提炼池、空闲 debounce、flush 编排
lib/extractor.mjs         主模型连接解析、提炼 prompt、JSON 解析
lib/dedup.mjs             入库前向量判重与三态分流，fail-open
lib/extraction-store.mjs  单事务写条目 + 游标 + 每日计数
```

### 为什么 HTTP 不用 `globalThis.fetch`

DSH 后端会把全局 `fetch` 换成自己的实现（`globalThis.fetch = carrierFetch`）。在它下面用 `fetch` 发提炼请求，会拿到 200 但解析不出 `choices[0].message.content`，日志表现为 `extractor returned no content`。因此 `lib/http.mjs` 直接用 `node:http` / `node:https` 原生 socket，绕开宿主替换。

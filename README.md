# alice-memory-llm

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的长期记忆插件，**LLM 提炼支线**。

和主线 [alice-memory](https://github.com/cycocyco/alice-memory) 是同源代码：库文件布局、表结构、向量检索、分层热度、四个工具全部一样，**数据目录也共用同一个**（`$DSH_HOME/alice-memory`），所以你可以在两条线之间来回切换而不丢记忆。

唯一的分歧在「什么值得记」：

- **主线**：逐条规则闸门。形式对就进库，零模型调用，省钱但会混进闲聊。
- **本支线**：规则只做粗筛，真正的裁决交给你的主对话模型。静默几分钟后一次性批量提炼，只把一句话条目写进库，不存原文。

零第三方依赖，纯 Node（`node:sqlite`），不需要 Python、不需要额外数据库服务。

> **测试基线**：开发与验证全部在 **npm 方式安装的 DSH** 上完成（`npm i -g @deepseek-ai/dsh`，浏览器打开 `dsh web` 的 GUI）。**Electron 桌面版没有测过，不保证能用。**

---

## 先算清楚成本，再决定装不装

**这个版本会花你的模型调用费**，主线不会。不是所有人都愿意为「记得更准」付这笔钱，所以摆在最前面说。

| | 主线 alice-memory | 本支线 |
| --- | --- | --- |
| 捕获时的模型调用 | 0 次 | 每次提炼 1 次 `chat/completions` |
| embedding 调用 | 有 | 有（一样） |
| 默认每天最多调用几次 | — | 50 次 |
| 存进库的内容 | 每轮问答原文 | LLM 提炼的一句话条目 |

一次提炼的用量大致是：

- **输入**：固定指令约 400 token + 本次待提炼的对话原文（每轮截断：用户 500 字、助手 200 字，`capture.max_turn_chars` 可调）
- **输出**：上限 `max_tokens` 2048，实际通常只有两三百 token

已有记忆不进提炼提示词——与库内是否重复由入库前的向量判重裁决（见下文「向量判重」），所以这笔输入不随记忆库变大而变贵。

按你主模型的价目表乘一下就知道多少钱。**插件不预估、不代付、不兜底**——费用直接记在你 `settings.yaml` 里那个 provider 的账上。

想改上限就设 `capture.maxDailyExtractions`。到达上限后当天不再提炼，池里的消息留到第二天，或者等重启。

**怎么查今天花了多少次**：`alice-memory-llm status` 会打出 `today N/50` 那行；这个计数存在 `meta` 表里，重启不清零。

---

## 安装后必须做的三件事

大部分人是把仓库地址直接丢给 agent 装的。如果你是那个 agent，装完请按顺序把下面三条走完，别停在第一步。

### 1. 必须有一个能用的 embedding key

向量召回依赖它。放进 `$DSH_HOME/.env`（默认 `$DSH_HOME` 是 `~/.dsh`，被 `DSH_HOME` 环境变量覆盖）：

```bash
SILICONFLOW_API_KEY=sk-...
```

想换服务商就改 `embedding.url` / `embedding.model` / `embedding.dimensions` / `api_key_env`。**换了模型等于全库重嵌**，维度变了尤其麻烦，选之前想清楚。

### 2. 必须有一个在 `settings.yaml` 里声明过的 LLM provider

这是最容易踩的坑，单独开一节讲，见下面的 [它怎么知道用哪个模型](#它怎么知道用哪个模型inherit-不是写死)。

一句话版本：插件从 `$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers` 里找 provider。**如果你的主对话模型是「内置账号登录」那种（比如直接登 DeepSeek 官方账号），`settings.yaml` 里没有 provider 段，插件读不到它的地址，提炼会直接失败**，日志里写 `宿主 LLM provider 未找到`。

这种情况你得自己在 `settings.yaml` 里加一个 OpenAI 兼容的 provider，或者用 `capture.model` 指定一个已配置 provider 下的模型名。

### 3. 重启 DSH，然后确认它真的跑起来了

插件是后端 cordis 插件，**改完必须重启进程**，没有热重载。

重启后验证（不用等，随时能看）：

```bash
alice-memory-llm status
```

看到这两行才算通了：

```
extract    cursor 3  |  today 1/50  |  entries 4
embedding  BAAI/bge-m3 @ https://... (key ok)
```

`cursor (none yet...)` 不算故障——说明还没有「一轮对话结束 + 静默满 `idleMs`」的完整窗口。安静十分钟再看。

真出问题就看后端 stderr，插件所有日志都带 `[alice-memory-llm]` 前缀：

```
$DSH_HOME/../../backend/logs/backend-*.log.err   # 具体位置取决于你的启动方式
```

---

## 它怎么知道用哪个模型（`inherit` 不是写死）

**没有写死任何模型名、地址或密钥。** 默认 `capture.model = "inherit"`，含义是「跟当前主对话一样」。三层来源：

| 要什么 | 从哪来 | 什么时候读 |
| --- | --- | --- |
| provider 和 model | `agent/pre-step` 事件里的 `modelSelection` | **每一轮**都刷新 |
| `baseURL` 和凭证变量名 | `$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers.<provider>` | **每次提炼**重新读盘，不缓存 |
| 真实密钥 | 环境变量 → `$DSH_HOME/.env` → `$DSH_HOME/.credentials.yaml` 的 `refs:` | 每次提炼 |

由此得到几个直接后果：

- **你在 GUI 里换模型，下一轮提炼跟着换。** 换了 provider 也一样，因为 provider 跟 model 是同一个事件里一起来的。
- **你手改 `settings.yaml` 里的 `baseURL`，下一次提炼立刻生效。** 不用重启，因为每次 flush 都重新读文件。
- **缩进改了也不怕。** 解析器按块结构读，2 空格、4 空格都认。
- **写死成具体模型名也支持。** `capture.model = "workbuddy/hy4free"` 这种，插件会按这个模型名去 `providers` 里找它属于哪个 provider，**网关和凭证一起跟着换**，不会出现「用 A 家的地址配 B 家的 key」。
- **主模型不在 `providers` 里就明确报错，不会瞎发。** 宁可失败也不把你的 key 发到错的网关。

---

## 安装

```bash
dsh plugin --profile <你的 profile> add dsh-alice-memory-llm
```

国内网络加个镜像会快很多：`--registry https://registry.npmmirror.com`。

**不想走 npm，也可以从 git 装**（要求 GitHub 直连可达）：

```bash
dsh plugin --profile <你的 profile> add github:cycocyco/alice-memory-llm
```

**想先看一遍代码，就链本地源码**：

```bash
git clone https://github.com/cycocyco/alice-memory-llm.git
dsh plugin --profile web add file:/absolute/path/to/alice-memory-llm
```

要求 Node ≥ 24（`node:sqlite` 从 24 起稳定）。

**和主线二选一。** 两个包的 `cordis.patch.yml` 用不同的插件 id，同时装不会互相覆盖，但会各自跑一遍捕获和召回，记忆重复、调用翻倍，没必要。

**从主线迁过来**：直接换掉插件，不用迁数据。库是同一个，表结构兼容（本版启动时会给 `memories` 表补 `memory_type` / `extract_meta` 两列，老行保持 `NULL`，照常能被召回）。主线不知道这两列的存在，切回去也不会坏。

---

## 配置

默认值在 `lib/config.mjs`。要改就把 `config.example.json` 复制成插件目录下的 `config.json`（已在 `.gitignore`，不会被提交）。

```jsonc
{
  "data_dir": "",                    // 留空 = $DSH_HOME/alice-memory（与主线共用）
  "scope_id": "default",             // 多套记忆用不同 scope 隔离
  "api_key_env": "SILICONFLOW_API_KEY",
  "embedding": {
    "url": "https://api.siliconflow.cn/v1/embeddings",
    "model": "BAAI/bge-m3",
    "dimensions": 1024
  },

  // ↓ 这一块是本支线独有的
  "capture": {
    "enabled": true,
    "idleMs": 600000,                // 静默多久算空闲，默认 10 分钟
    "model": "inherit",              // inherit = 跟随主对话；也可写具体模型名
    "maxDailyExtractions": 50        // 每天最多调几次模型
  },

  "recall": { "limit": 3, "timeout_ms": 6000, "max_chars": 400 },
  "memory": { "hot_max": 3000, "warm_max": 12000, "half_life_days": 45 }
}
```

优先级：环境变量 > `config.local.json` > `config.json` > 内置默认值。

### 没有硬编码路径需要你填

代码里**没有任何写死的盘符、用户目录或仓库路径**。所有位置都从 `$DSH_HOME` 推导：

| 东西 | 默认位置 | 怎么改 |
| --- | --- | --- |
| 记忆库 | `$DSH_HOME/alice-memory/memories.sqlite3` | `data_dir` 配置项或 `ALICE_MEMORY_DATA_DIR` 环境变量 |
| 宿主 LLM 配置 | `$DSH_HOME/settings.yaml` | 跟 DSH 自己的位置走，插件只读它 |
| 密钥文件 | `$DSH_HOME/.env`、`$DSH_HOME/.credentials.yaml` | 同上 |
| 插件配置 | 插件目录下的 `config.json` | `ALICE_MEMORY_CONFIG` 可指到别处 |

唯一一个「填死的默认值」是 `embedding.url` 默认指向硅基流动——那是默认服务商地址，不是你的私人路径，换成任何 OpenAI 兼容接口都行。

**你真正需要手填的只有两样**：embedding 的 key（第一步）、以及 `settings.yaml` 里那个 provider 段（第二步）。这两样插件没法替你猜。

---

## 运行机制

```
消息进入
  → 粗筛（撤销命令 / 斜杠命令 / 纯应答词 / 纯标点 emoji / 自产文本 / < 3 字）
  → 通过则进内存池 pendingTurns（带轮次号，不落盘）
        ↓
  一轮对话结束 → 起 5 分钟闲置计时（每条新消息都会重置）
        ↓
  静默满 idleMs → 取 turnId > lastProcessedTurnId 的已完成轮次（原文按角色截断入池）
        ↓
  LLM 提炼（复用主对话模型，独立请求，prompt 只含原文与约束）
        ↓
  结构化条目数组（可以是空数组）
        ↓
  向量判重：近重复 / 同话题超量（similar_max）不进库；embedding 挂了放行
        ↓
  SQLite 单事务：写条目 + 推进游标 + 记一次提炼（全成功才提交）
        ↓
  发状态事件 memory-capture:start / :success / :failed（Cordis 事件，仅供宿主侧订阅）
```

几个刻意的设计决定：

- **只处理已完成的轮次。** assistant 还在生成时到点触发，不会截断，那一轮留到下次。
- **失败静默重试，游标不动。** 断网、超时、JSON 解析失败、DB 报错，一律回滚，下次空闲自动重提。失败也计一次额度，否则解析一直失败就会每 10 分钟重试到天亮。
- **空数组是合法输出。** 没值得记的就 `[]`，照样推进游标、照样报 `count=0`，不硬凑。
- **只存条目，不存原文。** 池里的原文不落盘，进程一崩就丢，接受这个损失，不做启动补提，也不做崩溃恢复。
- **向量判重在入库前，不在提示词里。** 提炼结果先算向量（入库本来就要算的），与热区/温区索引比对：top1 相似度 ≥ `near_dup` 判近重复跳过；相似度 ≥ `similar_floor` 的条数 > `similar_max` 视为该话题已被反复记过，不再进；同批内换说法的重复也只留第一条。embedding 挂了整道闸放行（fail-open）——判重是省钱优化，不能变成丢记忆的闸门。措辞一变的重复现在拦得住；重复、过时、错误的清理仍由你自己开库做。
- **没有串行队列。** 提炼请求走独立通道，绝不跟主对话请求排队。

### prompt 结构

只有原文与约束，没有参考块——与库内是否重复交给向量判重裁决，提示词不随记忆库变大：

```
【本次待提炼的对话原文】
turn 11 [user]: ...
turn 11 [assistant]: ...

【禁止提取清单】
- 寒暄、应答词、追问、纯问句、情绪表达
- 助手自己的操作汇报与进度说明
- 助手对当前任务的技术解释、原理说明
- 只对本次任务有效的中间结论

【任务】
只认三类来源：用户明确表达的偏好 / 用户交代的长期事实 / 双方拍板或用户做出的纠错。
助手说了什么不算记忆，除非用户当场确认采纳。
```

输出：

```json
{"items":[{"content":"一句话记忆","type":"preference|fact|decision|correction","confidence":0.9,"source_turn_ids":[11,13]}]}
```

---

## 数据与隐私

**一个数据目录只有一个库文件**：`<data_dir>/memories.sqlite3`，WAL 模式。正文、向量、墓碑、FTS 全在同一个 SQLite 里，单事务写入。

`memories` 表在本支线新增两列：

| 列 | 说明 |
| --- | --- |
| `memory_type` | `preference` / `fact` / `decision` / `correction`，仅提炼条目有值 |
| `extract_meta` | JSON：`confidence` 和 `source_turn_ids` |

`source` 列区分来源：`extracted`（本版提炼）、`manual`（手动记）、`auto`（主线规则捕获的历史行）。

**两处会出网**，说清楚：

1. **embedding**：正文会发给你配的 embedding 服务商。不想外发就换本地模型，或把 `embedding.url` 指到自己的网关。
2. **提炼请求**：会给你的主对话模型发一次独立请求，请求体里带这批待提炼的**对话原文**。原文只是过路，不落盘、不进库，但它确实离开了本机、送到了你配置的那个 `base_url`。

**脱敏**：入库前会擦 `sk-`、`ghp_`、`github_pat_`、`xoxb-`、`AKIA`、`Bearer`、JWT、长 hex、base64 块、`-----BEGIN ... PRIVATE KEY-----`。这是兜底，不是保险箱——别指望它挡住所有形态的密钥。

**数据全在你自己的机器上**，插件不上传、不统计、不带任何遥测。`.gitignore` 已排除 `*.sqlite3*`、`config.json`、`.env`。

---

## 召回（与主线完全一致）

```
用户这轮的话
   └─ embed（带 6s 超时）
        ├─ hot + warm 内存扫描（一块连续 Float32Array，worker 线程里跑）
        ├─ FTS5 全文（永远跑，很便宜）
        └─ 命中不足 → worker 扫全库冷层（900ms 预算，200k 条上限）
   └─ RRF 融合（k=60，向量 1.0 / 全文 0.35 / 冷层 ×0.8）
   └─ top-K 回表 → 注入上下文
```

- **热度不进 SQL。** 存 `heat0 / reinforced_at / half_life_days`，衰减在 JS 里现算。
- **分层是硬约束。** `hot_max` 3000、`warm_max` 12000，超了按热度往下压。
- **双阈值滞回。** hot 进 0.6 / 出 0.4，warm 进 0.3 / 出 0.15。
- **只有真的被注入上下文才强化。** 候选集里没用上的不加热度。

实测（Windows 11 / Node 26 / 1 万条 × 1024 维）：热区向量扫描 20–30ms、FTS5 约 3ms、端到端召回 289ms，大头是 embedding 网络往返（200–380ms）。

---

## 工具

| 工具 | 什么时候用 |
| --- | --- |
| `alice_memory_save` | 用户说「记一下」——手动存一条，**绕过全部粗筛和提炼**，默认 pinned、不衰减 |
| `alice_memory_recall` | 用户说「回忆一下」「之前那个」——主动检索 |
| `alice_memory_forget` | 用户说「删掉关于 X 的记忆」——按 id 或子串删，同时删向量、写墓碑 |
| `alice_memory_prune` | 用户说「清理记忆」——列出长期没被召回的冷记忆，**默认只预览**，带 token 或 `force` 才真删 |

---

## CLI

排查问题比翻日志快：

```bash
alice-memory-llm status                    # 条数 / 分层 / 游标 / 今日提炼次数 / key
alice-memory-llm doctor                    # 真发一次 embedding 探活
alice-memory-llm recall "上周说的那个方案"   # 看召回结果和耗时分解
alice-memory-llm remember "以后都用 pnpm" --title 包管理
alice-memory-llm forget --id <id>          # 或 --query <子串>
alice-memory-llm prune --days 90           # 只预览
alice-memory-llm prune --days 90 --token <t>   # 真删
alice-memory-llm sweep                     # 立刻跑一次热度分层
alice-memory-llm backfill                  # 补 pending 向量
alice-memory-llm export dump.jsonl
```

`--dir` 可以把整套库指到别处试跑，压过环境变量，不会碰你正在用的库。

---

## 排查

| 症状 | 原因 | 怎么办 |
| --- | --- | --- |
| `status` 里 `cursor (none yet...)` 一直是空的 | 还没有「一轮结束 + 静默满 `idleMs`」的窗口 | 安静待够 `idleMs`；对话期间计时会被每条消息重置 |
| 日志里 `宿主 LLM provider 未找到` | `settings.yaml` 没有 `llm-pi-ai.providers` 段 | 加一个 provider，或用 `capture.model` 指向已配置的模型 |
| 日志里 `缺少凭证 XXX` | 环境变量、`.env`、`.credentials.yaml refs` 三处都没有 | 把 key 放进其中一处 |
| 日志里 `extractor returned no content` | 模型把正文写进了 `reasoning_content`，或 `max_tokens` 被推理吃光 | 已做兜底读取；仍失败就调高 `max_tokens` 或降低推理强度 |
| 日志里 `extractor JSON parse failed` | 模型没按格式输出 | 每次失败都会重试，且计入当日额度；连续失败说明这个模型不适合干这活 |
| 提炼一直不触发但游标在涨 | 正常 | 游标只增，说明在推进；条目为 0 说明那批确实没值得记的 |
| `SQLITE_BUSY` | 多进程写同一个库 | 启动已设 WAL + `busy_timeout=5000`，正常情况下不会出现 |

---

## 开发

```bash
node --test test/     # 43 个用例，约 3s，不联网
```

测试全程 mock：`FakeEmbedder` 给确定性 hash 向量，`test/extract.test.mjs` 用假 transport 模拟提炼，`test/plugin.test.mjs` 起一个真的本机 http 假网关，把插件 `apply()` 跑一遍端到端。

`test/upgrade.test.mjs` 守升级路径：造出 v2 的双库布局（正文库 + 独立 `vectors.sqlite3`），验证打开即并库、老文件进 `legacy/`、反复启动不产生第二份、维度或模型变了的老向量被打回 `pending`。

插件结构：

```
index.mjs               插件入口：hook 挂载、四个工具、定时器
cli.mjs                 命令行
lib/config.mjs          配置合并 + 路径与 key 解析
lib/http.mjs            原生 http/https 传输
lib/store.mjs           SQLite：建表、写入、检索、分层、清理
lib/migrate.mjs         单文件库收束：旧双库并库、散落库导入
lib/vector-index.mjs    热区连续缓冲 + worker 调度
lib/vector-worker.mjs   worker：热区扫描 + 冷层全库扫
lib/embedding.mjs       HTTP embedding（可换 Fake）
lib/search.mjs          RRF 融合
lib/recall.mjs          召回 + 超时降级
lib/heat.mjs            热度与分层
lib/capture.mjs         粗筛规则 + 向量 backfill
lib/pool.mjs            待提炼池、空闲 debounce、flush 编排
lib/extractor.mjs       主模型连接解析、提炼 prompt（原文+约束）、JSON 解析
lib/dedup.mjs           入库前向量判重：近重复 / 同话题超量不进库，fail-open
lib/extraction-store.mjs 单事务写条目 + 游标 + 每日计数
```

### 为什么 HTTP 不用 `globalThis.fetch`

DSH 后端会把全局 `fetch` 换成自己的实现（`globalThis.fetch = carrierFetch`）。在它下面用 `fetch` 发提炼请求，会拿到 200 但解析不出 `choices[0].message.content`，日志表现为「每 5 分钟一条 `extractor returned no content`」，游标永远不动。同一个网关、同样的 payload，在插件进程外手搓能成功——差别只在那个被替换掉的 `globalThis.fetch`。

所以 `lib/http.mjs` 直接用 `node:http` / `node:https` 原生 socket，绕开宿主替换。embedding 也一样。

---

## 更新日志

见 [CHANGELOG.md](./CHANGELOG.md)。

## License

MIT
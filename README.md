# alice-memory-llm

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的长期记忆插件，**LLM 提炼支线**。

和主线 [alice-memory](https://github.com/cycocyco/alice-memory) 是同源代码：库文件布局、表结构、向量检索、分层热度、工具全部一样，**数据目录也共用同一个**（`$DSH_HOME/alice-memory`），所以你可以在两条线之间来回切换而不丢记忆。

唯一的分歧在「什么值得记」：

- **主线**：逐条规则闸门。形式对就进库，零模型调用，省钱但会混进闲聊。
- **本支线**：规则只做粗筛，真正的裁决交给你的主对话模型。静默几分钟后一次性批量提炼，只把一句话条目写进库，不存原文。

零第三方依赖，纯 Node（`node:sqlite`），不需要 Python、不需要额外数据库服务。

> **测试基线**：开发与验证全部在 **npm 方式安装的 DSH** 上完成（`npm i -g @deepseek-ai/dsh`，浏览器打开 `dsh web` 的 GUI）。**Electron 桌面版没有测过，不保证能用。**

---

## 它能干什么

**自动捕获，但由模型决定记什么。** 规则只做粗筛（挡掉斜杠命令、纯应答词、插件自产文本），真正的判断交给你的主对话模型：静默五分钟后一次性提炼，只把「用户明确表达的偏好 / 交代的长期事实 / 双方拍板的决定 / 用户当场纠错」写进库。**随口闲聊进不来**——这是它相对主线最大的价值。

**一句话条目，不是原文。** 库里存的是提炼后的结论，不是整段对话。同样的记忆量，占的空间和检索噪声都小得多。

**自动召回。** 下一轮对话开始前，按语义相关性静默取回最相关的几条塞进上下文，不需要你开口说「回忆一下」。

**手动记、手动想。** 「记一下」写一条 pinned 记忆，永久保留、不衰减。「回忆一下」主动检索给你。

**冷热衰减分层。** 按「时间衰减 + 被强化次数」把记忆分成 hot / warm / cold，只有热的常驻内存参与每轮检索。记忆量从几十条长到上万条，召回延迟基本不变。

**批量整理工具。** `alice_memory_tidy` 一个入口干三件事：翻条目、按 id 批量删、把多条合并成一条新总结。代码先用向量把「可能重复」的成簇、把空壳挑出来，语义判断留给你。

**可以接入 cron 自动整理。** 插件本身不做调度——要不要定期整理、隔多久、报告投到哪，都是你自己的事。见 [TIDY.md](TIDY.md) 末尾那份任务说明。

---

## 适用人群

**适合你，如果：**

- 你受不了记忆库里混进「好的」「继续」这类废话，希望只有真正值得记的东西进来。
- 你已经在用付费的对话模型，不介意多花一点让它帮你整理记忆。
- 你的记忆量会上千条，需要语义召回而不是关键词匹配。
- 你想让记忆可见、可改、可删。

**不适合你，如果：**

- **你不想多花一分钱。** 这个版本每次提炼都会发一次真实的 `chat/completions` 请求。不想付这笔钱就用主线 alice-memory，零模型调用。
- 你只想记几条稳定的小事实。那种场景用 Markdown 文件就够了。
- 你用的是「内置账号登录」型的主模型（比如直接登官方账号），而 `settings.yaml` 里没有 provider 段——插件读不到模型地址，提炼会失败。这种情况得自己配一个 OpenAI 兼容 provider。
- 你的环境装不了 Node（要求 Node ≥ 24）。

---

## 用之前要想清楚的代价

**一、这会花你的模型调用费。** 不是所有人都愿意为「记得更准」付这笔钱，所以摆在最前面说。

| | 主线 alice-memory | 本支线 |
| --- | --- | --- |
| 捕获时的模型调用 | 0 次 | 每次提炼 1 次 `chat/completions` |
| embedding 调用 | 有 | 有（一样） |
| 默认每天最多调用几次 | — | 50 次 |
| 存进库的内容 | 每轮问答原文 | LLM 提炼的一句话条目 |

一次提炼的用量大致是：**输入**约 400 token 固定指令 + 本次待提炼的对话原文（每轮截断：用户 500 字、助手 200 字）；**输出**上限 2048 token，实际通常两三百。

已有记忆**不进**提炼提示词——与库内是否重复由入库前的向量判重裁决，所以这笔输入不随记忆库变大而变贵。

按你主模型的价目表乘一下就知道多少钱。**插件不预估、不代付、不兜底**——费用直接记在你 `settings.yaml` 里那个 provider 的账上。想改上限设 `capture.maxDailyExtractions`，到顶后当天不再提炼。

**二、向量服务不配也能用，但语义召回会退化。** 插件**不预设任何向量服务商**，`embedding.url` 和 `model` 默认是空的。不填就退回纯全文/关键词检索：记忆照常写、照常召回，只是换个说法就对不上号。而且**向量判重也会随之失效**（fail-open，不拦任何条目），重复条目会更容易进库。

要开启语义召回，填 `embedding.url` / `model` 和 key。两条路：云端 API（便宜但正文会发给服务商），或本机跑模型（数据不出机器，但要自己装）。

**三、必须有一个能在 `settings.yaml` 里解析到的 LLM provider。** 这是最容易踩的坑，见下面「安装后必须做的三件事」。

**四、会出网的地方有两个。** 配了 embedding 才会发正文给服务商；提炼则一定对话原文发给你的主模型。原文只是过路，不落盘、不进库，但它确实离开了本机。

---

## 安装

```bash
dsh plugin --profile <你的 profile> add dsh-alice-memory-llm
```

国内网络加个镜像：`--registry https://registry.npmmirror.com`。

**不想走 npm，也可以从 git 装**（要求 GitHub 直连可达）：

```bash
dsh plugin --profile <你的 profile> add github:cycocyco/alice-memory-llm
```

**想先看一遍代码再装，就链本地源码**：

```bash
git clone https://github.com/cycocyco/alice-memory-llm.git
dsh plugin --profile web add file:/absolute/path/to/alice-memory-llm
```

要求 Node ≥ 24（`node:sqlite` 从 24 起稳定）。

## 安装后必须做的三件事

大部分人是把仓库地址直接丢给 agent 装的。如果你是那个 agent，装完请按顺序把下面三条走完，别停在第一步。

**1. 建议配一个 embedding（不配也能跑）**

**插件不预设任何向量服务商**，`embedding.url` 和 `model` 默认空着。不填的话：捕获和召回都正常，只是召回退化成全文/关键词检索，而且向量判重失效。

想开启语义召回，把 key 放进 `$DSH_HOME/.env`（默认 `$DSH_HOME` 是 `~/.dsh`，被 `DSH_HOME` 环境变量覆盖）：

```bash
EMBEDDING_API_KEY=你的密钥
```

再在 `config.json` 里填 `embedding.url` / `embedding.model` / `embedding.dimensions`，以及需要的话改 `api_key_env`。**url 要任何 OpenAI 兼容的 `/v1/embeddings` 接口，不限于某一家服务商。** 换模型等于全库重嵌，维度变了尤其麻烦，选之前想清楚。

配完用 `alice-memory-llm doctor` 验连通性和维度。

**2. 必须有一个在 `settings.yaml` 里声明过的 LLM provider**

插件从 `$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers` 里找 provider。**如果你的主对话模型是「内置账号登录」那种（比如直接登 DeepSeek 官方账号），`settings.yaml` 里没有 provider 段，插件读不到它的地址，提炼会直接失败**，日志里写 `宿主 LLM provider 未找到`。

这种情况你得自己在 `settings.yaml` 里加一个 OpenAI 兼容的 provider，或者用 `capture.model` 指定一个已配置 provider 下的模型名。

**3. 重启 DSH，然后确认它真的跑起来了**

插件是后端 cordis 插件，**改完必须重启进程**，没有热重载。重启后验证：

```bash
alice-memory-llm status
```

看到这两行才算通了：

```
extract    cursor 3  |  today 1/50  |  entries 4
embedding  未配置 —— 当前只走全文/关键词召回，向量通道关闭
```

`embedding` 那行说「未配置」是正常的——不配向量也能用。配了的话它会显示模型名和 `(key ok)`。

`cursor (none yet...)` 不算故障——说明还没有「一轮对话结束 + 静默满 `idleMs`」的完整窗口。安静十分钟再看。

真出问题就看后端 stderr，插件所有日志都带 `[alice-memory-llm]` 前缀。

## 配置

把 `config.example.json` 复制成插件目录下的 `config.json`（已在 `.gitignore` 里）。完整说明见文件里的 `_readme` 段，几个关键的：

```jsonc
{
  "capture": {
    "idleMs": 600000,          // 静默多久触发提炼
    "model": "inherit",        // 跟随主对话模型
    "maxDailyExtractions": 50  // 每天最多调几次模型（失败也算一次）
  }
}
```

这三个都直接决定花多少钱。

## 工具

| 工具 | 什么时候用 |
| --- | --- |
| `alice_memory_save` | 「记一下」——手动存一条，**绕过全部粗筛和提炼**，默认 pinned |
| `alice_memory_recall` | 「回忆一下」「之前那个」——主动检索 |
| `alice_memory_forget` | 「删掉关于 X 的记忆」——按 id 精确删；按关键词只列命中，带 `confirm` 才真删 |
| `alice_memory_prune` | 「清理冷记忆」——列出长期没被召回的冷记忆，**默认只预览** |
| `alice_memory_tidy` | 「整理记忆库」「合并重复的记忆」——翻条目 / 批量删 / 合并，默认只出 diff |

整理功能的用法见 [TIDY.md](TIDY.md)。

## 命令行

```bash
alice-memory-llm status        # 库概况 + 提炼游标和今日额度
alice-memory-llm doctor        # 真发一次 embedding 探活
alice-memory-llm recall "上周说的那个方案"
alice-memory-llm list --keyword 代理 --limit 20
alice-memory-llm tidy          # 整理候选：重复簇 / 空壳 / 久未用
alice-memory-llm merge --ids a,b,c --content "总结" --apply
alice-memory-llm export dump.jsonl
```

## 更多

- [ARCHITECTURE.md](ARCHITECTURE.md) —— 提炼机制、怎么选模型、prompt 结构、数据模型
- [TIDY.md](TIDY.md) —— 整理记忆库：候选怎么来、删和合并怎么做、怎么接成周期性任务
- [CHANGELOG.md](CHANGELOG.md) —— 版本历史

## License

MIT

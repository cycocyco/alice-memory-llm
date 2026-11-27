# alice-memory-llm

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的长期记忆插件，**LLM 提炼支线**。

适合**既要日常偏好记忆、又要让 Agent 稳定做长程工程/写代码**的用户：只注入最相关的记忆，不靠开场塞几千字纯文本稀释模型注意力。

### 核心能力速览

- **空闲批量提炼 + 冲突覆盖**：对话静默后由 LLM 提炼成一句话条目（不存冗长原文）；偏好或约定变更时支持软覆盖旧记忆，不新旧打架。
- **会自然淡忘，也死守铁律**：`hot / warm / cold / archive` 分层热度 + 半衰期自然衰减，不常用的闲聊自动沉底；手动 `remember` 的铁律默认 `pinned` 永不遗忘。
- **精准混合召回**：本地 SQLite FTS5 + 向量语义检索（RRF 融合 + MMR 去重），支持首轮注入或主动按需回忆。
- **零第三方依赖**：纯 Node（`node:sqlite`，要求 Node ≥ 24），正文、向量、全文索引全在单个本地 SQLite 文件中，不上传、无遥测。

> 和主线 [alice-memory](https://github.com/cycocyco/alice-memory) 共用同一数据目录（`$DSH_HOME/alice-memory`）与表结构，两条线可随时切换不丢记忆。区别在于主线靠零成本规则捕获，本支线交给 LLM 提炼。
>
> **测试基线**：开发与验证全部在 **npm 方式安装的 DSH** 上完成（`npm i -g @deepseek-ai/dsh`，浏览器打开 `dsh web`）。**Electron 桌面版未测，不保证兼容。**

---

## 先算清楚成本，再决定装不装

**本支线会花你的模型调用费**（主线不会）：

| | 主线 alice-memory | 本支线 |
| --- | --- | --- |
| 捕获时的模型调用 | 0 次 | 每次提炼 1 次 `chat/completions`（默认每日上限 50 次） |
| embedding 调用 | 有 | 有（一样） |
| 存进库的内容 | 每轮问答原文 | LLM 提炼的一句话条目 |

一次提炼输入约 400 token 固定指令 + 本次截断后的对话原文（已有记忆不进提示词），输出通常两三百 token。费用直接记在你 `settings.yaml` 对应 provider 的账上，可用 `alice-memory-llm status` 查看 `today N/50`。

---

## 安装与三步上手

```bash
dsh plugin --profile <你的 profile> add dsh-alice-memory-llm
# 国内镜像：--registry https://registry.npmmirror.com
# 或从源码链入：dsh plugin --profile web add file:/absolute/path/to/alice-memory-llm
```

> 和主线**二选一**即可，同时装会重复捕获。

装完请按顺序完成这三步：

1. **配置 embedding key**：把 `SILICONFLOW_API_KEY=sk-...` 放进 `$DSH_HOME/.env`（默认 `$DSH_HOME` 为 `~/.dsh`）。换服务商改 `embedding.url` / `model` / `dimensions` / `api_key_env`。
2. **确保有可用的 LLM provider**：默认 `capture.model = "inherit"`，从 `$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers` 读取地址和凭证。**如果是内置账号登录（`settings.yaml` 里没有 provider 段），提炼会失败**，需自己配一个 OpenAI 兼容 provider 或在 `capture.model` / `capture.base_url` 指定独立端点。
3. **重启 DSH 并验证**：插件无热重载，改完需重启，然后运行：

```bash
alice-memory-llm status
```

看到 `extract cursor ... | today .../50 | entries ...` 和 `embedding ... (key ok)` 即表示跑通。

---

## 常用配置

复制 `config.example.json` 为插件目录下的 `config.json`（已在 `.gitignore`）。代码无任何硬编码路径，均从 `$DSH_HOME` 推导：

```jsonc
{
  "data_dir": "",                    // 留空 = $DSH_HOME/alice-memory
  "scope_id": "default",             // 多套记忆隔离
  "api_key_env": "SILICONFLOW_API_KEY",
  "embedding": {
    "url": "https://api.siliconflow.cn/v1/embeddings",
    "model": "BAAI/bge-m3",
    "dimensions": 1024
  },
  "capture": {
    "enabled": true,
    "idleMs": 600000,                // 静默多久算空闲（默认 10 分钟）
    "model": "inherit",              // inherit = 跟随主对话；也可写具体模型名
    "maxDailyExtractions": 50
  },
  "recall": { "limit": 3, "timeout_ms": 6000, "max_chars": 400 },
  "memory": { "hot_max": 3000, "warm_max": 12000, "half_life_days": 45 }
}
```

优先级：环境变量 > `config.local.json` > `config.json` > 内置默认值。

---

## 工具与常用 CLI

| 工具 | 用途 |
| --- | --- |
| `alice_memory_save` | 用户说「记一下」——手动存一条，**默认 pinned、不衰减** |
| `alice_memory_recall` | 用户说「回忆一下」「之前那个」——主动检索 |
| `alice_memory_forget` | 按 id 精确删，或按关键词列命中后 `confirm` 删除 |
| `alice_memory_prune` | 列出长期未用的冷记忆（默认只预览） |
| `alice_memory_tidy` | `scan` 出重复/空壳/陈旧候选，`delete` / `merge` 整理库（详见 [TIDY.md](./TIDY.md)） |

常用排查命令：

```bash
alice-memory-llm status                    # 条数 / 分层 / 游标 / 今日次数 / key
alice-memory-llm doctor                    # 真发一次 embedding 探活
alice-memory-llm recall "上周说的那个方案"   # 看召回结果和耗时分解
alice-memory-llm sweep                     # 立刻跑一次热度分层
alice-memory-llm backfill                  # 补 pending 向量
alice-memory-llm export dump.jsonl         # 导出全库
```

---

## 常见排查

| 症状 | 原因与处理 |
| --- | --- |
| `cursor (none yet...)` 一直为空 | 尚未满足「一轮结束 + 静默满 `idleMs`」窗口；对话期间会重置计时 |
| `宿主 LLM provider 未找到` | `settings.yaml` 缺少 `llm-pi-ai.providers` 段，或使用了内置账号登录；请配置 provider 或 `capture.base_url` |
| `缺少凭证 XXX` | 环境变量、`.env`、`.credentials.yaml refs` 三处均未找到对应 key |
| `extractor returned no content` | 推理模型把正文写进 `reasoning_content` 或 `max_tokens` 被推理吃光；调高 `max_tokens` 或降推理强度 |
| `extractor JSON parse failed` | 模型未按 JSON 输出；连续失败说明该模型不适合做提炼 |

---

## 延伸阅读

- **底层架构、提炼与召回机制、源码结构与开发测试**：见 [ARCHITECTURE.md](./ARCHITECTURE.md)
- **记忆库整理与定期清理指南**：见 [TIDY.md](./TIDY.md)
- **更新日志**：见 [CHANGELOG.md](./CHANGELOG.md)
- **License**：MIT

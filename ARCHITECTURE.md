# 技术架构

这份文档讲 [alice-memory-llm](README.md) 内部怎么实现的。只想用的话看 README 就够了。

数据模型、召回流程、分层热度和主线 [alice-memory](https://github.com/cycocyco/alice-memory) 完全一致（同源代码），这里主要讲本支线独有的部分：**提炼机制**。其余细节看主线的 [ARCHITECTURE.md](https://github.com/cycocyco/alice-memory/blob/main/ARCHITECTURE.md)。

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
- **向量判重在入库前，不在提示词里。** 提炼结果先算向量（入库本来就要算的），与热区/温区索引比对：top1 相似度 ≥ `near_dup` 判近重复跳过；相似度 ≥ `similar_floor` 的条数 > `similar_max` 视为该话题已被反复记过，不再进；同批内换说法的重复也只留第一条。embedding 挂了整道闸放行（fail-open）——判重是省钱优化，不能变成丢记忆的闸门。
- **没有串行队列。** 提炼请求走独立通道，绝不跟主对话请求排队。

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

## prompt 结构

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

## 数据模型（与主线的差异）

`memories` 表在本支线新增两列：

| 列 | 说明 |
| --- | --- |
| `memory_type` | `preference` / `fact` / `decision` / `correction`，仅提炼条目有值 |
| `extract_meta` | JSON：`confidence` 和 `source_turn_ids` |

`source` 列区分来源：`extracted`（本版提炼）、`manual`（手动记）、`auto`（主线规则捕获的历史行）。

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

## 整理功能的实现

与主线同一套：代码用现成向量算余弦相似度把候选成簇（阈值 0.78），空壳只认确定性高的形态，语义判断留给模型。合并的语义是「新写一条总结、删掉全部源条目」。

细节见主线的 [ARCHITECTURE.md](https://github.com/cycocyco/alice-memory/blob/main/ARCHITECTURE.md#整理功能的实现) 和 [TIDY.md](TIDY.md)。

## 开发

```bash
node --test test/     # 全量用例，约 3s，不联网
```

测试用 `FakeEmbedder`（确定性 hash 向量）和假 LLM 客户端代替真服务，离线能跑。

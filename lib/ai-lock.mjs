// 进程内 AI 请求串行闸门 —— 按车道排队。
//
// 为什么需要：自建端点是 2 核 4 线程的机器，向量模型和提炼模型同时驻留，
// 外加 xray。两边一旦并发，各自只能分到半台 CPU，排队时间直接翻倍。
//
// 为什么分车道：一开始所有 AI 请求共用一条链，结果提炼（超时给到 120 秒）
// 一旦卡在网络重置上，召回就排在它后面干等——实测把每回合的准备时间拖到 6 秒，
// 召回被迫降级成纯关键词。向量只要几百毫秒，让它排在提炼后面完全不划算。
// 现在两条车道互不阻塞，同车道内仍然严格串行。
const tails = new Map();

/** 测试用：等指定车道（不传则全部）排空 */
export async function drainAiLock(lane = '') {
  const wait = lane ? [tails.get(lane)] : [...tails.values()];
  await Promise.all(wait.filter(Boolean));
}

export function withAiLock(fn, lane = 'default') {
  const tail = tails.get(lane) ?? Promise.resolve();
  const run = tail.then(fn, fn);
  // 链尾吞掉结果/异常，只用来排队；调用方拿到的仍是 run 本身
  tails.set(lane, run.then(() => undefined, () => undefined));
  return run;
}

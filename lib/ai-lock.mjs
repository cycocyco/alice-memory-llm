// 进程内 AI 请求串行闸门。
//
// 为什么需要：自建端点是 2 核 4 线程的机器，向量模型和提炼模型同时驻留，
// 外加 xray。两边一旦并发，各自只能分到半台 CPU，排队时间直接翻倍——
// 实测表现为「偶发 20 秒无响应」。串行之后每个请求都能吃满核心，
// 单次更快，总量不变。
//
// 只做一件事：把调用排成一条链，前一个结束才发下一个。前一个失败不影响后一个。
let tail = Promise.resolve();

export function withAiLock(fn) {
  const run = tail.then(fn, fn);
  // 链尾吞掉结果/异常，只用来排队；调用方拿到的仍是 run 本身
  tail = run.then(() => undefined, () => undefined);
  return run;
}

/** 测试用：等当前队列排空 */
export async function drainAiLock() {
  await tail;
}

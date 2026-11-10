// 日志：包一层，便于在测试里注入静默 sink
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function createLogger(level = 'info', sink = null) {
  const min = LEVELS[level] ?? LEVELS.info;
  const write = sink ?? ((line) => console.error(line));
  const emit = (name, args) => {
    if ((LEVELS[name] ?? 9) > min) return;
    const text = args
      .map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : typeof a === 'string' ? a : safeJson(a)))
      .join(' ');
    write(`[alice-memory-llm] ${name.toUpperCase()} ${text}`);
  };
  return {
    level,
    error: (...a) => emit('error', a),
    warn: (...a) => emit('warn', a),
    info: (...a) => emit('info', a),
    debug: (...a) => emit('debug', a),
    child: (tag) => createLogger(level, (line) => write(`${line} (${tag})`)),
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

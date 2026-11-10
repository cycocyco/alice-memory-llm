/**
 * alice-memory-llm — 客户端半边：记忆提炼指示器。
 *
 * 只在「宿主真的开始提炼」那一刻出现，平时页面里什么都没多。
 *   - 转圈 + 「记忆生成中...」  提炼进行中
 *   - 圈变绿、字消失、停 1 秒 → 渐隐   提炼成功
 *   - 圈不变绿，直接被渐隐掉         提炼失败（不红、不弹窗、不解释）
 *
 * 状态来源：宿主自己的 SSE 路由 `GET /alice-memory-llm/status`，帧形如
 * `{ phase: 'working' | 'success' | 'failed' | 'idle', at, turns?, count? }`。
 * 内核不转发第三方插件的自定义事件，所以这条线是自己开的（见 lib/status.mjs）。
 *
 * 位置：红框那块空白是会话头部的 View 标签行，内核没给那里留插槽，所以插进
 * `[data-conversation-tabs]`（role="tablist" 的 View 标签组）的父节点，排在
 * 「更多视图」按钮之后——就是原图红框开头的位置。单视图会话没有标签行时，
 * 退回到 `conversation.session.header.utilities` 插槽里内联渲染（标题行右端）。
 *
 * 只 require('react') / require('react-dom')，两者都在 loader 的静态模块表里。
 */
window.__ModuleLoader__.load({
  id: 'dsh-alice-memory-llm',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const ENDPOINT = '/alice-memory-llm/status'
    const SLOT = 'conversation.session.header.utilities'
    const LABEL = '记忆生成中...'
    /** 变绿后保持多久再渐隐。 */
    const HOLD_MS = 1000
    /** 渐隐时长，与 CSS 的 opacity transition 对齐。 */
    const FADE_MS = 450

    const CSS = `
.alm-host{display:inline-flex;align-items:center;align-self:center;flex:none;pointer-events:none}
.alm-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:16px;font-weight:400;color:var(--dsw-alias-label-secondary,#cfd3d6);white-space:nowrap;user-select:none;opacity:1;transition:opacity ${FADE_MS}ms ease}
.alm-pill[data-out="true"]{opacity:0}
.alm-ring{box-sizing:border-box;flex:none;width:13px;height:13px;border-radius:50%;border:1.5px solid color-mix(in srgb, currentColor 28%, transparent);border-top-color:currentColor;animation:alm-spin 720ms linear infinite}
.alm-ring[data-done="true"]{border-color:var(--dsw-alias-state-success-primary,#3ecf8e);border-top-color:var(--dsw-alias-state-success-primary,#3ecf8e);animation:none}
@keyframes alm-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.alm-ring{animation-duration:1800ms}}
`

    function StyleTag() {
      return h('style', { 'data-alice-memory-indicator': '' }, CSS)
    }

    /** 提炼状态订阅：一条 SSE，断了浏览器自己重连。 */
    function useCapturePhase() {
      const [phase, setPhase] = React.useState('idle')
      React.useEffect(() => {
        if (typeof EventSource !== 'function') return undefined
        let source
        try {
          source = new EventSource(ENDPOINT)
        } catch {
          return undefined
        }
        const onStatus = (event) => {
          let frame = null
          try {
            frame = JSON.parse(event.data)
          } catch {
            return
          }
          const next = typeof frame?.phase === 'string' ? frame.phase : 'idle'
          setPhase(next === 'working' || next === 'success' ? next : 'idle')
        }
        source.addEventListener('status', onStatus)
        return () => {
          source.removeEventListener('status', onStatus)
          source.close()
        }
      }, [])
      return phase
    }

    /**
     * 标签行里那块空白：把宿主元素塞进 View 标签组的父节点。
     * 找不到（单视图会话没有标签行）就返回 null，走插槽内联兜底。
     */
    function useTabRowHost(active) {
      const [host, setHost] = React.useState(null)
      React.useEffect(() => {
        if (!active) return undefined
        const host_ = document.createElement('span')
        host_.className = 'alm-host'
        const row = document.querySelector('[data-conversation-tabs]')?.parentElement
        if (row === null || row === undefined) return undefined
        row.appendChild(host_)
        setHost(host_)
        return () => {
          setHost(null)
          host_.remove()
        }
      }, [active])
      return host
    }

    /**
     * 指示器本体：idle 时什么都不渲染，宿主元素也只在这段时间存在。
     * @param {{ phase: string }} props 提炼相位，来自 SSE。
     */
    function CaptureIndicator({ phase }) {
      // stage: 'idle'（不占位）| 'working' | 'done'（绿圈停顿）| 'out'（渐隐中）
      const [stage, setStage] = React.useState('idle')

      React.useEffect(() => {
        if (phase === 'working') {
          setStage('working')
          return undefined
        }
        if (phase === 'success') {
          setStage('done')
          const hold = setTimeout(() => setStage('out'), HOLD_MS)
          const gone = setTimeout(() => setStage('idle'), HOLD_MS + FADE_MS)
          return () => {
            clearTimeout(hold)
            clearTimeout(gone)
          }
        }
        if (phase === 'failed') {
          // 失败就是失败：圈不绿、字不改、什么都不说，直接淡掉。
          setStage('out')
          const gone = setTimeout(() => setStage('idle'), FADE_MS)
          return () => {
            clearTimeout(gone)
          }
        }
        // 连上时收到 idle，或状态被推翻：直接收摊。
        setStage('idle')
        return undefined
      }, [phase])

      const host = useTabRowHost(stage !== 'idle')
      if (stage === 'idle') return null

      const node = h(
        'span',
        {
          className: 'alm-pill',
          'data-out': stage === 'out' ? 'true' : 'false',
          role: 'status',
          'aria-live': 'polite',
        },
        h(StyleTag),
        h('span', {
          className: 'alm-ring',
          'data-done': stage === 'done' ? 'true' : 'false',
          'aria-hidden': 'true',
        }),
        stage === 'done' ? null : h('span', { className: 'alm-text' }, LABEL),
      )

      if (host === null) return node
      return ReactDOM.createPortal(node, host)
    }

    /** 插槽入口：一条 SSE 订阅，其余交给指示器自己。 */
    function HeaderIndicator() {
      return h(CaptureIndicator, { phase: useCapturePhase() })
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: 'alice-memory-capture',
              order: 40,
            },
            HeaderIndicator,
          ),
        )
      },
    }
  },
})

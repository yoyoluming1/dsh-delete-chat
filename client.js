/** Client half of `dsh-delete-chat`: a per-turn delete control in the Chat. */

const NS = 'deleteChat'

const zh = {
  button: '删除对话',
  title: '删除这段对话',
  hint: '删除会新建一个会话：原来的会话保留在列表里，可以从新会话继续。',
  onlyTurn: '只删除这一轮，保留后面的对话',
  cutAll: '删除这一轮及之后的所有对话',
  cancel: '取消',
  busy: '正在创建新会话…',
  failed: '删除失败：{message}',
  opened: '已创建新会话',
  unavailable: 'Host 插件未启用，删除命令不可用。',
}

const en = {
  button: 'Delete',
  title: 'Delete this part of the conversation',
  hint: 'Deleting creates a new conversation. The original stays in the list; continue in the new one.',
  onlyTurn: 'Delete this turn only, keep later turns',
  cutAll: 'Delete this turn and everything after',
  cancel: 'Cancel',
  busy: 'Creating the new conversation…',
  failed: 'Delete failed: {message}',
  opened: 'New conversation created',
  unavailable: 'The Host plugin is not active, so the delete command is unavailable.',
}

window.__ModuleLoader__.load({
  id: 'dsh-delete-chat',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** One settled delete request. */
    async function runDelete(ctx, t, sessionId, mode, seq) {
      const newId = `session-${randomId()}`
      const line = `/delete-chat ${mode} ${seq} ${newId}`
      const result = await ctx.remote.commands.execute(sessionId, line, [])
      if (!result.ok) throw new Error(result.error?.message ?? 'command failed')
      const execution = result.value
      if (execution === undefined) throw new Error(t('unavailable'))
      const outcome = execution.result ?? execution
      if (outcome?.kind === 'error') throw new Error(outcome.text ?? 'delete failed')
      // The Host flushed the new Session log before settling the command, so a
      // resume by id succeeds immediately; the original conversation is untouched.
      ctx.uiWorkspace.openSession(newId)
      return newId
    }

    /** Lowercase uuid v4 without Node's crypto dependency. */
    function randomId() {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
      const bytes = new Uint8Array(16)
      if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes)
      else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    }

    /** Small inline trash glyph. */
    function TrashIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, focusable: 'false',
        style: { display: 'block', flex: '0 0 auto' },
      }, h('path', {
        d: 'M6 1.5h4a1 1 0 0 1 1 1V3h2.25a.75.75 0 0 1 0 1.5h-.63l-.62 8.1A1.9 1.9 0 0 1 10.1 14.5H5.9a1.9 1.9 0 0 1-1.9-1.9l-.62-8.1H2.75a.75.75 0 0 1 0-1.5H5v-.5a1 1 0 0 1 1-1Zm.5 1.5h3V3h-3v.5ZM5.03 4.5l.6 7.87a.4.4 0 0 0 .4.37h3.94a.4.4 0 0 0 .4-.37l.6-7.87H5.03Z',
        fill: 'currentColor',
      }))
    }

    /** Shared action button matching the host's small controls. */
    function ActionButton({ children, onClick, disabled, tone }) {
      const [hover, setHover] = React.useState(false)
      const danger = tone === 'danger'
      return h('button', {
        type: 'button',
        onClick,
        disabled,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          appearance: 'none',
          border: `1px solid ${danger ? 'var(--dsw-alias-state-error-primary, #c0392b)' : 'var(--dsw-alias-border-l2, rgba(127,127,127,.4))'}`,
          background: hover && !disabled
            ? danger
              ? 'var(--dsw-alias-interactive-bg-hover-danger, rgba(192,57,43,.12))'
              : 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))'
            : 'var(--dsw-alias-bg-layer-1, transparent)',
          color: danger ? 'var(--dsw-alias-state-error-primary, #c0392b)' : 'var(--dsw-alias-label-primary, inherit)',
          borderRadius: '8px',
          padding: '6px 10px',
          fontSize: '12px',
          lineHeight: '16px',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.55 : 1,
        },
      }, children)
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'delete-chat: locale')

        /** The per-turn control; the panel expands in the turn's own flow. */
        function TurnDelete({ seq, sessionId, t }) {
          const [open, setOpen] = React.useState(false)
          const [busy, setBusy] = React.useState(false)
          const [error, setError] = React.useState(null)
          const submit = async (mode) => {
            setBusy(true)
            setError(null)
            try {
              await runDelete(ctx, t, sessionId, mode, seq)
              setOpen(false)
            } catch (reason) {
              setError(String(reason?.message ?? reason))
            } finally {
              setBusy(false)
            }
          }
          return h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start' } },
            h('button', {
              type: 'button',
              title: t('button'),
              'aria-label': t('button'),
              'aria-expanded': open,
              onClick: () => setOpen(value => !value),
              disabled: busy,
              style: {
                appearance: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                border: '1px solid transparent',
                background: open ? 'var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.12))' : 'transparent',
                color: 'var(--dsw-alias-label-tertiary, inherit)',
                borderRadius: '6px',
                padding: '3px 6px',
                fontSize: '12px',
                lineHeight: '18px',
                cursor: busy ? 'default' : 'pointer',
              },
            }, h(TrashIcon), t('button')),
            open && h('div', {
              role: 'group',
              'aria-label': t('title'),
              style: {
                marginTop: '6px',
                padding: '12px',
                maxWidth: '440px',
                border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
                borderRadius: '10px',
                background: 'var(--dsw-alias-bg-layer-1, transparent)',
                color: 'var(--dsw-alias-label-primary, inherit)',
                fontSize: '12px',
              },
            },
            h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, t('title')),
            h('div', { style: { color: 'var(--dsw-alias-label-secondary, inherit)', lineHeight: '18px', marginBottom: '10px' } }, t('hint')),
            error === null ? null : h('div', {
              role: 'alert',
              style: { color: 'var(--dsw-alias-state-error-primary, #c0392b)', marginBottom: '8px', lineHeight: '18px' },
            }, t('failed').replace('{message}', error)),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
              h(ActionButton, { onClick: () => { void submit('keep-later') }, disabled: busy }, t('onlyTurn')),
              h(ActionButton, { onClick: () => { void submit('cut') }, disabled: busy, tone: 'danger' }, t('cutAll')),
              h(ActionButton, { onClick: () => setOpen(false), disabled: busy }, t('cancel')),
            ),
            busy ? h('div', { style: { marginTop: '8px', color: 'var(--dsw-alias-label-tertiary, inherit)' } }, t('busy')) : null,
            ),
          )
        }

        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'delete-chat',
          order: 900,
          locale: NS,
        }, TurnDelete))
      },
    }
  },
})

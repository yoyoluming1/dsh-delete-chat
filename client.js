/** Client half of `dsh-delete-chat`: a per-turn delete control in the Chat. */

const NS = 'deleteChat'

const zh = {
  button: '删除对话',
  title: '删除这段对话',
  hint: '删除会新建一个删减后的会话，并把原会话自动归档（可在归档里取消归档恢复）。',
  onlyTurn: '只删除这一轮，保留后面的对话',
  cutAll: '删除这一轮及之后的所有对话',
  cancel: '取消',
  busy: '正在创建新会话…',
  failed: '删除失败：{message}',
  opened: '已创建新会话',
  unavailable: 'Host 插件未启用，删除命令不可用。',
  created: '新会话已创建（{id}），但会话列表还没刷新出来；刷新页面后可以在列表里打开它。',
  settingsLabel: '删除对话按钮',
  settingsHint: '在每一轮回复下显示「删除对话」。关闭后按钮隐藏，避免误操作；随时可以在这里重新打开。',
  settingsOn: '已开启',
  settingsOff: '已关闭',
}

const en = {
  button: 'Delete',
  title: 'Delete this part of the conversation',
  hint: 'Deleting creates a trimmed copy and archives the original; unarchive it later to compare or go back.',
  onlyTurn: 'Delete this turn only, keep later turns',
  cutAll: 'Delete this turn and everything after',
  cancel: 'Cancel',
  busy: 'Creating the new conversation…',
  failed: 'Delete failed: {message}',
  opened: 'New conversation created',
  unavailable: 'The Host plugin is not active, so the delete command is unavailable.',
  created: 'The new conversation was created ({id}) but has not reached the list yet; reload the page and open it from there.',
  settingsLabel: 'Delete control',
  settingsHint: 'Show the delete control under each completed turn. Turn it off to hide the button and avoid accidental deletes.',
  settingsOn: 'On',
  settingsOff: 'Off',
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
      // The Host stored the new Session before settling the command, but the
      // client only knows sessions from its list snapshot. Pull the list once,
      // then open the row; a cold Session that the list still lacks is reported
      // instead of raising an "unknown session" retention error.
      await refreshSessions(ctx)
      if (await waitForSession(ctx, newId)) {
        ctx.uiWorkspace.openSession(newId)
        return { id: newId, opened: true }
      }
      return { id: newId, opened: false }
    }

    /** Refresh the client session list; older services may not expose it. */
    async function refreshSessions(ctx) {
      try {
        if (typeof ctx.sessions.refresh === 'function') await ctx.sessions.refresh()
      } catch {
        // A failed refresh still leaves the wait below to try the current list.
      }
    }

    /** Wait until the Host list carries the new session id. */
    async function waitForSession(ctx, sessionId) {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const list = ctx.sessions.list?.getSnapshot?.()
        if (list?.byId?.[sessionId] !== undefined) return true
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      return false
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

    /**
     * Whether the per-turn control is shown. Stored per browser so the plugin
     * can be switched off when it is not needed, without disabling the whole
     * plugin (which needs a restart to bring the client module back).
     */
    const PREFERENCE = 'dsh-delete-chat:enabled'
    let enabled = readPreference()
    const preferenceListeners = new Set()

    /** Read the stored preference, defaulting to on. */
    function readPreference() {
      try {
        if (typeof localStorage === 'undefined') return true
        return localStorage.getItem(PREFERENCE) !== '0'
      } catch {
        return true
      }
    }

    /** Persist and publish the preference. */
    function writePreference(next) {
      enabled = next
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(PREFERENCE, next ? '1' : '0')
      } catch {
        // A blocked storage area only loses persistence for this page.
      }
      for (const listener of preferenceListeners) listener()
    }

    /** Subscribe one component to the preference. */
    function useEnabled() {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const listener = () => bump(value => value + 1)
        preferenceListeners.add(listener)
        return () => preferenceListeners.delete(listener)
      }, [])
      return enabled
    }

    /** Host-styled switch for the settings row. */
    function Toggle({ checked, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        onClick: () => onChange(!checked),
        style: {
          appearance: 'none',
          position: 'relative',
          width: '36px',
          height: '20px',
          borderRadius: '999px',
          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4))',
          background: checked ? 'var(--dsw-alias-brand-primary, #1d6fe8)' : 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.25))',
          cursor: 'pointer',
          padding: 0,
          flex: '0 0 auto',
        },
      }, h('span', {
        'aria-hidden': true,
        style: {
          position: 'absolute',
          top: '2px',
          left: checked ? '18px' : '2px',
          width: '14px',
          height: '14px',
          borderRadius: '50%',
          background: 'var(--dsw-alias-label-primary-inverted, #fff)',
          transition: 'left 120ms ease',
          display: 'block',
        },
      }))
    }

    /** One preference row in Settings → General. */
    function DeletePreferenceRow({ t }) {
      const on = useEnabled()
      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          padding: '10px 0',
        },
      },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
        h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary, inherit)' } }, t('settingsLabel')),
        h('div', { style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, inherit)' } }, t('settingsHint')),
      ),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto' } },
        h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, inherit)' } }, t(on ? 'settingsOn' : 'settingsOff')),
        h(Toggle, { checked: on, onChange: writePreference }),
      ))
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'delete-chat: locale')

        /** The per-turn control; the panel expands in the turn's own flow. */
        function TurnDelete({ seq, sessionId, t }) {
          const visible = useEnabled()
          const [open, setOpen] = React.useState(false)
          const [busy, setBusy] = React.useState(false)
          const [error, setError] = React.useState(null)
          const [note, setNote] = React.useState(null)
          const submit = async (mode) => {
            setBusy(true)
            setError(null)
            setNote(null)
            try {
              const result = await runDelete(ctx, t, sessionId, mode, seq)
              if (result.opened) {
                setOpen(false)
              } else {
                setNote(t('created').replace('{id}', result.id))
              }
            } catch (reason) {
              setError(String(reason?.message ?? reason))
            } finally {
              setBusy(false)
            }
          }
          if (!visible) return null
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
            note === null ? null : h('div', {
              role: 'status',
              style: { color: 'var(--dsw-alias-label-secondary, inherit)', marginBottom: '8px', lineHeight: '18px' },
            }, note),
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

        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'delete-chat',
          order: 50,
          locale: NS,
        }, DeletePreferenceRow))
      },
    }
  },
})

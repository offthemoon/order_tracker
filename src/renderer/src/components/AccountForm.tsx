import { useState } from 'react'
import type { ImapAccount, PublicAccount } from '@shared/types'

const PRESETS: Record<string, Partial<ImapAccount> & { note?: string }> = {
  Gmail: { host: 'imap.gmail.com', port: 993, secure: true, note: 'Requires 2-Step Verification + an App Password (myaccount.google.com/apppasswords).' },
  Outlook: { host: 'outlook.office365.com', port: 993, secure: true, note: 'Personal Outlook.com accounts may require OAuth; use an app password if available.' },
  Yahoo: { host: 'imap.mail.yahoo.com', port: 993, secure: true, note: 'Generate an app password under Account Security.' },
  iCloud: { host: 'imap.mail.me.com', port: 993, secure: true, note: 'Use an app-specific password from appleid.apple.com.' },
  Custom: {}
}

interface Props {
  initial: PublicAccount | null
  onSaved: (accounts: PublicAccount[]) => void
  onCancel?: () => void
}

/** ipcRenderer.invoke wraps errors as "Error invoking remote method 'x': Error: msg". */
export const ipcError = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')

export default function AccountForm({ initial, onSaved, onCancel }: Props) {
  const [form, setForm] = useState<ImapAccount>({
    id: initial?.id ?? '',
    host: initial?.host ?? 'imap.gmail.com',
    port: initial?.port ?? 993,
    secure: initial?.secure ?? true,
    user: initial?.user ?? '',
    password: '',
    mailbox: initial?.mailbox ?? 'INBOX',
    extraMailboxes: initial?.extraMailboxes ?? [],
    lookbackDays: initial?.lookbackDays ?? 90
  })
  const [preset, setPreset] = useState(initial ? 'Custom' : 'Gmail')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const set = <K extends keyof ImapAccount>(k: K, v: ImapAccount[K]) => setForm(f => ({ ...f, [k]: v }))
  const canSubmit = form.host && form.user && (form.password || initial?.hasPassword)

  const pickPreset = (name: string) => {
    setPreset(name)
    const { note, ...p } = PRESETS[name]
    setForm(f => ({ ...f, ...p }))
    setMsg(note ? { kind: 'info', text: note } : null)
  }

  const test = async () => {
    setBusy(true); setMsg({ kind: 'info', text: 'Connecting…' })
    const r = await window.api.testConnection(form)
    setMsg(r.ok ? { kind: 'ok', text: `Connected. Mailbox "${form.mailbox}" is reachable.` } : { kind: 'err', text: r.error ?? 'Failed' })
    setBusy(false)
  }

  const save = async () => {
    setBusy(true)
    try {
      onSaved(await window.api.saveAccount(form))
    } catch (e) {
      setMsg({ kind: 'err', text: ipcError(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="account-form">
      <h2>{initial ? `Edit ${initial.user}` : 'Add an email account'}</h2>

      <div className="presets">
        {Object.keys(PRESETS).map(p => (
          <button key={p} className={`chip ${preset === p ? 'active' : ''}`} onClick={() => pickPreset(p)}>{p}</button>
        ))}
      </div>

      <div className="grid2">
        <label>Email / username<input value={form.user} onChange={e => set('user', e.target.value)} placeholder="you@gmail.com" autoFocus /></label>
        <label>Password / app password
          <input type="password" value={form.password} onChange={e => set('password', e.target.value)} placeholder={initial?.hasPassword ? '•••••••• (saved; leave blank to keep)' : ''} />
        </label>
        <label>IMAP host<input value={form.host} onChange={e => set('host', e.target.value)} /></label>
        <div className="row">
          <label style={{ flex: 1 }}>Port<input type="number" value={form.port} onChange={e => set('port', Number(e.target.value))} /></label>
          <label className="check"><input type="checkbox" checked={form.secure} onChange={e => set('secure', e.target.checked)} /> SSL/TLS</label>
        </div>
        <label>Mailbox<input value={form.mailbox} onChange={e => set('mailbox', e.target.value)} placeholder="INBOX" /></label>
        <label className="span2">Also sync folders <span className="muted">(comma-separated, e.g. Bulk — optional)</span>
          <input
            value={(form.extraMailboxes ?? []).join(', ')}
            onChange={e => set('extraMailboxes', e.target.value.split(',').map(x => x.trim()).filter(Boolean))}
            placeholder="Bulk, Archive"
          />
        </label>
        <label>Scan last (days)<input type="number" min={1} max={3650} value={form.lookbackDays} onChange={e => set('lookbackDays', Number(e.target.value))} /></label>
      </div>

      {msg && <div className={`notice ${msg.kind}`}>{msg.text}</div>}

      <div className="actions">
        {onCancel && <button className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>}
        <button className="ghost" onClick={test} disabled={busy || !canSubmit}>Test connection</button>
        <button className="primary" onClick={save} disabled={busy || !canSubmit}>{initial ? 'Save' : 'Add account'}</button>
      </div>
    </div>
  )
}

import { useState } from 'react'
import type { Order, PublicAccount } from '@shared/types'
import AccountForm, { ipcError } from './AccountForm'

interface Props {
  accounts: PublicAccount[]
  orders: Order[]
  onAccountsChange: (accounts: PublicAccount[], added: boolean) => void
  onDeleted: (accounts: PublicAccount[], orders: Order[]) => void
  onDone?: () => void
}

/** null = list only, 'new' = add form, otherwise the id being edited. */
type Editing = null | 'new' | string

export default function Accounts({ accounts, orders, onAccountsChange, onDeleted, onDone }: Props) {
  const [editing, setEditing] = useState<Editing>(accounts.length ? null : 'new')
  const [err, setErr] = useState<string | null>(null)

  const orderCount = (id: string) => orders.filter(o => o.accounts?.includes(id)).length

  const remove = async (a: PublicAccount) => {
    const n = orderCount(a.id)
    if (!confirm(`Remove ${a.user}?${n ? ` Orders found only in this inbox (up to ${n}) will be removed too.` : ''}`)) return
    try {
      const r = await window.api.deleteAccount(a.id)
      onDeleted(r.accounts, r.orders)
      if (!r.accounts.length) setEditing('new')
    } catch (e) {
      setErr(ipcError(e))
    }
  }

  const editingAccount = editing && editing !== 'new' ? accounts.find(a => a.id === editing) ?? null : null

  return (
    <div className="settings">
      <div className="settings-head">
        <h1>Email accounts</h1>
        {onDone && accounts.length > 0 && <button className="ghost" onClick={onDone}>Back to dashboard</button>}
      </div>
      <p className="muted">Order Tracker reads order, shipping and cancellation emails over IMAP from every account below. It only reads; it never sends, moves or deletes mail. Passwords are encrypted with your OS keychain.</p>

      {accounts.length > 0 && (
        <ul className="acct-list">
          {accounts.map(a => (
            <li key={a.id} className={editing === a.id ? 'active' : ''}>
              <div>
                <div className="acct-user">{a.user}</div>
                <div className="muted small">{a.host} · {[a.mailbox, ...(a.extraMailboxes ?? [])].join(', ')} · last {a.lookbackDays} days · {orderCount(a.id)} orders</div>
              </div>
              <div className="acct-actions">
                <button className="ghost" onClick={() => setEditing(a.id)}>Edit</button>
                <button className="ghost danger-text" onClick={() => remove(a)}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {err && <div className="notice err">{err}</div>}

      {editing === null ? (
        <div><button className="primary" onClick={() => setEditing('new')}>+ Add another account</button></div>
      ) : (
        <AccountForm
          key={editing}
          initial={editingAccount}
          onSaved={list => { onAccountsChange(list, editing === 'new'); setEditing(null) }}
          onCancel={accounts.length ? () => setEditing(null) : undefined}
        />
      )}
    </div>
  )
}

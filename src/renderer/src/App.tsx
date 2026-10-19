import { useCallback, useEffect, useState } from 'react'
import type { Order, OrderStatus, PublicAccount, SyncProgress } from '@shared/types'
import Accounts from './components/Accounts'
import Dashboard from './components/Dashboard'
import FindMissing from './components/FindMissing'

type View = 'loading' | 'accounts' | 'dashboard' | 'find'

export default function App() {
  const [view, setView] = useState<View>('loading')
  const [accounts, setAccounts] = useState<PublicAccount[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const refresh = useCallback(async () => {
    const a = await window.api.getAccounts()
    setAccounts(a)
    setOrders(await window.api.getOrders())
    return a
  }, [])

  useEffect(() => {
    refresh().then(async a => {
      setView(a.length ? 'dashboard' : 'accounts')
      const n = await window.api.getStoreNotice()
      if (n) setStatus({ kind: 'err', text: n })
    })
    return window.api.onSyncProgress(setProgress)
  }, [refresh])

  const runSync = async () => {
    setSyncing(true); setStatus(null); setProgress(null)
    const r = await window.api.sync()
    setOrders(await window.api.getOrders())
    setSyncing(false); setProgress(null)
    const summary = `Scanned ${r.scanned} new emails across ${r.accounts.length} account${r.accounts.length === 1 ? '' : 's'} · ${r.matched} order updates · ${r.orders} orders total`
    setStatus(r.error ? { kind: 'err', text: r.accounts.length ? `${summary}. Problem: ${r.error}` : r.error } : { kind: 'ok', text: summary })
  }

  const setOrderStatus = async (id: string, s: OrderStatus) => setOrders(await window.api.setOrderStatus(id, s))
  const setOrderStatuses = async (ids: string[], s: OrderStatus | 'auto') => setOrders(await window.api.setOrderStatuses(ids, s))
  const deleteOrder = async (id: string) => setOrders(await window.api.deleteOrder(id))
  const deleteOrders = async (ids: string[]) => setOrders(await window.api.deleteOrders(ids))
  const clearAll = async () => {
    if (confirm('Clear all orders and rescan every account from scratch on next sync?')) setOrders(await window.api.clearOrders())
  }

  const syncLabel = () => {
    if (!syncing) return 'Sync'
    if (!progress) return 'Syncing…'
    const who = progress.count > 1 ? `${progress.index}/${progress.count} ` : ''
    return progress.total ? `Syncing ${who}· ${progress.done}/${progress.total}` : `Syncing ${who}…`
  }

  if (view === 'loading') return null

  return (
    <div className="app">
      <header>
        <div className="brand"><span className="logo">◧</span> Order Tracker</div>
        {view === 'dashboard' && (
          <div className="head-actions">
            <span className="muted small" title={accounts.map(a => a.user).join('\n')}>
              {accounts.length === 1 ? `${accounts[0].user} · ${accounts[0].mailbox}` : `${accounts.length} accounts`}
            </span>
            <button className="ghost" onClick={clearAll} disabled={syncing}>Reset</button>
            <button className="ghost" onClick={() => setView('find')} disabled={syncing}>Find missing</button>
            <button className="ghost" onClick={() => setView('accounts')} disabled={syncing}>Accounts</button>
            <button className="primary" onClick={runSync} disabled={syncing} title={progress?.account}>{syncLabel()}</button>
          </div>
        )}
      </header>

      {status && view === 'dashboard' && (
        <div className={`notice ${status.kind} banner`} onClick={() => setStatus(null)}>{status.text}</div>
      )}

      {view === 'find' ? (
        <FindMissing
          onAccountsChange={setAccounts}
          onSync={() => { setView('dashboard'); runSync() }}
          onDone={() => setView('dashboard')}
        />
      ) : view === 'accounts' ? (
        <Accounts
          accounts={accounts}
          orders={orders}
          onAccountsChange={(list, added) => {
            setAccounts(list)
            // New inbox: jump to the dashboard and pull its orders in.
            if (added) { setView('dashboard'); runSync() }
          }}
          onDeleted={(list, o) => { setAccounts(list); setOrders(o) }}
          onDone={() => setView('dashboard')}
        />
      ) : (
        <Dashboard orders={orders} accounts={accounts} onSetStatus={setOrderStatus} onSetStatuses={setOrderStatuses} onDelete={deleteOrder} onDeleteMany={deleteOrders} />
      )}
    </div>
  )
}

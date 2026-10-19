import { useState } from 'react'
import type { DiagnoseHit, DiagnoseResult, DiagnoseVerdict, PublicAccount } from '@shared/types'
import { fmtDate } from '../status'
import { ipcError } from './AccountForm'

const VERDICT: Record<DiagnoseVerdict, { label: string; color: string }> = {
  tracked: { label: 'Already tracked', color: '#3ecf8e' },
  will_add: { label: 'Added on next sync', color: '#3fb6e8' },
  wrong_folder: { label: 'Folder not synced', color: '#f0b429' },
  skipped: { label: 'Skipped by parser', color: '#ef5b5b' }
}

interface Props {
  onAccountsChange: (accounts: PublicAccount[]) => void
  onSync: () => void
  onDone: () => void
}

export default function FindMissing({ onAccountsChange, onSync, onDone }: Props) {
  const [term, setTerm] = useState('')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<DiagnoseResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState(false)

  const search = async () => {
    setBusy(true); setErr(null); setRes(null); setCopied(false)
    try {
      setRes(await window.api.diagnose(term))
    } catch (e) {
      setErr(ipcError(e))
    } finally {
      setBusy(false)
    }
  }

  const addFolder = async (h: DiagnoseHit) => {
    try {
      onAccountsChange(await window.api.addFolder(h.accountId, h.folder))
      setAdded(prev => new Set(prev).add(`${h.accountId}|${h.folder}`))
    } catch (e) {
      setErr(ipcError(e))
    }
  }

  const copyReport = async () => {
    if (!res) return
    const lines = [
      `Find missing orders: "${term}" — ${res.hits.length} emails, ${res.foldersSearched} folders searched`,
      ...res.errors.map(e => `ERROR ${e}`),
      ...res.hits.map((h, i) => [
        ``,
        `#${i + 1} [${VERDICT[h.verdict].label}] ${fmtDate(h.date)} · ${h.account} · folder "${h.folder}"`,
        `From: ${h.from}`,
        `Subject: ${h.subject}`,
        `Parser: order ${h.orderNumber ?? 'none'}, status ${h.status}. ${h.reason}`,
        `Body: ${h.snippet}`
      ].join('\n'))
    ]
    await navigator.clipboard.writeText(lines.join('\n'))
    setCopied(true)
  }

  const pendingFolderAdds = added.size > 0
  const counts = res?.hits.reduce<Record<string, number>>((m, h) => ({ ...m, [h.verdict]: (m[h.verdict] ?? 0) + 1 }), {}) ?? {}

  return (
    <div className="settings wide">
      <div className="settings-head">
        <h1>Find missing orders</h1>
        <button className="ghost" onClick={onDone}>Back to dashboard</button>
      </div>
      <p className="muted">
        Searches <strong>every folder</strong> of every account (including spam/bulk) for emails whose sender or subject contains your text,
        within each account's scan window, and shows what sync does with each one. Read-only.
      </p>

      <form className="row" onSubmit={e => { e.preventDefault(); search() }}>
        <input value={term} onChange={e => setTerm(e.target.value)} placeholder="Store name or sender, e.g. pokemon" autoFocus />
        <button className="primary" type="submit" disabled={busy || term.trim().length < 2} style={{ whiteSpace: 'nowrap' }}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>

      {err && <div className="notice err">{err}</div>}

      {res && (
        <>
          <div className="diag-summary">
            <span className="muted small">
              {res.hits.length} email{res.hits.length === 1 ? '' : 's'} in {res.foldersSearched} folders
              {res.truncated && ' (showing newest 40 per account)'}
            </span>
            {(Object.keys(VERDICT) as DiagnoseVerdict[]).filter(v => counts[v]).map(v => (
              <span key={v} className="badge" style={{ color: VERDICT[v].color, background: `${VERDICT[v].color}1f` }}>{counts[v]} {VERDICT[v].label.toLowerCase()}</span>
            ))}
            {res.hits.length > 0 && <button className="ghost small-btn push" onClick={copyReport}>{copied ? 'Copied ✓' : 'Copy report'}</button>}
          </div>
          {copied && <div className="notice info">Report copied. It includes the start of each email body; check it before sharing.</div>}
          {res.errors.map(e => <div key={e} className="notice err">{e}</div>)}
          {pendingFolderAdds && (
            <div className="notice ok row-between">
              Folder added. Sync to pull those orders in.
              <button className="primary small-btn" onClick={onSync}>Sync now</button>
            </div>
          )}
          {res.hits.length === 0 && !res.errors.length && (
            <div className="empty">No emails from or about "{term}" in any folder within the scan window. Check the spelling, or raise "Scan last (days)" on the account.</div>
          )}

          <ul className="diag-list">
            {res.hits.map((h, i) => {
              const v = VERDICT[h.verdict]
              const folderKey = `${h.accountId}|${h.folder}`
              return (
                <li key={i} style={{ borderLeftColor: v.color }}>
                  <div className="diag-top">
                    <span className="badge" style={{ color: v.color, background: `${v.color}1f` }}>{v.label}</span>
                    <span className="muted small">{fmtDate(h.date)} · {h.account} · {h.folder}</span>
                  </div>
                  <div className="diag-subject">{h.subject || '(no subject)'}</div>
                  <div className="muted small">{h.from}</div>
                  <div className="diag-reason">{h.reason}</div>
                  {h.verdict === 'wrong_folder' && (
                    added.has(folderKey)
                      ? <span className="small" style={{ color: '#3ecf8e' }}>✓ "{h.folder}" will be synced</span>
                      : <button className="ghost small-btn" onClick={() => addFolder(h)}>Also sync "{h.folder}" for {h.account}</button>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}

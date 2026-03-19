import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, SessionRow } from '../lib/api'
import { fmtTokens, fmtCost, fmtRelative, fmtDuration, shortId } from '../lib/format'
import { Filter, X } from 'lucide-react'

const SORT_OPTIONS = [
  { value: 'tokens', label: 'Tokens' },
  { value: 'cost', label: 'Cost' },
  { value: 'calls', label: 'Calls' },
]

const PAGE_SIZE = 50

export default function Sessions() {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)

  const [filterChannel, setFilterChannel] = useState('')
  const [filterModel, setFilterModel] = useState('')
  const [sort, setSort] = useState('tokens')
  const [channels, setChannels] = useState<string[]>([])
  const [models, setModels] = useState<string[]>([])

  // Load filter options once
  useEffect(() => {
    Promise.all([api.channels(), api.models()]).then(([chs, mds]) => {
      setChannels(chs.map((c) => c.channel))
      setModels(mds.map((m) => m.model))
    })
  }, [])

  // Load sessions on filter change
  useEffect(() => {
    setLoading(true)
    api.sessions({
      channel: filterChannel || undefined,
      model: filterModel || undefined,
      sort,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    })
      .then(({ sessions, total }) => { setSessions(sessions); setTotal(total) })
      .finally(() => setLoading(false))
  }, [filterChannel, filterModel, sort, page])

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="p-6 space-y-4 fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold" style={{ fontFamily: 'Barlow Condensed', color: 'var(--text-primary)', letterSpacing: '0.04em' }}>
            SESSIONS
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
            {total.toLocaleString()} sessions total
          </p>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2">
          <Filter size={12} style={{ color: 'var(--text-muted)' }} />

          <select
            value={filterChannel}
            onChange={(e) => { setFilterChannel(e.target.value); setPage(0) }}
            className="text-xs px-2 py-1.5 rounded-sm"
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-default)',
              color: filterChannel ? 'var(--text-primary)' : 'var(--text-muted)',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            <option value="">All channels</option>
            {channels.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>

          <select
            value={filterModel}
            onChange={(e) => { setFilterModel(e.target.value); setPage(0) }}
            className="text-xs px-2 py-1.5 rounded-sm"
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-default)',
              color: filterModel ? 'var(--text-primary)' : 'var(--text-muted)',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            <option value="">All models</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>

          <select
            value={sort}
            onChange={(e) => { setSort(e.target.value); setPage(0) }}
            className="text-xs px-2 py-1.5 rounded-sm"
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-default)',
              color: 'var(--text-secondary)',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>Sort: {o.label}</option>)}
          </select>

          {(filterChannel || filterModel) && (
            <button
              onClick={() => { setFilterChannel(''); setFilterModel(''); setPage(0) }}
              className="flex items-center gap-1 px-2 py-1.5 rounded-sm text-xs"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-muted)', cursor: 'pointer' }}
            >
              <X size={10} /> Clear
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Session ID</th>
              <th>Channel</th>
              <th>Agent</th>
              <th>Models</th>
              <th style={{ textAlign: 'right' }}>Calls</th>
              <th style={{ textAlign: 'right' }}>Tokens</th>
              <th style={{ textAlign: 'right' }}>Est. Cost</th>
              <th style={{ textAlign: 'right' }}>Duration</th>
              <th style={{ textAlign: 'right' }}>Last Active</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => {
              const duration = s.lastAt - s.firstAt
              const modelList = s.models ? s.models.split(',') : []
              return (
                <tr key={s.session_id}>
                  <td>
                    <Link
                      to={`/sessions/${s.session_id}`}
                      className="num hover:underline"
                      style={{ color: 'var(--teal)', fontSize: '11px' }}
                    >
                      {shortId(s.session_id)}
                    </Link>
                  </td>
                  <td>
                    <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{s.channel}</span>
                  </td>
                  <td>
                    <span className="text-2xs" style={{ color: 'var(--text-muted)' }}>{s.agent || '—'}</span>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {modelList.slice(0, 2).map((m) => (
                        <span
                          key={m}
                          className="text-2xs px-1.5 py-0.5 rounded-sm truncate"
                          style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)', maxWidth: 100 }}
                        >
                          {m.split('/').pop()}
                        </span>
                      ))}
                      {modelList.length > 2 && (
                        <span className="text-2xs" style={{ color: 'var(--text-muted)' }}>+{modelList.length - 2}</span>
                      )}
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="num text-xs" style={{ color: 'var(--text-secondary)' }}>{s.calls}</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="num text-xs" style={{ color: 'var(--amber)' }}>{fmtTokens(s.tokens)}</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="num text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {fmtCost(s.cost)}<span style={{ color: 'var(--text-muted)', fontSize: '9px' }}> ~</span>
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                      {duration > 0 ? fmtDuration(duration) : '—'}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{fmtRelative(s.lastAt)}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {!loading && sessions.length === 0 && (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
            No sessions match your filters.
          </div>
        )}

        {loading && (
          <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: '11px' }}>
            Loading…
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
            Page {page + 1} of {totalPages} · {total.toLocaleString()} sessions
          </span>
          <div className="flex gap-2">
            <PaginBtn label="← prev" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))} />
            <PaginBtn label="next →" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)} />
          </div>
        </div>
      )}
    </div>
  )
}

function PaginBtn({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="text-xs px-3 py-1.5 rounded-sm"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
        color: disabled ? 'var(--text-muted)' : 'var(--text-secondary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {label}
    </button>
  )
}

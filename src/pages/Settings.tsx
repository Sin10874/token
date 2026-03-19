import { useEffect, useState } from 'react'
import { api, PriceRow, HealthData, IngestionStats } from '../lib/api'
import { fmtRelative } from '../lib/format'
import { CheckCircle, AlertCircle, RefreshCw, Database } from 'lucide-react'

export default function Settings() {
  const [prices, setPrices] = useState<PriceRow[]>([])
  const [health, setHealth] = useState<HealthData | null>(null)
  const [loading, setLoading] = useState(true)
  const [editRow, setEditRow] = useState<string | null>(null)
  const [editValues, setEditValues] = useState({ inputPrice: 0, outputPrice: 0, cacheReadPrice: 0, cacheWritePrice: 0 })
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<IngestionStats | null>(null)

  const load = () => {
    Promise.all([api.prices(), api.health()])
      .then(([p, h]) => { setPrices(p); setHealth(h) })
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const startEdit = (row: PriceRow) => {
    setEditRow(row.model_id)
    setEditValues({
      inputPrice: row.input_price,
      outputPrice: row.output_price,
      cacheReadPrice: row.cache_read_price,
      cacheWritePrice: row.cache_write_price,
    })
    setSaveMsg(null)
  }

  const saveEdit = async () => {
    if (!editRow) return
    setSaving(true)
    try {
      await api.updatePrice(editRow, editValues)
      setSaveMsg('Saved')
      setEditRow(null)
      load()
    } catch (e) {
      setSaveMsg('Error saving')
    } finally {
      setSaving(false)
    }
  }

  const handleSync = async (full: boolean) => {
    setSyncing(true)
    setSyncResult(null)
    try {
      const result = full ? await api.fullIngest() : await api.ingest()
      setSyncResult(result.stats)
      load()
    } finally {
      setSyncing(false)
    }
  }

  if (loading) return (
    <div className="p-6" style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Loading…</div>
  )

  const warningCount = health?.warnings?.length || 0

  return (
    <div className="p-6 space-y-6 fade-in">
      <h1 className="text-lg font-semibold" style={{ fontFamily: 'Barlow Condensed', color: 'var(--text-primary)', letterSpacing: '0.04em' }}>
        SETTINGS
      </h1>

      {/* Data Health */}
      <section>
        <SectionHeader label="Data Health" />
        <div className="grid grid-cols-3 gap-3 mb-3">
          {[
            { label: 'Total Events', value: (health?.totalEvents || 0).toLocaleString(), icon: Database },
            { label: 'Sessions Indexed', value: (health?.totalSessions || 0).toLocaleString(), icon: Database },
            {
              label: 'Last Ingestion',
              value: health?.lastScanAt ? fmtRelative(health.lastScanAt) : 'Never',
              icon: RefreshCw,
            },
          ].map((s) => (
            <div key={s.label} className="card p-4 flex items-center gap-3">
              <s.icon size={16} style={{ color: 'var(--amber)', opacity: 0.7 }} />
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</div>
                <div className="num text-base mt-0.5" style={{ color: 'var(--text-primary)' }}>{s.value}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Source files */}
        <div className="card mb-3">
          <div className="px-4 pt-3 pb-2" style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Indexed Sources
          </div>
          {health?.states && health.states.length > 0 ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Source Path</th>
                  <th style={{ textAlign: 'right' }}>Lines Read</th>
                  <th style={{ textAlign: 'right' }}>Events</th>
                  <th style={{ textAlign: 'right' }}>Last Scanned</th>
                </tr>
              </thead>
              <tbody>
                {health.states.map((s) => (
                  <tr key={s.source_path}>
                    <td>
                      <span className="num text-2xs" style={{ color: 'var(--text-secondary)' }}>
                        {s.source_path.replace(/.*\.openclaw/, '~/.openclaw')}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="num text-xs" style={{ color: 'var(--text-secondary)' }}>{s.last_processed_lines.toLocaleString()}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="num text-xs" style={{ color: 'var(--amber)' }}>{s.event_count.toLocaleString()}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                        {s.last_scan_at ? fmtRelative(s.last_scan_at) : '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ padding: '16px 24px', color: 'var(--text-muted)', fontSize: '11px' }}>
              No sources indexed yet. Run ingestion below.
            </div>
          )}
        </div>

        {/* Warnings */}
        {warningCount > 0 && (
          <div className="card mb-3" style={{ borderColor: 'var(--rose-dim)' }}>
            <div className="px-4 pt-3 pb-2 flex items-center gap-2" style={{ color: 'var(--rose)', fontSize: '11px' }}>
              <AlertCircle size={12} /> {warningCount} parse warnings
            </div>
            <div className="px-4 pb-3 space-y-1">
              {health?.warnings?.slice(0, 10).map((w) => (
                <div key={w.id} className="text-2xs" style={{ color: 'var(--text-muted)' }}>
                  {w.source_path.split('/').pop()}: {w.warning}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Sync controls */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => handleSync(false)}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 rounded-sm text-xs font-medium"
            style={{
              background: syncing ? 'var(--bg-elevated)' : 'var(--amber-bg)',
              border: '1px solid var(--amber-dim)',
              color: syncing ? 'var(--text-muted)' : 'var(--amber)',
              cursor: syncing ? 'not-allowed' : 'pointer',
            }}
          >
            <RefreshCw size={11} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing…' : 'Sync (incremental)'}
          </button>
          <button
            onClick={() => handleSync(true)}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 rounded-sm text-xs"
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-default)',
              color: 'var(--text-secondary)',
              cursor: syncing ? 'not-allowed' : 'pointer',
            }}
          >
            Full re-index
          </button>
          {syncResult && (
            <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
              +{syncResult.eventsInserted} events · {syncResult.filesProcessed} files · {syncResult.duration}ms
            </span>
          )}
        </div>
      </section>

      {/* Price Table */}
      <section>
        <SectionHeader label="Model Price Table" note="All prices in USD per 1M tokens. ~ = estimated." />

        {saveMsg && (
          <div
            className="flex items-center gap-2 mb-3 px-3 py-2 rounded-sm text-xs"
            style={{
              background: saveMsg === 'Saved' ? 'var(--green-dim)' : 'var(--rose-dim)',
              color: saveMsg === 'Saved' ? 'var(--green)' : 'var(--rose)',
              border: `1px solid ${saveMsg === 'Saved' ? 'var(--green-dim)' : 'var(--rose-dim)'}`,
            }}
          >
            <CheckCircle size={11} /> {saveMsg}
          </div>
        )}

        <div className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Provider</th>
                <th style={{ textAlign: 'right' }}>Input $/M</th>
                <th style={{ textAlign: 'right' }}>Output $/M</th>
                <th style={{ textAlign: 'right' }}>Cache Read $/M</th>
                <th style={{ textAlign: 'right' }}>Cache Write $/M</th>
                <th>Source</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {prices.map((row) => {
                const isEditing = editRow === row.model_id
                return (
                  <tr key={row.model_id}>
                    <td>
                      <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                        {row.model_id}
                      </span>
                    </td>
                    <td>
                      <span className="text-2xs" style={{ color: 'var(--text-muted)' }}>{row.provider}</span>
                    </td>
                    {isEditing ? (
                      <>
                        {(['inputPrice', 'outputPrice', 'cacheReadPrice', 'cacheWritePrice'] as const).map((key) => (
                          <td key={key} style={{ textAlign: 'right', padding: '4px 8px' }}>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={editValues[key]}
                              onChange={(e) => setEditValues((v) => ({ ...v, [key]: parseFloat(e.target.value) || 0 }))}
                              className="num text-xs text-right w-20 px-2 py-0.5 rounded-sm"
                              style={{
                                background: 'var(--bg-base)',
                                border: '1px solid var(--amber-dim)',
                                color: 'var(--amber)',
                                outline: 'none',
                              }}
                            />
                          </td>
                        ))}
                      </>
                    ) : (
                      <>
                        <PriceCell value={row.input_price} />
                        <PriceCell value={row.output_price} />
                        <PriceCell value={row.cache_read_price} />
                        <PriceCell value={row.cache_write_price} />
                      </>
                    )}
                    <td>
                      <span
                        className="text-2xs px-1.5 py-0.5 rounded-sm"
                        style={{
                          background: 'var(--bg-elevated)',
                          color: row.source === 'manual' ? 'var(--teal)' : 'var(--text-muted)',
                        }}
                      >
                        {row.source}
                      </span>
                    </td>
                    <td>
                      {isEditing ? (
                        <div className="flex gap-1.5">
                          <ActionBtn
                            label={saving ? '…' : 'Save'}
                            color="var(--amber)"
                            onClick={saveEdit}
                            disabled={saving}
                          />
                          <ActionBtn label="Cancel" color="var(--text-muted)" onClick={() => setEditRow(null)} />
                        </div>
                      ) : (
                        <ActionBtn label="Edit" color="var(--text-muted)" onClick={() => startEdit(row)} />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {prices.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
              No prices loaded.
            </div>
          )}
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: '10px', marginTop: 8 }}>
          Editing a row marks it as 'manual' and prevents auto-overwrite from openclaw.json.
          Token cost in session files takes precedence when available.
        </p>
      </section>
    </div>
  )
}

function PriceCell({ value }: { value: number }) {
  return (
    <td style={{ textAlign: 'right' }}>
      <span className="num text-xs" style={{ color: value > 0 ? 'var(--amber)' : 'var(--text-muted)' }}>
        {value > 0 ? `$${value}` : '—'}
      </span>
    </td>
  )
}

function ActionBtn({
  label, color, onClick, disabled,
}: {
  label: string; color: string; onClick: () => void; disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="text-2xs px-2 py-0.5 rounded-sm"
      style={{
        border: '1px solid var(--border-default)',
        background: 'var(--bg-elevated)',
        color,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {label}
    </button>
  )
}

function SectionHeader({ label, note }: { label: string; note?: string }) {
  return (
    <div className="mb-3">
      <h2 style={{ fontFamily: 'Barlow Condensed', color: 'var(--text-primary)', letterSpacing: '0.04em', fontSize: '15px', fontWeight: 600 }}>
        {label}
      </h2>
      {note && <p style={{ color: 'var(--text-muted)', fontSize: '10px', marginTop: 2 }}>{note}</p>}
    </div>
  )
}

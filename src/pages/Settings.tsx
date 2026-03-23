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
      setSaveMsg('已保存')
      setEditRow(null)
      load()
    } catch (e) {
      setSaveMsg('保存失败')
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
    <div className="p-6" style={{ color: 'var(--text-muted)', fontSize: '12px' }}>加载中…</div>
  )

  const warningCount = health?.warnings?.length || 0

  return (
    <div className="p-6 space-y-6 fade-in">
      <h1 className="text-lg font-semibold" style={{ fontFamily: 'Barlow Condensed', color: 'var(--text-primary)', letterSpacing: '0.04em' }}>
        设置
      </h1>

      {/* Data Health */}
      <section>
        <SectionHeader label="数据健康" />
        <div className="grid grid-cols-3 gap-3 mb-3">
          {[
            { label: '总事件数', value: (health?.totalEvents || 0).toLocaleString(), icon: Database },
            { label: '已索引会话', value: (health?.totalSessions || 0).toLocaleString(), icon: Database },
            {
              label: '最近导入',
              value: health?.lastScanAt ? fmtRelative(health.lastScanAt) : '从未',
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
            已索引数据源
          </div>
          {health?.states && health.states.length > 0 ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>源路径</th>
                  <th style={{ textAlign: 'right' }}>已读行数</th>
                  <th style={{ textAlign: 'right' }}>事件数</th>
                  <th style={{ textAlign: 'right' }}>最近扫描</th>
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
              尚未索引任何数据源。请在下方运行导入。
            </div>
          )}
        </div>

        {/* Warnings */}
        {warningCount > 0 && (
          <div className="card mb-3" style={{ borderColor: 'var(--rose-dim)' }}>
            <div className="px-4 pt-3 pb-2 flex items-center gap-2" style={{ color: 'var(--rose)', fontSize: '11px' }}>
              <AlertCircle size={12} /> {warningCount} 个解析警告
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
            {syncing ? '同步中…' : '增量同步'}
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
            全量重建索引
          </button>
          {syncResult && (
            <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
              +{syncResult.eventsInserted} 事件 · {syncResult.filesProcessed} 文件 · {syncResult.duration}ms
            </span>
          )}
        </div>
      </section>

      {/* Price Table */}
      <section>
        <SectionHeader label="模型价格表" note="所有价格单位为 USD / 百万 Token。~ = 预估值。" />

        {saveMsg && (
          <div
            className="flex items-center gap-2 mb-3 px-3 py-2 rounded-sm text-xs"
            style={{
              background: saveMsg === '已保存' ? 'var(--green-dim)' : 'var(--rose-dim)',
              color: saveMsg === '已保存' ? 'var(--green)' : 'var(--rose)',
              border: `1px solid ${saveMsg === '已保存' ? 'var(--green-dim)' : 'var(--rose-dim)'}`,
            }}
          >
            <CheckCircle size={11} /> {saveMsg}
          </div>
        )}

        <div className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>提供商</th>
                <th style={{ textAlign: 'right' }}>输入 $/M</th>
                <th style={{ textAlign: 'right' }}>输出 $/M</th>
                <th style={{ textAlign: 'right' }}>缓存读取 $/M</th>
                <th style={{ textAlign: 'right' }}>缓存写入 $/M</th>
                <th>来源</th>
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
                            label={saving ? '…' : '保存'}
                            color="var(--amber)"
                            onClick={saveEdit}
                            disabled={saving}
                          />
                          <ActionBtn label="取消" color="var(--text-muted)" onClick={() => setEditRow(null)} />
                        </div>
                      ) : (
                        <ActionBtn label="编辑" color="var(--text-muted)" onClick={() => startEdit(row)} />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {prices.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
              暂无价格数据。
            </div>
          )}
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: '10px', marginTop: 8 }}>
          手动编辑后标记为 'manual'，不会被 openclaw.json 自动覆盖。
          会话文件中包含的 Token 成本优先使用。
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

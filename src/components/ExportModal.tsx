import { useEffect, useState, useCallback } from 'react'
import { Download, X, ChevronDown, Calendar, Check } from 'lucide-react'
import { api } from '../lib/api'

interface ExportModalProps {
  isOpen: boolean
  onClose: () => void
}

type TimeRange = '7d' | '30d' | 'month' | 'custom'

export default function ExportModal({ isOpen, onClose }: ExportModalProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>('7d')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const [selectedChannels, setSelectedChannels] = useState<string[]>([])
  const [allModels, setAllModels] = useState<string[]>([])
  const [allChannels, setAllChannels] = useState<string[]>([])
  const [count, setCount] = useState<number | null>(null)
  const [loadingCount, setLoadingCount] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [modelsOpen, setModelsOpen] = useState(false)
  const [channelsOpen, setChannelsOpen] = useState(false)

  // Load all models and channels
  useEffect(() => {
    if (!isOpen) return
    api.models().then((models) => {
      setAllModels(models.map((m) => m.model))
    })
    api.channels().then((channels) => {
      setAllChannels(channels.map((c) => c.channel))
    })
  }, [isOpen])

  const buildParams = useCallback(() => {
    const now = new Date()
    let startDate = ''
    let endDate = ''

    if (timeRange === '7d') {
      const d = new Date(now)
      d.setDate(d.getDate() - 6)
      startDate = d.toISOString().slice(0, 10)
      endDate = now.toISOString().slice(0, 10)
    } else if (timeRange === '30d') {
      const d = new Date(now)
      d.setDate(d.getDate() - 29)
      startDate = d.toISOString().slice(0, 10)
      endDate = now.toISOString().slice(0, 10)
    } else if (timeRange === 'month') {
      startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
      endDate = now.toISOString().slice(0, 10)
    } else {
      startDate = customStart
      endDate = customEnd
    }

    const models = selectedModels.length === allModels.length || selectedModels.length === 0
      ? ''
      : selectedModels.join(',')
    const channels = selectedChannels.length === allChannels.length || selectedChannels.length === 0
      ? ''
      : selectedChannels.join(',')

    return { startDate, endDate, models, channels }
  }, [timeRange, customStart, customEnd, selectedModels, selectedChannels, allModels, allChannels])

  // Fetch count when params change
  useEffect(() => {
    if (!isOpen) return
    const { startDate, endDate, models, channels } = buildParams()
    if (!startDate && !endDate && !models && !channels) {
      setCount(null)
      return
    }
    setLoadingCount(true)
    const q = new URLSearchParams()
    if (startDate) q.set('startDate', startDate)
    if (endDate) q.set('endDate', endDate)
    if (models) q.set('models', models)
    if (channels) q.set('channels', channels)

    fetch(`/api/export/count?${q}`)
      .then((r) => r.json())
      .then((d) => setCount(d.count))
      .catch(() => setCount(null))
      .finally(() => setLoadingCount(false))
  }, [isOpen, buildParams])

  const handleExport = async () => {
    setExporting(true)
    try {
      const { startDate, endDate, models, channels } = buildParams()
      const q = new URLSearchParams()
      if (startDate) q.set('startDate', startDate)
      if (endDate) q.set('endDate', endDate)
      if (models) q.set('models', models)
      if (channels) q.set('channels', channels)

      const res = await fetch(`/api/export?${q}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const dateStr = new Date().toISOString().slice(0, 10)
      a.href = url
      a.download = `tokend-export-${dateStr}.csv`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      onClose()
    } catch (e) {
      console.error('Export failed:', e)
    } finally {
      setExporting(false)
    }
  }

  const toggleModel = (m: string) => {
    setSelectedModels((prev) =>
      prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]
    )
  }

  const toggleChannel = (c: string) => {
    setSelectedChannels((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]
    )
  }

  const selectAllModels = () => {
    setSelectedModels(allModels.length === selectedModels.length || selectedModels.length === allModels.length ? [] : [...allModels])
  }

  const selectAllChannels = () => {
    setSelectedChannels(allChannels.length === selectedChannels.length || selectedChannels.length === allChannels.length ? [] : [...allChannels])
  }

  if (!isOpen) return null

  const canExport = count !== null && count > 0 && !exporting

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        style={{ background: 'rgba(0,0,0,0.4)' }}
      />

      {/* Modal */}
      <div
        className="fixed z-50 w-[420px] rounded-sm shadow-xl"
        style={{
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b"
          style={{ borderColor: 'var(--border-default)' }}
        >
          <div className="flex items-center gap-2">
            <Download size={14} strokeWidth={1.8} style={{ color: 'var(--amber)' }} />
            <span
              className="text-sm font-semibold"
              style={{ fontFamily: 'Barlow Condensed', letterSpacing: '0.04em', color: 'var(--text-primary)' }}
            >
              导出数据
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-sm transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-surface)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <X size={14} strokeWidth={1.8} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* Time range */}
          <div>
            <label
              className="block mb-2 text-xs"
              style={{ color: 'var(--text-secondary)', letterSpacing: '0.06em', textTransform: 'uppercase' }}
            >
              时间范围
            </label>
            <div className="flex flex-wrap gap-2">
              {([
                { value: '7d', label: '近7天' },
                { value: '30d', label: '近30天' },
                { value: 'month', label: '本月' },
                { value: 'custom', label: '自定义' },
              ] as const).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setTimeRange(opt.value)}
                  className="px-3 py-1.5 text-xs rounded-sm transition-colors"
                  style={{
                    fontFamily: 'Barlow',
                    background: timeRange === opt.value ? 'var(--amber-bg)' : 'var(--bg-surface)',
                    color: timeRange === opt.value ? 'var(--amber)' : 'var(--text-secondary)',
                    border: `1px solid ${timeRange === opt.value ? 'var(--amber-dim)' : 'var(--border-default)'}`,
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Custom date inputs */}
            {timeRange === 'custom' && (
              <div className="flex gap-2 mt-2">
                <div className="flex-1">
                  <label className="block mb-1 text-xs" style={{ color: 'var(--text-muted)' }}>开始</label>
                  <input
                    type="date"
                    value={customStart}
                    onChange={(e) => setCustomStart(e.target.value)}
                    className="w-full px-2 py-1.5 text-xs rounded-sm outline-none"
                    style={{
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border-default)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>
                <div className="flex-1">
                  <label className="block mb-1 text-xs" style={{ color: 'var(--text-muted)' }}>结束</label>
                  <input
                    type="date"
                    value={customEnd}
                    onChange={(e) => setCustomEnd(e.target.value)}
                    className="w-full px-2 py-1.5 text-xs rounded-sm outline-none"
                    style={{
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border-default)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Model filter */}
          <div>
            <label
              className="block mb-2 text-xs"
              style={{ color: 'var(--text-secondary)', letterSpacing: '0.06em', textTransform: 'uppercase' }}
            >
              模型筛选
            </label>
            <div className="relative">
              <button
                onClick={() => { setModelsOpen(!modelsOpen); setChannelsOpen(false) }}
                className="flex items-center justify-between w-full px-3 py-1.5 text-xs rounded-sm transition-colors"
                style={{
                  background: 'var(--bg-surface)',
                  border: `1px solid ${modelsOpen ? 'var(--amber-dim)' : 'var(--border-default)'}`,
                  color: 'var(--text-primary)',
                }}
              >
                <span>
                  {selectedModels.length === 0 || selectedModels.length === allModels.length
                    ? `全部模型 (${allModels.length})`
                    : `已选 ${selectedModels.length} 个模型`}
                </span>
                <ChevronDown size={11} strokeWidth={1.8} style={{ color: 'var(--text-muted)', transform: modelsOpen ? 'rotate(180deg)' : 'none' }} />
              </button>

              {modelsOpen && (
                <div
                  className="absolute z-10 w-full mt-1 rounded-sm shadow-lg max-h-48 overflow-auto"
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-default)',
                  }}
                >
                  <button
                    onClick={selectAllModels}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-xs transition-colors"
                    style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-subtle)' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-surface)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div
                      className="w-3 h-3 rounded-sm border flex items-center justify-center"
                      style={{ borderColor: selectedModels.length === allModels.length || selectedModels.length === 0 ? 'var(--amber)' : 'var(--border-default)', background: selectedModels.length === allModels.length || selectedModels.length === 0 ? 'var(--amber-bg)' : 'transparent' }}
                    >
                      {(selectedModels.length === allModels.length || selectedModels.length === 0) && <Check size={9} strokeWidth={2} style={{ color: 'var(--amber)' }} />}
                    </div>
                    全部模型
                  </button>
                  {allModels.map((m) => (
                    <button
                      key={m}
                      onClick={() => toggleModel(m)}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-xs transition-colors"
                      style={{ color: 'var(--text-primary)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-surface)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <div
                        className="w-3 h-3 rounded-sm border flex items-center justify-center"
                        style={{
                          borderColor: selectedModels.includes(m) ? 'var(--amber)' : 'var(--border-default)',
                          background: selectedModels.includes(m) ? 'var(--amber-bg)' : 'transparent',
                        }}
                      >
                        {selectedModels.includes(m) && <Check size={9} strokeWidth={2} style={{ color: 'var(--amber)' }} />}
                      </div>
                      <span className="truncate">{m}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Channel filter */}
          <div>
            <label
              className="block mb-2 text-xs"
              style={{ color: 'var(--text-secondary)', letterSpacing: '0.06em', textTransform: 'uppercase' }}
            >
              Channel 筛选
            </label>
            <div className="relative">
              <button
                onClick={() => { setChannelsOpen(!channelsOpen); setModelsOpen(false) }}
                className="flex items-center justify-between w-full px-3 py-1.5 text-xs rounded-sm transition-colors"
                style={{
                  background: 'var(--bg-surface)',
                  border: `1px solid ${channelsOpen ? 'var(--amber-dim)' : 'var(--border-default)'}`,
                  color: 'var(--text-primary)',
                }}
              >
                <span>
                  {selectedChannels.length === 0 || selectedChannels.length === allChannels.length
                    ? `全部 Channel (${allChannels.length})`
                    : `已选 ${selectedChannels.length} 个 Channel`}
                </span>
                <ChevronDown size={11} strokeWidth={1.8} style={{ color: 'var(--text-muted)', transform: channelsOpen ? 'rotate(180deg)' : 'none' }} />
              </button>

              {channelsOpen && (
                <div
                  className="absolute z-10 w-full mt-1 rounded-sm shadow-lg max-h-48 overflow-auto"
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-default)',
                  }}
                >
                  <button
                    onClick={selectAllChannels}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-xs transition-colors"
                    style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-subtle)' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-surface)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div
                      className="w-3 h-3 rounded-sm border flex items-center justify-center"
                      style={{ borderColor: selectedChannels.length === allChannels.length || selectedChannels.length === 0 ? 'var(--amber)' : 'var(--border-default)', background: selectedChannels.length === allChannels.length || selectedChannels.length === 0 ? 'var(--amber-bg)' : 'transparent' }}
                    >
                      {(selectedChannels.length === allChannels.length || selectedChannels.length === 0) && <Check size={9} strokeWidth={2} style={{ color: 'var(--amber)' }} />}
                    </div>
                    全部 Channel
                  </button>
                  {allChannels.map((c) => (
                    <button
                      key={c}
                      onClick={() => toggleChannel(c)}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-xs transition-colors"
                      style={{ color: 'var(--text-primary)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-surface)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <div
                        className="w-3 h-3 rounded-sm border flex items-center justify-center"
                        style={{
                          borderColor: selectedChannels.includes(c) ? 'var(--amber)' : 'var(--border-default)',
                          background: selectedChannels.includes(c) ? 'var(--amber-bg)' : 'transparent',
                        }}
                      >
                        {selectedChannels.includes(c) && <Check size={9} strokeWidth={2} style={{ color: 'var(--amber)' }} />}
                      </div>
                      <span className="truncate">{c}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Count */}
          <div
            className="flex items-center gap-2 px-3 py-2 rounded-sm"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}
          >
            <Calendar size={12} strokeWidth={1.8} style={{ color: 'var(--text-muted)' }} />
            <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>预计导出</span>
            {loadingCount ? (
              <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>计算中…</span>
            ) : (
              <span
                className="num font-semibold"
                style={{ color: count === 0 ? 'var(--rose)' : 'var(--amber)', fontSize: '12px' }}
              >
                {count !== null ? `${count.toLocaleString()} 条记录` : '—'}
              </span>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-4 py-3 border-t"
          style={{ borderColor: 'var(--border-default)' }}
        >
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded-sm transition-colors"
            style={{
              fontFamily: 'Barlow',
              background: 'var(--bg-surface)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-default)',
            }}
          >
            取消
          </button>
          <button
            onClick={handleExport}
            disabled={!canExport}
            className="flex items-center gap-2 px-3 py-1.5 text-xs rounded-sm transition-colors"
            style={{
              fontFamily: 'Barlow',
              background: canExport ? 'var(--amber-bg)' : 'var(--bg-surface)',
              color: canExport ? 'var(--amber)' : 'var(--text-muted)',
              border: `1px solid ${canExport ? 'var(--amber-dim)' : 'var(--border-default)'}`,
              cursor: canExport ? 'pointer' : 'not-allowed',
            }}
          >
            <Download size={11} strokeWidth={1.8} />
            {exporting ? '导出中…' : '导出 CSV'}
          </button>
        </div>
      </div>
    </>
  )
}

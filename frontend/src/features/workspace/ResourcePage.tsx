import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import api from '../../lib/api'

type Field = {
  name: string
  label: string
  type?: 'text' | 'email' | 'number' | 'date' | 'datetime-local' | 'select' | 'textarea'
  required?: boolean
  nullable?: boolean
  options?: { value: string; label: string }[]
  optionsFrom?: string
}
type Column = { key: string; label: string; badge?: boolean; format?: (value: unknown, row: CRMRecord) => string }
type CRMRecord = Record<string, unknown> & { id: string }
type ListResponse = { count: number; next: string | null; previous: string | null; results: CRMRecord[] }
type Props = {
  title: string
  section: string
  endpoint: string
  description: string
  fields: Field[]
  columns: Column[]
}
type FormData = Record<string, string | number | null>

const recordList = (data: { results?: CRMRecord[] } | CRMRecord[]) => Array.isArray(data) ? data : data.results || []

export default function ResourcePage({ title, section, endpoint, description, fields, columns }: Props) {
  const [records, setRecords] = useState<CRMRecord[]>([])
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(1)
  const [hasNext, setHasNext] = useState(false)
  const [hasPrevious, setHasPrevious] = useState(false)
  const [choices, setChoices] = useState<Record<string, { value: string; label: string }[]>>({})
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<CRMRecord | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const { register, handleSubmit, reset, formState: { errors } } = useForm<FormData>()
  const choiceFields = useMemo(() => fields.filter((field) => field.optionsFrom), [fields])

  async function loadRecords() {
    setLoading(true)
    setError('')
    try {
      const { data } = await api.get<ListResponse>(endpoint, { params: { search, page, page_size: 25 } })
      setRecords(data.results)
      setCount(data.count)
      setHasNext(Boolean(data.next))
      setHasPrevious(Boolean(data.previous))
    } catch {
      setError(`Could not load ${title.toLowerCase()}. Check your connection and try again.`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadRecords(), search ? 250 : 0)
    return () => window.clearTimeout(timer)
  }, [search, endpoint, page])

  useEffect(() => {
    void Promise.all(choiceFields.map(async (field) => {
      try {
        const { data } = await api.get(field.optionsFrom!, { params: { page_size: 100 } })
        const items = recordList(data)
        setChoices((previous) => ({
          ...previous,
          [field.name]: items.map((item) => ({
            value: String(item.id),
            label: String(item.name || item.title || item.email || item.id),
          })),
        }))
      } catch {
        setError(`Could not load selection options for ${field.label.toLowerCase()}.`)
      }
    }))
  }, [choiceFields])

  function openCreate() {
    setEditing(null)
    reset({})
    setModalOpen(true)
  }

  function openEdit(record: CRMRecord) {
    setEditing(record)
    const defaults: FormData = {}
    fields.forEach((field) => {
      const value = record[field.name]
      if (value === null || value === undefined) return
      if (field.type === 'datetime-local') {
        const date = new Date(String(value))
        const pad = (part: number) => String(part).padStart(2, '0')
        defaults[field.name] = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
      } else {
        defaults[field.name] = String(value)
      }
    })
    reset(defaults)
    setModalOpen(true)
  }

  const saveRecord = handleSubmit(async (values) => {
    setSaving(true)
    setError('')
    const payload = { ...values }
    fields.forEach((field) => {
      if (payload[field.name] === '' || payload[field.name] === undefined) {
        if (field.nullable) payload[field.name] = null
        else delete payload[field.name]
      }
      if (field.type === 'datetime-local' && payload[field.name]) {
        payload[field.name] = new Date(String(payload[field.name])).toISOString()
      }
      if (field.type === 'number' && payload[field.name] !== '') {
        payload[field.name] = Number(payload[field.name])
      }
    })
    try {
      if (editing) await api.patch(`${endpoint}${editing.id}/`, payload)
      else await api.post(`${endpoint}`, payload)
      setModalOpen(false)
      await loadRecords()
    } catch {
      setError(`Could not save ${title.toLowerCase()}. Check the required fields and try again.`)
    } finally {
      setSaving(false)
    }
  })

  async function deleteRecord(record: CRMRecord) {
    if (!window.confirm(`Delete this ${title.toLowerCase().replace(/s$/, '')}? This cannot be undone.`)) return
    try {
      await api.delete(`${endpoint}${record.id}/`)
      if (records.length === 1 && page > 1) {
        setPage((current) => current - 1)
        return
      }
      await loadRecords()
    } catch {
      setError(`Could not delete this ${title.toLowerCase().replace(/s$/, '')}. It may still be referenced by another record.`)
    }
  }

  function displayValue(column: Column, record: CRMRecord) {
    const value = record[column.key]
    if (column.format) return column.format(value, record)
    if (value === null || value === undefined || value === '') return '—'
    if (column.key.endsWith('_at') || column.key === 'expected_close_date') {
      const date = new Date(String(value))
      return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString([], { dateStyle: 'medium', ...(column.key.endsWith('_at') ? { timeStyle: 'short' as const } : {}) })
    }
    return String(value).replaceAll('_', ' ')
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div><p className="text-xs font-semibold uppercase tracking-wider text-blue-600">{section}</p><h1 className="mt-2 text-[28px] font-bold tracking-tight text-slate-900">{title}</h1><p className="mt-1 text-sm text-slate-500">{description}</p></div>
        <button onClick={openCreate} className="inline-flex w-fit items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-[13px] font-semibold text-white hover:bg-blue-700"><Plus size={17} /> Add {title.replace(/s$/, '').toLowerCase()}</button>
      </div>
      <section className="panel-card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <p className="text-xs text-slate-500">{count} {title.toLowerCase()} in your workspace</p>
          <div className="relative w-full sm:max-w-[310px]"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} placeholder={`Search ${title.toLowerCase()}...`} className="form-input h-10 pl-9 text-xs" /></div>
        </div>
        {error && <div role="alert" className="m-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[740px] text-left">
            <thead className="bg-slate-50/80 text-[10px] font-semibold uppercase tracking-wider text-slate-400"><tr>{columns.map((column) => <th key={column.key} className="px-5 py-3">{column.label}</th>)}<th className="px-4 py-3 text-right">Actions</th></tr></thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {loading ? <tr><td colSpan={columns.length + 1} className="py-12 text-center text-slate-400">Loading {title.toLowerCase()}…</td></tr>
                : records.length ? records.map((record) => <tr key={record.id} className="hover:bg-slate-50/70">{columns.map((column, index) => {
                  const value = displayValue(column, record)
                  return <td key={column.key} className={`px-5 py-3.5 ${index === 0 ? 'font-semibold text-slate-800' : 'text-slate-600'}`}>{column.badge ? <span className="rounded-md bg-blue-50 px-2 py-1 text-[10px] font-semibold text-blue-700">{value}</span> : value}</td>
                })}<td className="px-4 py-3.5"><div className="flex justify-end gap-1"><button aria-label={`Edit ${String(record[columns[0].key] || title)}`} onClick={() => openEdit(record)} className="icon-button h-8 w-8"><Pencil size={15} /></button><button aria-label={`Delete ${String(record[columns[0].key] || title)}`} onClick={() => void deleteRecord(record)} className="icon-button h-8 w-8 text-rose-500 hover:bg-rose-50 hover:text-rose-700"><Trash2 size={15} /></button></div></td></tr>)
                : <tr><td colSpan={columns.length + 1} className="py-12 text-center text-slate-400">No {title.toLowerCase()} found. Add your first record to get started.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-[11px] text-slate-400"><span>Showing {count ? (page - 1) * 25 + 1 : 0}–{Math.min(page * 25, count)} of {count}</span><div className="flex gap-2"><button disabled={!hasPrevious || loading} onClick={() => setPage((value) => value - 1)} className="rounded-md border border-slate-200 px-2.5 py-1.5 disabled:opacity-50">Previous</button><button disabled={!hasNext || loading} onClick={() => setPage((value) => value + 1)} className="rounded-md border border-slate-200 px-2.5 py-1.5 disabled:opacity-50">Next</button></div></div>
      </section>
      {modalOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setModalOpen(false) }}><section role="dialog" aria-modal="true" aria-labelledby="resource-dialog-title" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl"><div className="mb-5 flex items-center justify-between"><div><h2 id="resource-dialog-title" className="text-lg font-bold text-slate-900">{editing ? `Edit ${title.replace(/s$/, '').toLowerCase()}` : `Add ${title.replace(/s$/, '').toLowerCase()}`}</h2><p className="mt-1 text-xs text-slate-500">Changes are saved to your workspace.</p></div><button aria-label="Close" onClick={() => setModalOpen(false)} className="icon-button"><X size={18} /></button></div>
        <form onSubmit={saveRecord} className="space-y-4">{fields.map((field) => <label key={field.name} className="block"><span className="mb-1.5 block text-xs font-semibold text-slate-700">{field.label}</span>
          {field.type === 'textarea' ? <textarea {...register(field.name, { required: field.required ? `${field.label} is required` : false })} rows={3} className="form-input" />
            : field.type === 'select' ? <select {...register(field.name, { required: field.required ? `Choose ${field.label.toLowerCase()}` : false })} className="form-input"><option value="">Select {field.label.toLowerCase()}</option>{(field.options || choices[field.name] || []).map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
              : <input {...register(field.name, { required: field.required ? `${field.label} is required` : false, ...(field.type === 'number' ? { min: { value: 0, message: `${field.label} cannot be negative` } } : {}) })} type={field.type || 'text'} step={field.type === 'number' ? '0.01' : undefined} className="form-input" />}
          {errors[field.name] && <span className="mt-1 block text-[11px] text-rose-600">{String(errors[field.name]?.message)}</span>}</label>)}
          <div className="flex justify-end gap-2 pt-2"><button type="button" onClick={() => setModalOpen(false)} className="rounded-lg border border-slate-200 px-4 py-2.5 text-xs font-semibold text-slate-600">Cancel</button><button disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-60">{saving ? 'Saving…' : 'Save changes'}</button></div>
        </form>
      </section></div>}
    </div>
  )
}

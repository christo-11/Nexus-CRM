import { useEffect, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Download } from 'lucide-react'
import api from '../../lib/api'

type CountRow = { status?: string; stage?: string; count: number; value?: number }
type ReportData = {
  leads_by_status: CountRow[]
  deals_by_stage: CountRow[]
  tickets_by_status: CountRow[]
  revenue: number
  pipeline_value: number
}

const exportRows = (rows: CountRow[], name: string) => {
  const escape = (value: string) => `"${value.replaceAll('"', '""')}"`
  const csv = ['Name,Count,Value', ...rows.map((row) => {
    const label = row.status || row.stage || ''
    const safeLabel = /^[=+\-@]/.test(label) ? `'${label}` : label
    return `${escape(safeLabel)},${row.count},${row.value || 0}`
  })].join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${name}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

function ReportChart({ title, rows, field = 'status' }: { title: string; rows: CountRow[]; field?: 'status' | 'stage' }) {
  const data = rows.map((row) => ({ name: (row[field] || '').replaceAll('_', ' '), records: row.count }))
  return <section className="panel-card p-5 sm:p-6"><h2 className="text-[15px] font-bold text-slate-900">{title}</h2><div className="mt-5 h-[240px]"><ResponsiveContainer width="100%" height="100%"><BarChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 8 }}><CartesianGrid stroke="#eef2f7" vertical={false} /><XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10 }} /><YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 10 }} /><Tooltip contentStyle={{ border: '1px solid #e2e8f0', borderRadius: 12, fontSize: 12 }} /><Bar dataKey="records" fill="#2563eb" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div></section>
}

export default function ReportsPage() {
  const [report, setReport] = useState<ReportData | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { api.get<ReportData>('/reports/').then(({ data }) => setReport(data)).catch(() => setError('Reports could not be loaded. Please try again.')) }, [])

  return <div className="space-y-6">
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="text-xs font-semibold uppercase tracking-wider text-blue-600">Business intelligence</p><h1 className="mt-2 text-[28px] font-bold tracking-tight text-slate-900">Reports & insights</h1><p className="mt-1 text-sm text-slate-500">Live summaries of your organization’s CRM records.</p></div><button disabled={!report} onClick={() => report && exportRows(report.deals_by_stage, 'crm-deals-by-stage')} className="inline-flex w-fit items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-[13px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"><Download size={16} /> Export deals CSV</button></div>
    {error && <div role="alert" className="rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><div className="panel-card p-5"><p className="text-xs font-medium text-slate-500">Closed revenue</p><p className="mt-2 text-2xl font-bold text-slate-900">{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(report?.revenue || 0)}</p></div><div className="panel-card p-5"><p className="text-xs font-medium text-slate-500">Open pipeline value</p><p className="mt-2 text-2xl font-bold text-slate-900">{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(report?.pipeline_value || 0)}</p></div></div>
    {report ? <div className="grid grid-cols-1 gap-5 xl:grid-cols-2"><ReportChart title="Leads by status" rows={report.leads_by_status} /><ReportChart title="Deals by stage" rows={report.deals_by_stage} field="stage" /><ReportChart title="Tickets by status" rows={report.tickets_by_status} /></div> : !error && <div className="panel-card p-10 text-center text-sm text-slate-400">Loading reports…</div>}
  </div>
}

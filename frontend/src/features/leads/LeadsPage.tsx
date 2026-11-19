import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { ArrowDownUp, Download, Pencil, Plus, Search, Trash2, UserRoundPlus, X } from 'lucide-react'
import api from '../../lib/api'
import { Skeleton } from '../../components/ui/Feedback'
import { leadStatusLabel } from './leadStatus'

type Lead = {
  id: string
  first_name: string
  last_name: string
  company: string
  email: string
  status: string
  score: number
  source: string
  owner: string | null
  owner_name: string
}
type LeadForm = Pick<Lead, 'first_name' | 'last_name' | 'company' | 'email' | 'source' | 'status'> & { owner?: string | null }
type LeadResponse = { count: number; next: string | null; previous: string | null; results: Lead[] }
type TeamMember = { id: number; name: string; email: string }

const statuses = ['NEW', 'CONTACTED', 'QUALIFIED', 'DISQUALIFIED', 'CONVERTED']
const statusStyles: Record<string, string> = {
  NEW: 'bg-blue-50 text-blue-700', CONTACTED: 'bg-violet-50 text-violet-700',
  QUALIFIED: 'bg-emerald-50 text-emerald-700', DISQUALIFIED: 'bg-slate-100 text-slate-600',
  CONVERTED: 'bg-cyan-50 text-cyan-700',
}

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [ordering, setOrdering] = useState('-created_at')
  const [page, setPage] = useState(1)
  const [count, setCount] = useState(0)
  const [hasNext, setHasNext] = useState(false)
  const [hasPrevious, setHasPrevious] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Lead | null>(null)
  const [team, setTeam] = useState<TeamMember[]>([])
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<LeadForm>()

  async function loadLeads() {
    setLoading(true)
    setError('')
    try {
      const { data } = await api.get<LeadResponse>('/leads/', {
        params: { search, status: status || undefined, ordering, page },
      })
      setLeads(data.results)
      setCount(data.count)
      setHasNext(Boolean(data.next))
      setHasPrevious(Boolean(data.previous))
    } catch {
      setError('Unable to load leads. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void loadLeads() }, [search, status, ordering, page])
  useEffect(() => {
    api.get<TeamMember[]>('/auth/team/')
      .then(({ data }) => setTeam(data))
      .catch(() => setError('Workspace members could not be loaded for lead assignment.'))
  }, [])

  function openCreate() {
    setEditing(null)
    reset({ status: 'NEW' })
    setModalOpen(true)
  }

  function openEdit(lead: Lead) {
    setEditing(lead)
    reset(lead)
    setModalOpen(true)
  }

  const saveLead = handleSubmit(async (values) => {
    setError('')
    try {
      const payload = { ...values, ...(values.owner === '' ? { owner: null } : {}) }
      if (editing) await api.patch(`/leads/${editing.id}/`, payload)
      else await api.post('/leads/', payload)
      setModalOpen(false)
      await loadLeads()
    } catch {
      setError('Could not save this lead. Check the details and your organization access.')
    }
  })

  async function convertLead(lead: Lead) {
    if (!window.confirm(`Convert ${lead.first_name} ${lead.last_name} into a customer?`)) return
    try {
      await api.post(`/leads/${lead.id}/convert/`)
      await loadLeads()
    } catch {
      setError('This lead could not be converted. It may already have been converted.')
    }
  }

  async function deleteLead(lead: Lead) {
    if (!window.confirm(`Delete ${lead.first_name} ${lead.last_name}? This cannot be undone.`)) return
    try {
      await api.delete(`/leads/${lead.id}/`)
      await loadLeads()
    } catch {
      setError('Could not delete this lead. Please try again.')
    }
  }

  function exportLeads() {
    const csvValue = (value: string) => `"${value.replaceAll('"', '""')}"`
    const rows = [
      ['First name', 'Last name', 'Company', 'Email', 'Status', 'Score', 'Source'].map(csvValue).join(','),
      ...leads.map((lead) => [lead.first_name, lead.last_name, lead.company, lead.email, lead.status, String(lead.score), lead.source].map(csvValue).join(',')),
    ]
    const url = URL.createObjectURL(new Blob([rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'crm-leads.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div><p className="text-xs font-semibold uppercase tracking-wider text-blue-600">Sales workspace</p><h1 className="mt-2 text-[28px] font-bold tracking-tight text-slate-900">Leads</h1><p className="mt-1 text-sm text-slate-500">Track prospects and turn promising conversations into customers.</p></div>
        <button onClick={openCreate} className="inline-flex w-fit items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-[13px] font-semibold text-white hover:bg-blue-700"><Plus size={17} /> Add lead</button>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="panel-card p-4"><p className="text-xs text-slate-500">Current page</p><p className="mt-2 text-2xl font-semibold text-slate-900 tabular-nums">{loading ? <Skeleton className="h-7 w-12" /> : leads.length}</p></div>
        <div className="panel-card p-4"><p className="text-xs text-slate-500">New</p><p className="mt-2 text-2xl font-semibold text-blue-600 tabular-nums">{loading ? <Skeleton className="h-7 w-12" /> : leads.filter((lead) => lead.status === 'NEW').length}</p></div>
        <div className="panel-card p-4"><p className="text-xs text-slate-500">Qualified</p><p className="mt-2 text-2xl font-semibold text-emerald-600 tabular-nums">{loading ? <Skeleton className="h-7 w-12" /> : leads.filter((lead) => lead.status === 'QUALIFIED').length}</p></div>
        <div className="panel-card p-4"><p className="text-xs text-slate-500">Avg. score (page)</p><p className="mt-2 text-2xl font-semibold text-violet-600 tabular-nums">{loading ? <Skeleton className="h-7 w-12" /> : leads.length ? Math.round(leads.reduce((total, lead) => total + lead.score, 0) / leads.length) : '—'}</p></div>
      </div>
      <section className="panel-card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="relative w-full sm:max-w-[270px]"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} placeholder="Search leads..." className="form-input h-10 pl-9 text-xs" /></div>
          <div className="flex flex-wrap gap-2">
            <select aria-label="Filter by status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1) }} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600"><option value="">All statuses</option>{statuses.map((item) => <option value={item} key={item}>{leadStatusLabel(item)}</option>)}</select>
            <button onClick={() => setOrdering((current) => current === '-created_at' ? 'created_at' : '-created_at')} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"><ArrowDownUp size={15} /> Newest</button>
            <button onClick={exportLeads} disabled={!leads.length} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"><Download size={15} /> Export page</button>
          </div>
        </div>
        {error && <div role="alert" className="m-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[930px] text-left">
            <thead className="bg-slate-50/80 text-[10px] font-semibold uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3">Name</th><th className="px-4 py-3">Company</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Lead score</th><th className="px-4 py-3">Source</th><th className="px-4 py-3">Email</th><th className="px-4 py-3">Owner</th><th className="px-4 py-3 text-right">Actions</th></tr></thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {loading ? Array.from({ length: 5 }, (_, index) => <tr key={index}>{Array.from({ length: 8 }, (_, cell) => <td key={cell} className="px-4 py-3.5"><Skeleton className={`h-3 ${cell === 0 ? 'w-28' : cell === 7 ? 'ml-auto w-16' : 'w-20'}`} /></td>)}</tr>) : leads.length ? leads.map((lead) => <tr key={lead.id} className="transition hover:bg-slate-50/70"><td className="px-5 py-3.5"><div className="font-semibold text-slate-800">{lead.first_name} {lead.last_name}</div></td><td className="px-4 py-3.5 text-slate-600">{lead.company || '—'}</td><td className="px-4 py-3.5"><span className={`crm-badge rounded-md px-2 py-1 text-[10px] font-semibold ${statusStyles[lead.status] || statusStyles.NEW}`}>{leadStatusLabel(lead.status)}</span></td><td className="px-4 py-3.5"><span className="font-semibold text-slate-700 tabular-nums">{lead.score}</span><span className="ml-2 inline-block h-1.5 w-14 rounded-full bg-slate-100 align-middle"><span className="block h-full rounded-full bg-blue-500" style={{ width: `${lead.score}%` }} /></span></td><td className="px-4 py-3.5 text-slate-500">{lead.source || '—'}</td><td className="px-4 py-3.5 text-slate-500">{lead.email || '—'}</td><td className="px-4 py-3.5 text-slate-500">{lead.owner_name || '—'}</td><td className="px-4 py-3.5"><div className="flex justify-end gap-1"><button aria-label="Edit lead" title="Edit lead" onClick={() => openEdit(lead)} className="icon-button h-8 w-8"><Pencil size={15} /></button>{lead.status !== 'CONVERTED' && lead.status !== 'DISQUALIFIED' && <button aria-label="Convert lead" title="Convert to customer" onClick={() => void convertLead(lead)} className="icon-button h-8 w-8 text-emerald-600"><UserRoundPlus size={15} /></button>}<button aria-label="Delete lead" title="Delete lead" onClick={() => void deleteLead(lead)} className="icon-button h-8 w-8 text-rose-500 hover:bg-rose-50 hover:text-rose-700"><Trash2 size={15} /></button></div></td></tr>) : <tr><td colSpan={8} className="py-12 text-center text-slate-400">No leads found. Add your first lead to get started.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-[11px] text-slate-400"><span>Showing {count ? (page - 1) * 25 + 1 : 0}–{Math.min(page * 25, count)} of {count} leads</span><div className="flex gap-2"><button disabled={!hasPrevious || loading} onClick={() => setPage((value) => value - 1)} className="rounded-md border border-slate-200 px-2.5 py-1.5 disabled:opacity-50">Previous</button><button disabled={!hasNext || loading} onClick={() => setPage((value) => value + 1)} className="rounded-md border border-slate-200 px-2.5 py-1.5 disabled:opacity-50">Next</button></div></div>
      </section>
      {modalOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setModalOpen(false) }}><section role="dialog" aria-modal="true" aria-labelledby="lead-dialog-title" className="crm-surface w-full max-w-lg p-6 shadow-2xl"><div className="mb-5 flex items-center justify-between"><div><h2 id="lead-dialog-title" className="text-lg font-bold text-slate-900">{editing ? 'Edit lead' : 'Add a new lead'}</h2><p className="mt-1 text-xs text-slate-500">Lead score is calculated from the contact details and qualification.</p></div><button aria-label="Close" onClick={() => setModalOpen(false)} className="icon-button"><X size={18} /></button></div><form onSubmit={saveLead} className="space-y-4"><div className="grid grid-cols-2 gap-3">{(['first_name', 'last_name'] as const).map((name) => <label key={name}><span className="mb-1.5 block text-xs font-semibold text-slate-700">{name === 'first_name' ? 'First name' : 'Last name'}</span><input {...register(name, { required: 'This field is required' })} className="form-input" />{errors[name] && <span className="mt-1 text-[11px] text-rose-600">{errors[name]?.message}</span>}</label>)}</div>{(['company', 'email', 'source'] as const).map((name) => <label key={name} className="block"><span className="mb-1.5 block text-xs font-semibold capitalize text-slate-700">{name}</span><input {...register(name, name === 'email' ? { pattern: { value: /^\S+@\S+\.\S+$/, message: 'Enter a valid email address' } } : {})} type={name === 'email' ? 'email' : 'text'} className="form-input" />{errors[name] && <span className="mt-1 text-[11px] text-rose-600">{errors[name]?.message}</span>}</label>)}<label className="block"><span className="mb-1.5 block text-xs font-semibold text-slate-700">Status</span><select {...register('status', { required: true })} className="form-input">{statuses.filter((item) => item !== 'CONVERTED').map((item) => <option key={item} value={item}>{leadStatusLabel(item)}</option>)}</select></label><label className="block"><span className="mb-1.5 block text-xs font-semibold text-slate-700">Owner</span><select {...register('owner')} className="form-input"><option value="">Unassigned</option>{team.map((member) => <option key={member.id} value={member.id}>{member.name} · {member.email}</option>)}</select></label><div className="flex justify-end gap-2 pt-2"><button type="button" onClick={() => setModalOpen(false)} className="rounded-lg border border-slate-200 px-4 py-2.5 text-xs font-semibold text-slate-600">Cancel</button><button disabled={isSubmitting} className="rounded-lg bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-60">{isSubmitting ? 'Saving…' : 'Save lead'}</button></div></form></section></div>}
    </div>
  )
}

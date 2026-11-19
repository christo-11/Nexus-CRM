import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import axios from 'axios'
import { ArrowRight, Building2, CalendarDays, Check, Columns3, ExternalLink, Mail, Plus, RefreshCw, Search, Sparkles, Table2, Target, UserRoundPlus, X } from 'lucide-react'
import api from '../../lib/api'
import { EmptyState, Skeleton } from '../../components/ui/Feedback'

type Product = { id: number; name: string }
type Person = { id: number; name: string; email: string }
type Lead = {
  id: number
  contact_name: string
  email: string
  company: string
  phone: string
  product: Product | null
  notes: string
  status: 'NEW' | 'UNDER_REVIEW' | 'CONTACTED' | 'INTERESTED' | 'QUALIFIED' | 'PURCHASE_PENDING' | 'CONVERTED' | 'LOST' | 'DISQUALIFIED'
  approval_status: string
  rejection_reason: string
  review_comment: string
  purchase_intent: string
  purchase_verified_at: string | null
  assignee: Person | null
  converted_ticket_id: number | null
  updated_at: string
}
type LeadPageResult = { results: Lead[]; total: number; page: number; pages: number }
type CustomerEnquiry = {
  id: number | string
  enquiry_id: number | null
  lead_id: number
  contact_name: string
  email: string
  company: string
  phone: string
  product: Product | null
  message: string
  created_at: string
  lead_status: Lead['status']
  approval_status: string
  lead: Lead
}
type CustomerEnquiryPageResult = { results: CustomerEnquiry[]; total: number; page: number; pages: number }
type LeadMeeting = {
  id: number
  lead_id: number | null
  lead_contact_name: string | null
  ticket_id: number | null
  ticket_number: string | null
  starts_at: string
  duration_minutes: number
  jitsi_url: string
}
type Profile = { role: string }
type ConversionResult = {
  lead: Lead
  ticket: { ticket_number: string }
  customer_email_sent: boolean
  assignee_email_sent: boolean
}
type ViewMode = 'board' | 'table'

const statuses: Lead['status'][] = ['NEW', 'UNDER_REVIEW', 'CONTACTED', 'INTERESTED', 'QUALIFIED', 'PURCHASE_PENDING', 'CONVERTED', 'LOST', 'DISQUALIFIED']
const editableStatuses: Lead['status'][] = ['NEW', 'CONTACTED', 'INTERESTED', 'QUALIFIED', 'PURCHASE_PENDING', 'LOST', 'DISQUALIFIED']
const statusNames: Record<Lead['status'], string> = {
  NEW: 'New',
  UNDER_REVIEW: 'Under review',
  CONTACTED: 'Contacted',
  INTERESTED: 'Interested',
  QUALIFIED: 'Qualified',
  PURCHASE_PENDING: 'Purchase pending',
  CONVERTED: 'Converted',
  LOST: 'Lost',
  DISQUALIFIED: 'Disqualified',
}
const statusTones: Record<Lead['status'], string> = {
  NEW: 'border-slate-200 bg-slate-100 text-slate-700',
  UNDER_REVIEW: 'border-amber-200 bg-amber-50 text-amber-800',
  CONTACTED: 'border-blue-200 bg-blue-50 text-blue-800',
  INTERESTED: 'border-violet-200 bg-violet-50 text-violet-800',
  QUALIFIED: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  PURCHASE_PENDING: 'border-orange-200 bg-orange-50 text-orange-800',
  CONVERTED: 'border-cyan-200 bg-cyan-50 text-cyan-900',
  LOST: 'border-rose-200 bg-rose-50 text-rose-800',
  DISQUALIFIED: 'border-rose-200 bg-rose-50 text-rose-800',
}
const approvalNames: Record<string, string> = {
  NOT_SUBMITTED: 'Needs verification',
  PENDING_APPROVAL: 'Awaiting Main Admin',
  NEEDS_INFORMATION: 'Changes requested',
  REJECTED: 'Returned for correction',
  APPROVED: 'Approved',
}

function localDateTimeValue(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

export default function LeadsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [leads, setLeads] = useState<Lead[]>([])
  const [customerEnquiries, setCustomerEnquiries] = useState<CustomerEnquiry[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [isMainAdmin, setIsMainAdmin] = useState(false)
  const [statusFilter, setStatusFilter] = useState(() => searchParams.get('origin') === 'customer' ? 'CUSTOMER_ENQUIRIES' : searchParams.get('status') || '')
  const [search, setSearch] = useState(() => searchParams.get('search') || '')
  const [debouncedSearch, setDebouncedSearch] = useState(() => searchParams.get('search') || '')
  const [selected, setSelected] = useState<Lead | null>(null)
  const [selectedEnquiry, setSelectedEnquiry] = useState<CustomerEnquiry | null>(null)
  const [leadMeetings, setLeadMeetings] = useState<LeadMeeting[]>([])
  const [meetingMessage, setMeetingMessage] = useState('')
  const [meetingBusy, setMeetingBusy] = useState(false)
  const [view, setView] = useState<ViewMode>(() => localStorage.getItem('smart-crm.leads-view') === 'table' ? 'table' : 'board')
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [showForm, setShowForm] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const contactInput = useRef<HTMLInputElement>(null)
  const requestSequence = useRef(0)

  const load = useCallback(async () => {
    const currentRequest = ++requestSequence.current
    setLoading(true)
    const params = new URLSearchParams({ page: String(page), per_page: '30' })
    if (statusFilter === 'CUSTOMER_ENQUIRIES') params.set('origin', 'customer')
    else if (statusFilter) params.set('status', statusFilter)
    if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim())
    try {
      if (statusFilter === 'CUSTOMER_ENQUIRIES') {
        const [{ data: result }, { data: catalog }, { data: profile }] = await Promise.all([
          api.get<CustomerEnquiryPageResult>(`/leads/enquiries?${params.toString()}`),
          api.get<Product[]>('/products'),
          api.get<Profile>('/auth/me'),
        ])
        if (currentRequest !== requestSequence.current) return
        setCustomerEnquiries(result.results)
        setLeads([])
        setTotal(result.total)
        setPages(Math.max(1, result.pages))
        setProducts(catalog)
        setIsMainAdmin(profile.role === 'MAIN_ADMIN')
      } else {
        const [{ data: result }, { data: catalog }, { data: profile }] = await Promise.all([
          api.get<LeadPageResult>(`/leads?${params.toString()}`),
          api.get<Product[]>('/products'),
          api.get<Profile>('/auth/me'),
        ])
        if (currentRequest !== requestSequence.current) return
        setLeads(result.results)
        setCustomerEnquiries([])
        setTotal(result.total)
        setPages(Math.max(1, result.pages))
        setProducts(catalog)
        setIsMainAdmin(profile.role === 'MAIN_ADMIN')
      }
      setError('')
    } catch {
      if (currentRequest === requestSequence.current) setError('Sales leads could not be loaded. Verify your role and connection.')
    } finally {
      if (currentRequest === requestSequence.current) setLoading(false)
    }
  }, [debouncedSearch, page, statusFilter])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 250)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const refresh = () => { void load() }
    window.addEventListener('crm:refresh', refresh)
    return () => window.removeEventListener('crm:refresh', refresh)
  }, [load])
  useEffect(() => {
    localStorage.setItem('smart-crm.leads-view', view)
  }, [view])
  useEffect(() => {
    if (searchParams.get('create') === 'lead') {
      setShowForm(true)
      window.setTimeout(() => contactInput.current?.focus(), 0)
    }
    if (searchParams.get('origin') === 'customer') setStatusFilter('CUSTOMER_ENQUIRIES')
    else if (searchParams.has('status')) setStatusFilter(searchParams.get('status') || '')
    if (searchParams.has('search')) setSearch(searchParams.get('search') || '')
  }, [searchParams])
  useEffect(() => {
    const enquiryId = Number(searchParams.get('enquiry'))
    if (!Number.isInteger(enquiryId) || enquiryId < 1) return
    const enquiry = customerEnquiries.find((item) => item.enquiry_id === enquiryId)
    if (enquiry) {
      setSelected(enquiry.lead)
      setSelectedEnquiry(enquiry)
      setError('')
    }
  }, [customerEnquiries, searchParams])
  useEffect(() => {
    if (!selected) {
      setLeadMeetings([])
      return
    }
    let active = true
    api.get<LeadMeeting[]>(`/meetings?lead_id=${selected.id}`)
      .then(({ data }) => {
        if (active) setLeadMeetings(data)
      })
      .catch(() => {
        if (active) setError('Scheduled meetings for this lead could not be loaded.')
      })
    return () => { active = false }
  }, [selected?.id])
  useEffect(() => {
    const leadId = searchParams.get('lead')
    if (!leadId || !/^\d+$/.test(leadId)) return
    let active = true
    api.get<Lead>(`/leads/${leadId}`)
      .then(({ data }) => {
        if (active) {
          setSelected(data)
          setSelectedEnquiry(null)
          setError('')
        }
      })
      .catch(() => {
        if (active) setError('This lead is not available in your sales pipeline.')
      })
    return () => { active = false }
  }, [searchParams])
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setShowForm(false)
        closeLeadDetails()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  function clearCreateParameter() {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.delete('create')
      return next
    }, { replace: true })
  }

  function closeLeadDetails() {
    setSelected(null)
    setSelectedEnquiry(null)
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.delete('lead')
      next.delete('enquiry')
      return next
    }, { replace: true })
  }

  function openLead(lead: Lead) {
    setSelected(lead)
    setSelectedEnquiry(null)
    setMeetingMessage('')
  }

  async function scheduleLeadMeeting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected) return
    const form = event.currentTarget
    const values = new FormData(form)
    const starts = new Date(String(values.get('starts_at')))
    if (!Number.isFinite(starts.getTime()) || starts.getTime() <= Date.now()) {
      setError('Choose a meeting time in the future.')
      return
    }
    setMeetingBusy(true)
    setError('')
    setMeetingMessage('')
    try {
      const { data } = await api.post<{ meeting: LeadMeeting; created: boolean }>(
        '/meetings',
        {
          lead_id: selected.id,
          starts_at: starts.toISOString(),
          duration_minutes: Number(values.get('duration_minutes')),
        },
      )
      setLeadMeetings((current) => current.some((meeting) => meeting.id === data.meeting.id)
        ? current
        : [...current, data.meeting].sort((a, b) => a.starts_at.localeCompare(b.starts_at)))
      setMeetingMessage(data.created
        ? 'Meeting scheduled and the customer has been notified.'
        : 'A meeting is already scheduled for this time.')
      form.reset()
    } catch (error: unknown) {
      const message = axios.isAxiosError<{ error?: string }>(error) ? error.response?.data?.error : null
      setError(message || 'The meeting could not be scheduled. Choose a future time and try again.')
    } finally {
      setMeetingBusy(false)
    }
  }

  function openCustomerEnquiry(enquiry: CustomerEnquiry) {
    setSelected(enquiry.lead)
    setSelectedEnquiry(enquiry)
    setMeetingMessage('')
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.set('origin', 'customer')
      next.delete('lead')
      if (enquiry.enquiry_id) next.set('enquiry', String(enquiry.enquiry_id))
      else next.delete('enquiry')
      return next
    }, { replace: true })
  }

  function openCreate() {
    setSelected(null)
    setSelectedEnquiry(null)
    setShowForm(true)
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.set('create', 'lead')
      return next
    }, { replace: true })
  }

  async function createLead(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await api.post<Lead>('/leads', {
        contact_name: data.get('contact_name'),
        email: data.get('email'),
        company: data.get('company'),
        phone: data.get('phone'),
        product_id: data.get('product_id') ? Number(data.get('product_id')) : null,
        notes: data.get('notes'),
      })
      form.reset()
      setShowForm(false)
      clearCreateParameter()
      setPage(1)
      setMessage('Lead created and assigned to Sales.')
      await load()
    } catch {
      setError('Lead could not be created. Check the contact details and product selection.')
    } finally {
      setBusy(false)
    }
  }

  async function updateLead(lead: Lead, status: Lead['status']) {
    const previous = leads
    setLeads((current) => current.map((item) => item.id === lead.id ? { ...item, status } : item))
    setSelected((current) => current?.id === lead.id ? { ...current, status } : current)
    setError('')
    try {
      const { data } = await api.patch<Lead>(`/leads/${lead.id}`, { status })
      setLeads((current) => current.map((item) => item.id === lead.id ? data : item))
      setSelected((current) => current?.id === lead.id ? data : current)
    } catch {
      setLeads(previous)
      setSelected((current) => current?.id === lead.id ? lead : current)
      setError('Lead status could not be updated. Your change was not saved.')
    }
  }

  async function updatePurchaseIntent(lead: Lead, purchaseIntent: string) {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const { data } = await api.patch<Lead>(`/leads/${lead.id}`, {
        purchase_intent: purchaseIntent,
      })
      setLeads((current) => current.map((item) => item.id === lead.id ? data : item))
      setSelected((current) => current?.id === lead.id ? data : current)
      setMessage('Customer purchase intent saved.')
    } catch (error: unknown) {
      const message = axios.isAxiosError<{ error?: string }>(error) ? error.response?.data?.error : null
      setError(message || 'Customer purchase intent could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  async function submitForApproval(lead: Lead, event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    const verificationNotes = String(values.get('verification_notes') || '').trim()
    const productId = String(values.get('product_id') || '')
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const { data } = await api.post<Lead>(`/leads/${lead.id}/verify`, {
        verification_notes: verificationNotes,
        product_id: productId ? Number(productId) : null,
      })
      setSelected(data)
      setMessage('Lead verification submitted. The Main Admin has been notified to review it.')
      await load()
    } catch (error: unknown) {
      const message = axios.isAxiosError<{ error?: string }>(error) ? error.response?.data?.error : null
      setError(message || 'Lead verification could not be submitted. Check the details and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function convertLead(lead: Lead) {
    if (!window.confirm(`Convert ${lead.contact_name} to a customer enquiry ticket?`)) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const { data: currentLead } = await api.get<Lead>(`/leads/${lead.id}`)
      setLeads((current) => current.map((item) => item.id === lead.id ? currentLead : item))
      setSelected((current) => current?.id === lead.id ? currentLead : current)

      if (currentLead.approval_status !== 'APPROVED') {
        setError('The Main Admin must approve this lead before it can be converted.')
        return
      }
      if (!currentLead.purchase_verified_at) {
        const confirmedPurchase = currentLead.purchase_intent === 'YES' || window.confirm(
          'Confirm that the customer has purchased? Select OK to record purchase intent and verify the purchase.',
        )
        if (!confirmedPurchase) return
        const { data: verifiedLead } = await api.post<Lead>(`/leads/${lead.id}/verify-purchase`, {
          purchase_intent: 'YES',
        })
        setLeads((current) => current.map((item) => item.id === lead.id ? { ...item, ...verifiedLead } : item))
        setSelected((current) => current?.id === lead.id ? { ...current, ...verifiedLead } : current)
      }
      const { data } = await api.post<ConversionResult>(`/leads/${lead.id}/convert`)
      setMessage(`Converted to ticket ${data.ticket.ticket_number}. The customer account is ready to sign in.`)
      closeLeadDetails()
      await load()
    } catch (error: unknown) {
      const message = axios.isAxiosError<{ error?: string }>(error) ? error.response?.data?.error : null
      setError(message || 'Lead could not be converted. Check its approval and purchase-verification status, then retry.')
    } finally {
      setBusy(false)
    }
  }

  const filters: { value: string; label: string }[] = [
    { value: '', label: 'All leads' },
    ...statuses.map((status) => ({ value: status, label: statusNames[status] })),
    { value: 'CUSTOMER_ENQUIRIES', label: 'Customer enquiries' },
  ]

  return <div className="space-y-5">
    <section className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-5">
      <div><p className="text-xs font-semibold uppercase tracking-[.16em] text-emerald-700">Sales workspace</p><h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 sm:text-[28px]">Lead qualification</h1><p className="mt-1.5 text-sm text-slate-500">Prioritize prospects, progress their status, and convert qualified interest into a customer enquiry.</p></div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => void load()} aria-label="Refresh leads" className="grid h-10 w-10 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:border-emerald-300 hover:text-emerald-800"><RefreshCw size={16} /></button>
        <button type="button" onClick={openCreate} className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-3.5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-800"><Plus size={16} />Add lead</button>
      </div>
    </section>

    {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
    {message && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"><Check className="mr-2 inline" size={15} />{message}</p>}

    <section className="crm-surface overflow-hidden">
      <div className="flex min-w-0 flex-col gap-3 border-b border-slate-100 p-4 sm:px-5">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <label className="relative min-w-0 w-full sm:max-w-sm sm:flex-1"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} /><input aria-label="Search leads" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} placeholder="Search name, email, or company" className="form-input pl-9" /></label>
          <span className="whitespace-nowrap text-xs text-slate-500">{loading ? 'Loading leads…' : `${total} ${statusFilter === 'CUSTOMER_ENQUIRIES' ? (total === 1 ? 'enquiry' : 'enquiries') : (total === 1 ? 'lead' : 'leads')}`}</span>
        </div>
        <div className="flex min-w-0 w-full items-center gap-3">
          <div role="group" aria-label="Filter leads by status" className="crm-filter-tabs min-w-0 flex-1">
            {filters.map(({ value, label }) => <button key={value || 'all'} type="button" aria-pressed={statusFilter === value} onClick={() => {
              setStatusFilter(value)
              setPage(1)
              setSearchParams((current) => {
                const next = new URLSearchParams(current)
                next.delete('status')
                next.delete('origin')
                next.delete('enquiry')
                next.delete('lead')
                if (value === 'CUSTOMER_ENQUIRIES') next.set('origin', 'customer')
                else if (value) next.set('status', value)
                return next
              }, { replace: true })
            }} className="whitespace-nowrap">{label}</button>)}
          </div>
          <div role="group" aria-label="Choose lead layout" className="inline-flex shrink-0 rounded-lg border border-slate-200 bg-white p-1">
            <button type="button" aria-label="Board view" aria-pressed={view === 'board'} onClick={() => setView('board')} className={`grid h-8 w-8 place-items-center rounded-md ${view === 'board' ? 'bg-emerald-50 text-emerald-800' : 'text-slate-500 hover:bg-slate-50'}`}><Columns3 size={16} /></button>
            <button type="button" aria-label="Table view" aria-pressed={view === 'table'} onClick={() => setView('table')} className={`grid h-8 w-8 place-items-center rounded-md ${view === 'table' ? 'bg-emerald-50 text-emerald-800' : 'text-slate-500 hover:bg-slate-50'}`}><Table2 size={16} /></button>
          </div>
        </div>
      </div>

      {loading ? <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-3" role="status" aria-label="Loading leads">{Array.from({ length: 6 }, (_, index) => <div key={index} className="space-y-3 rounded-xl border border-slate-100 p-4"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/2" /><Skeleton className="h-8 w-full" /></div>)}</div>
        : statusFilter === 'CUSTOMER_ENQUIRIES'
          ? !customerEnquiries.length
            ? <div className="p-8"><EmptyState icon={Target} title="No customer enquiries" description="Customer enquiries and product-interest leads will appear here, including enquiries added to an existing lead." /></div>
            : <div className="divide-y divide-slate-100">
              {customerEnquiries.map((enquiry) => <article key={enquiry.id} className="flex flex-col gap-3 p-4 transition hover:bg-slate-50/70 sm:flex-row sm:items-start sm:justify-between sm:px-5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold text-slate-900">{enquiry.contact_name}</h2>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusTones[enquiry.lead_status]}`}>{statusNames[enquiry.lead_status]}</span>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${enquiry.approval_status === 'APPROVED' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>{approvalNames[enquiry.approval_status] || enquiry.approval_status}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{enquiry.email}{enquiry.company ? ` · ${enquiry.company}` : ''}{enquiry.phone ? ` · ${enquiry.phone}` : ''}{enquiry.product ? ` · ${enquiry.product.name}` : ''}</p>
                  <p className="mt-3 whitespace-pre-wrap rounded-lg border-l-2 border-amber-400 bg-amber-50/70 px-3 py-2 text-sm leading-5 text-slate-700">{enquiry.message}</p>
                  <p className="mt-2 text-[10px] text-slate-400">{new Date(enquiry.created_at).toLocaleString()}</p>
                </div>
                <button type="button" onClick={() => openCustomerEnquiry(enquiry)} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-emerald-300 hover:text-emerald-800">Open lead <ArrowRight size={14} /></button>
              </article>)}
            </div>
          : !leads.length ? <div className="p-8"><EmptyState icon={Target} title="No leads in this view" description="Try another status or search, or add a lead to begin the pipeline." /></div>
          : view === 'board' ? <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-4">
            {statuses.map((status) => {
              const columnLeads = leads.filter((lead) => lead.status === status)
              return <section key={status} aria-label={`${statusNames[status]} leads`} className="min-w-0 rounded-xl bg-slate-50/80 p-3">
                <header className="mb-3 flex items-center justify-between"><span className="flex items-center gap-2 text-xs font-semibold text-slate-700"><span className={`h-2 w-2 rounded-full ${status === 'LOST' || status === 'DISQUALIFIED' ? 'bg-rose-500' : status === 'QUALIFIED' || status === 'INTERESTED' ? 'bg-emerald-600' : status === 'CONVERTED' ? 'bg-cyan-700' : status === 'UNDER_REVIEW' || status === 'PURCHASE_PENDING' ? 'bg-amber-500' : 'bg-slate-400'}`} />{statusNames[status]}</span><span className="rounded-md bg-white px-2 py-1 text-[10px] font-semibold text-slate-500">{columnLeads.length}</span></header>
                <div className="space-y-2.5">
                  {columnLeads.map((lead) => <article key={lead.id} className="rounded-lg border border-slate-200 bg-white p-3 transition hover:border-emerald-300 hover:shadow-sm">
                      <button type="button" onClick={() => openLead(lead)} className="w-full text-left focus-visible:outline-2 focus-visible:outline-emerald-700"><span className="block truncate text-sm font-semibold text-slate-900">{lead.contact_name}</span><span className="mt-1 block truncate text-xs text-slate-500">{lead.company || lead.email}</span><span className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-500"><Mail size={12} />{lead.email}</span>{lead.product && <span className="mt-1 block truncate text-[11px] text-emerald-800">{lead.product.name}</span>}<span className={`mt-2 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${lead.approval_status === 'APPROVED' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>{approvalNames[lead.approval_status] || lead.approval_status}</span></button>
                    <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-100 pt-2.5">
                        {status === 'CONVERTED' ? <span className={`rounded-full border px-2 py-1 text-[10px] font-semibold ${statusTones[status]}`}>Ticket created</span> : lead.approval_status === 'APPROVED' ? <select aria-label={`Set ${lead.contact_name} status`} value={lead.status} onChange={(event) => void updateLead(lead, event.target.value as Lead['status'])} className="max-w-32 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[10px] font-medium text-slate-700 focus-visible:outline-2 focus-visible:outline-emerald-700">{editableStatuses.map((option) => <option key={option} value={option}>{statusNames[option]}</option>)}</select> : <span className="text-[10px] text-slate-500">Awaiting approval</span>}
                        {status !== 'CONVERTED' && status !== 'LOST' && status !== 'DISQUALIFIED' && lead.approval_status === 'APPROVED' && <button type="button" disabled={busy} onClick={() => void convertLead(lead)} className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-2 py-1.5 text-[10px] font-semibold text-white hover:bg-emerald-800 disabled:opacity-60">Convert <ArrowRight size={12} /></button>}
                    </div>
                  </article>)}
                  {!columnLeads.length && <p className="rounded-lg border border-dashed border-slate-200 px-3 py-5 text-center text-[11px] text-slate-400">No {statusNames[status].toLowerCase()} leads</p>}
                </div>
              </section>
            })}
          </div>
          : <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-3">Contact</th><th className="py-3">Company / product</th><th className="py-3">Status</th><th className="py-3">Owner</th><th className="py-3">Updated</th><th className="px-5 py-3 text-right">Actions</th></tr></thead>
              <tbody>{leads.map((lead) => <tr key={lead.id} className="border-t border-slate-100 transition hover:bg-emerald-50/40">
                <td className="px-5 py-3"><button type="button" onClick={() => openLead(lead)} className="text-left focus-visible:outline-2 focus-visible:outline-emerald-700"><span className="block font-semibold text-slate-900">{lead.contact_name}</span><span className="text-xs text-slate-500">{lead.email}</span></button></td>
                <td className="py-3"><span className="block">{lead.company || '—'}</span><span className="text-xs text-slate-500">{lead.product?.name || 'No product selected'}</span></td>
                <td className="py-3"><span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${statusTones[lead.status]}`}>{statusNames[lead.status]}</span><span className={`mt-1 block text-[10px] ${lead.approval_status === 'APPROVED' ? 'text-emerald-700' : 'text-amber-700'}`}>{approvalNames[lead.approval_status] || lead.approval_status}</span></td>
                <td className="py-3">{lead.assignee?.name || 'Deleted account'}</td>
                <td className="py-3 text-xs text-slate-500">{new Date(lead.updated_at).toLocaleDateString()}</td>
                <td className="px-5 py-3 text-right"><button type="button" onClick={() => openLead(lead)} className="rounded-md px-2.5 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-50">Details</button></td>
              </tr>)}</tbody>
            </table>
          </div>}

      <footer className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
        <span>Page {page} of {pages} · 30 per page</span>
        <div className="flex gap-2"><button type="button" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))} className="rounded-md border border-slate-200 px-3 py-1.5 font-medium disabled:opacity-40">Previous</button><button type="button" disabled={page >= pages || loading} onClick={() => setPage((current) => Math.min(pages, current + 1))} className="rounded-md border border-slate-200 px-3 py-1.5 font-medium disabled:opacity-40">Next</button></div>
      </footer>
    </section>

    {showForm && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-3 backdrop-blur-sm sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) { setShowForm(false); clearCreateParameter() } }}>
      <section role="dialog" aria-modal="true" aria-labelledby="lead-form-title" className="grid max-h-[min(780px,calc(100vh-1.5rem))] w-full max-w-5xl overflow-hidden rounded-3xl bg-white shadow-2xl md:grid-cols-[0.82fr_1.18fr]">
        <aside className="relative hidden flex-col justify-between overflow-hidden bg-emerald-950 p-8 text-white md:flex lg:p-10">
          <div className="pointer-events-none absolute -right-24 -top-20 h-72 w-72 rounded-full border border-white/10" />
          <div className="pointer-events-none absolute -right-12 -top-8 h-48 w-48 rounded-full border border-white/10" />
          <div className="relative">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-emerald-400/15 text-emerald-200"><UserRoundPlus size={23} /></div>
            <p className="mt-8 text-[11px] font-bold uppercase tracking-[.2em] text-emerald-300">Sales pipeline</p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight">Every great partnership starts with a conversation.</h2>
            <p className="mt-4 text-sm leading-6 text-emerald-100/75">Capture a prospect&apos;s details and what they&apos;re looking for. Your sales team can take it from there.</p>
          </div>
          <div className="relative space-y-4 rounded-2xl border border-white/10 bg-white/[.06] p-5">
            <div className="flex items-center gap-3"><span className="grid h-8 w-8 place-items-center rounded-full bg-emerald-300/15 text-emerald-200"><Check size={15} /></span><span className="text-sm text-emerald-50">Contact captured</span></div>
            <div className="ml-4 h-5 border-l border-dashed border-emerald-300/40" />
            <div className="flex items-center gap-3"><span className="grid h-8 w-8 place-items-center rounded-full bg-white/10 text-emerald-100"><Target size={15} /></span><span className="text-sm text-emerald-50">Sales team follows up</span></div>
            <div className="ml-4 h-5 border-l border-dashed border-emerald-300/40" />
            <div className="flex items-center gap-3"><span className="grid h-8 w-8 place-items-center rounded-full bg-white/10 text-emerald-100"><Sparkles size={15} /></span><span className="text-sm text-emerald-50">Opportunity takes shape</span></div>
          </div>
          <p className="relative text-xs text-emerald-200/60">New leads are automatically assigned to Sales.</p>
        </aside>

        <div className="flex min-h-0 flex-col overflow-y-auto">
          <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-5 sm:px-8 sm:py-7">
            <div>
              <p className="text-xs font-bold uppercase tracking-[.16em] text-emerald-700">New opportunity</p>
              <h2 id="lead-form-title" className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Add a lead</h2>
              <p className="mt-1 text-sm text-slate-500">Start with the person, then add what you know.</p>
            </div>
            <button type="button" aria-label="Close lead form" onClick={() => { setShowForm(false); clearCreateParameter() }} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"><X size={18} /></button>
          </header>

          <form onSubmit={createLead} className="flex min-h-0 flex-1 flex-col">
            <div className="space-y-7 overflow-y-auto px-5 py-6 sm:px-8">
              <fieldset className="space-y-4">
                <legend className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-900"><span className="grid h-6 w-6 place-items-center rounded-lg bg-emerald-50 text-[11px] font-bold text-emerald-800">01</span> Contact information</legend>
                <label className="block text-xs font-semibold text-slate-600">Contact name <span className="text-rose-700">*</span><input ref={contactInput} name="contact_name" maxLength={160} required autoComplete="name" placeholder="e.g. Jordan Lee" className="form-input mt-1.5" /></label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block text-xs font-semibold text-slate-600">Work email <span className="text-rose-700">*</span><input name="email" type="email" maxLength={254} required autoComplete="email" placeholder="jordan@company.com" className="form-input mt-1.5" /></label>
                  <label className="block text-xs font-semibold text-slate-600">Phone <span className="font-normal text-slate-400">Optional</span><input name="phone" maxLength={40} autoComplete="tel" placeholder="+1 555 0100" className="form-input mt-1.5" /></label>
                </div>
                <label className="block text-xs font-semibold text-slate-600">Company <span className="font-normal text-slate-400">Optional</span><input name="company" maxLength={180} autoComplete="organization" placeholder="Organization name" className="form-input mt-1.5" /></label>
              </fieldset>

              <fieldset className="space-y-4 border-t border-slate-100 pt-6">
                <legend className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-900"><span className="grid h-6 w-6 place-items-center rounded-lg bg-emerald-50 text-[11px] font-bold text-emerald-800">02</span> Opportunity details</legend>
                <label className="block text-xs font-semibold text-slate-600">Product interest <span className="font-normal text-slate-400">Optional</span><select name="product_id" className="form-input mt-1.5"><option value="">Choose a product</option>{products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                <label className="block text-xs font-semibold text-slate-600">Notes for the sales team <span className="font-normal text-slate-400">Optional</span><textarea name="notes" rows={4} maxLength={5000} placeholder="How did they hear about us? What are they hoping to solve?" className="form-input mt-1.5 resize-y" /></label>
              </fieldset>
              {error && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
            </div>
            <footer className="mt-auto flex gap-3 border-t border-slate-100 bg-slate-50/80 px-5 py-4 sm:px-8">
              <button type="button" onClick={() => { setShowForm(false); clearCreateParameter() }} className="rounded-xl border border-slate-200 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">Cancel</button>
              <button type="submit" disabled={busy} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-800 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-900 disabled:cursor-wait disabled:opacity-60">{busy ? 'Creating lead…' : 'Create lead'}{!busy && <ArrowRight size={16} />}</button>
            </footer>
          </form>
        </div>
      </section>
    </div>}

    {selected && <div className="fixed inset-0 z-40 flex justify-end bg-slate-950/40 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) closeLeadDetails() }}>
      <aside role="dialog" aria-modal="true" aria-labelledby="lead-detail-title" className="crm-surface h-full w-full max-w-lg overflow-y-auto rounded-none border-y-0 border-r-0 p-5 shadow-2xl sm:p-7">
        <header className="flex items-start justify-between gap-4 border-b border-slate-100 pb-5"><div><span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${statusTones[selected.status]}`}>{statusNames[selected.status]}</span><span className={`ml-2 inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${selected.approval_status === 'APPROVED' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>{approvalNames[selected.approval_status] || selected.approval_status}</span><h2 id="lead-detail-title" className="mt-3 text-xl font-semibold text-slate-900">{selected.contact_name}</h2><p className="mt-1 text-sm text-slate-500">Lead · Updated {new Date(selected.updated_at).toLocaleDateString()}</p></div><button type="button" aria-label="Close lead details" onClick={closeLeadDetails} className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"><X size={18} /></button></header>
        <section className="space-y-4 border-b border-slate-100 py-5"><h3 className="text-xs font-semibold uppercase tracking-[.12em] text-slate-500">Contact</h3><a href={`mailto:${selected.email}`} className="flex items-center gap-3 text-sm text-slate-700 hover:text-emerald-800"><Mail className="text-emerald-700" size={16} />{selected.email}</a>{selected.company && <p className="flex items-center gap-3 text-sm text-slate-700"><Building2 className="text-emerald-700" size={16} />{selected.company}</p>}{selected.phone && <a href={`tel:${selected.phone}`} className="text-sm text-slate-700 hover:text-emerald-800">{selected.phone}</a>}</section>
        {selectedEnquiry && <section className="space-y-2 border-b border-slate-100 py-5"><h3 className="text-xs font-semibold uppercase tracking-[.12em] text-slate-500">Customer enquiry</h3><p className="whitespace-pre-wrap rounded-lg border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-sm leading-6 text-slate-700">{selectedEnquiry.message}</p><p className="text-[10px] text-slate-400">Received {new Date(selectedEnquiry.created_at).toLocaleString()}</p></section>}
        <section className="space-y-4 border-b border-slate-100 py-5">
          <div className="flex items-center gap-2"><CalendarDays className="text-emerald-700" size={16} /><h3 className="text-xs font-semibold uppercase tracking-[.12em] text-slate-500">Meetings</h3></div>
          {leadMeetings.map((meeting) => <div key={meeting.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div><p className="text-sm font-medium text-slate-800">{new Date(meeting.starts_at).toLocaleString()}</p><p className="text-xs text-slate-500">{meeting.duration_minutes} minutes</p></div>
            <a href={meeting.jitsi_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-800 hover:text-emerald-900">Join meeting <ExternalLink size={13} /></a>
          </div>)}
          {selected.approval_status === 'APPROVED' && selected.status !== 'CONVERTED' && <form key={selected.id} onSubmit={(event) => void scheduleLeadMeeting(event)} className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-slate-600 sm:col-span-2">Date and time<input name="starts_at" type="datetime-local" min={localDateTimeValue(new Date())} required className="form-input mt-1.5" /></label>
            <label className="text-xs font-medium text-slate-600">Duration (minutes)<input name="duration_minutes" type="number" min="5" max="480" defaultValue="30" required className="form-input mt-1.5" /></label>
            <button type="submit" disabled={meetingBusy} className="mt-4 inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-800 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-900 disabled:opacity-60"><CalendarDays size={14} />{meetingBusy ? 'Scheduling…' : 'Schedule meeting'}</button>
          </form>}
          {selected.approval_status !== 'APPROVED' && <p className="text-xs leading-5 text-slate-500">A meeting can be scheduled after Main Admin approval.</p>}
          {meetingMessage && <p role="status" className="rounded-lg bg-emerald-50 p-2.5 text-xs text-emerald-800">{meetingMessage}</p>}
        </section>
        <section className="space-y-4 border-b border-slate-100 py-5"><h3 className="text-xs font-semibold uppercase tracking-[.12em] text-slate-500">Sales context</h3><p className="text-sm text-slate-700">Product: {selected.product?.name || 'Not specified'}</p>{selected.status !== 'CONVERTED' ? <label className="block text-xs font-medium text-slate-600">Customer purchase intent<select aria-label="Customer purchase intent" value={selected.purchase_intent} disabled={busy || Boolean(selected.purchase_verified_at)} onChange={(event) => void updatePurchaseIntent(selected, event.target.value)} className="form-input mt-1.5"><option value="UNKNOWN">Not confirmed</option><option value="YES">Customer confirmed purchase</option><option value="NO">Customer did not purchase</option></select>{selected.purchase_intent === 'YES' && <span className="mt-1 block text-[11px] text-emerald-700">{selected.approval_status === 'APPROVED' ? 'Purchase intent confirmed. Verify the purchase before converting.' : 'Purchase intent saved. Main Admin approval is still required before purchase verification.'}</span>}</label> : <p className="text-sm text-slate-700">Purchase intent: {selected.purchase_intent === 'YES' ? 'Confirmed' : selected.purchase_intent === 'NO' ? 'Not proceeding' : 'Not confirmed'}</p>}<p className="text-sm text-slate-700">Purchase verification: {selected.purchase_verified_at ? `Verified ${new Date(selected.purchase_verified_at).toLocaleString()}` : 'Not verified'}</p><p className="whitespace-pre-wrap text-sm leading-6 text-slate-600">{selected.notes || 'No notes have been added.'}</p><p className="text-xs text-slate-500">Assigned to {selected.assignee?.name || 'Deleted account'}</p></section>
        {selected.approval_status !== 'APPROVED' && !isMainAdmin && ['NOT_SUBMITTED', 'NEEDS_INFORMATION', 'REJECTED'].includes(selected.approval_status) && <form onSubmit={(event) => void submitForApproval(selected, event)} className="space-y-3 border-b border-slate-100 py-5">
          <h3 className="text-xs font-semibold uppercase tracking-[.12em] text-slate-700">Verify and submit to Main Admin</h3>
          <p className="text-xs leading-5 text-slate-500">Confirm the customer details and product interest. The Main Admin will receive a notification and must approve the lead before sales follow-up.</p>
          {selected.rejection_reason && <p className="rounded-lg bg-rose-50 p-3 text-xs text-rose-800">Correction requested: {selected.rejection_reason}</p>}
          {selected.review_comment && selected.approval_status === 'NEEDS_INFORMATION' && <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">Main Admin requested more information: {selected.review_comment}</p>}
          <label className="block text-xs font-medium text-slate-600">Product interest <span className="text-rose-700">*</span><select name="product_id" required defaultValue={selected.product?.id ?? ''} className="form-input mt-1.5"><option value="" disabled>Select a product</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
          <label className="block text-xs font-medium text-slate-600">Verification notes <span className="text-rose-700">*</span><textarea name="verification_notes" required maxLength={5000} rows={4} className="form-input mt-1.5" placeholder="Describe how you confirmed the customer's contact details and interest." /></label>
          <button type="submit" disabled={busy} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-900 disabled:opacity-60"><Check size={16} />{busy ? 'Submitting for approval…' : 'Submit for Main Admin approval'}</button>
        </form>}
        {selected.approval_status === 'PENDING_APPROVAL' && <p className="my-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Sales verification is complete. The lead is waiting for Main Admin approval.</p>}
        {selected.approval_status === 'APPROVED' && selected.status !== 'CONVERTED' && <section className="space-y-3 py-5"><h3 className="text-xs font-semibold uppercase tracking-[.12em] text-slate-500">Next step</h3><label className="block text-xs font-medium text-slate-600">Lead status<select value={selected.status} onChange={(event) => void updateLead(selected, event.target.value as Lead['status'])} className="form-input mt-1.5">{editableStatuses.map((option) => <option key={option} value={option}>{statusNames[option]}</option>)}</select></label>{selected.status !== 'LOST' && selected.status !== 'DISQUALIFIED' && <button type="button" disabled={busy} onClick={() => void convertLead(selected)} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60">Convert to customer enquiry <ArrowRight size={16} /></button>}</section>}
        {selected.converted_ticket_id && <p className="mt-5 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">This lead has been converted to a customer and ticket.</p>}
      </aside>
    </div>}
  </div>
}

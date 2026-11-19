import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Check, Clock3, Mail, RefreshCw, Search, Send, ShieldAlert, X } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import api from '../../lib/api'
import { EmptyState, Skeleton } from '../../components/ui/Feedback'

type Person = { id: number; name: string; email: string; role: string }
type Lead = {
  id: number
  contact_name: string
  email: string
  phone: string
  company: string
  product: { id: number; name: string } | null
  notes: string
  source: string
  status: string
  approval_status: string
  customer_requirements: string
  support_verification_notes: string
  customer_interest_status: string
  purchase_intent: string
  rejection_reason: string
  review_comment: string
  follow_up_at: string | null
  support_assignee: Person | null
  support_verified_by: Person | null
  submitted_for_approval_at: string | null
  interest_events: { id: number; product_name: string | null; first_seen_at: string; last_seen_at: string; visit_count: number }[]
  communications: { id: number; subject: string; body: string; delivery_status: string; created_at: string }[]
  approval_history: { id: number; action: string; comment: string; actor: Person | null; created_at: string }[]
}
type Page<T = Lead> = { results: T[]; total: number; page: number; pages: number }
type ProductInterest = {
  id: number
  product_id: number
  product_name: string | null
  first_seen_at: string
  last_seen_at: string
  visit_count: number
}

const supportStatuses = ['NOT_SUBMITTED', 'NEEDS_INFORMATION', 'REJECTED', 'PENDING_APPROVAL', 'APPROVED']
const adminStatuses = ['PENDING_APPROVAL', 'NEEDS_INFORMATION', 'REJECTED', 'APPROVED']
const displayStatus = (value: string) => value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase())

export default function LeadReviewPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedId = searchParams.get('lead')
  const [profile, setProfile] = useState<Person | null>(null)
  const [items, setItems] = useState<Lead[]>([])
  const [productInterests, setProductInterests] = useState<ProductInterest[]>([])
  const [productInterestTotal, setProductInterestTotal] = useState(0)
  const [selected, setSelected] = useState<Lead | null>(null)
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const isAdmin = profile?.role === 'MAIN_ADMIN'

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ page: String(page), per_page: '25' })
    if (status) params.set('approval_status', status)
    if (search.trim()) params.set('search', search.trim())
    try {
      const { data: me } = await api.get<Person>('/auth/me')
      const { data: result } = await api.get<Page>(me.role === 'MAIN_ADMIN'
        ? `/admin/lead-approvals?${params.toString()}`
        : `/support/leads?${params.toString()}`)
      const interestResult = me.role === 'SUPPORT' || me.role === 'PRODUCT_MAINTENANCE'
        ? await api.get<Page<ProductInterest>>(`/support/product-interests?${params.toString()}`)
        : null
      setProfile(me)
      setItems(result.results)
      setProductInterests(interestResult?.data.results || [])
      setProductInterestTotal(interestResult?.data.total || 0)
      setTotal(result.total)
      setPages(Math.max(1, result.pages))
      setError('')
    } catch {
      setError('Lead review records could not be loaded. Check your role and connection.')
    } finally {
      setLoading(false)
    }
  }, [page, search, status])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!requestedId || !profile) {
      setSelected(null)
      return
    }
    let active = true
    const endpoint = isAdmin ? `/leads/${requestedId}` : `/support/leads/${requestedId}`
    api.get<Lead>(endpoint).then(({ data }) => {
      if (active) {
        setSelected(data)
        setError('')
      }
    }).catch(() => {
      if (active) setError('This lead could not be opened with your account permissions.')
    })
    return () => { active = false }
  }, [isAdmin, profile, requestedId])

  function openLead(lead: Lead) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.set('lead', String(lead.id))
      return next
    })
  }

  function closeLead() {
    setSelected(null)
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.delete('lead')
      return next
    }, { replace: true })
  }

  async function saveVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected) return
    const form = event.currentTarget
    const values = new FormData(form)
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const { data } = await api.patch<Lead>(`/support/leads/${selected.id}`, {
        contact_name: values.get('contact_name'),
        email: values.get('email'),
        phone: values.get('phone'),
        company: values.get('company'),
        customer_requirements: values.get('customer_requirements'),
        support_verification_notes: values.get('support_verification_notes'),
        customer_interest_status: values.get('customer_interest_status'),
        purchase_intent: values.get('purchase_intent'),
        follow_up_at: values.get('follow_up_at') || null,
      })
      setSelected(data)
      setMessage('Verification details saved.')
      await load()
    } catch (saveError: unknown) {
      const details = (saveError as { response?: { data?: { error?: string } } }).response?.data?.error
      setError(details || 'Verification details could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  async function sendEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected) return
    const form = event.currentTarget
    const values = new FormData(form)
    setBusy(true)
    setError('')
    try {
      await api.post(`/support/leads/${selected.id}/contact`, {
        subject: values.get('subject'),
        body: values.get('body'),
      })
      form.reset()
      setMessage('Email queued. Check its delivery status in the communication history.')
      await load()
      const { data } = await api.get<Lead>(`/support/leads/${selected.id}`)
      setSelected(data)
    } catch (sendError: unknown) {
      const details = (sendError as { response?: { data?: { error?: string } } }).response?.data?.error
      setError(details || 'Customer email could not be queued.')
    } finally {
      setBusy(false)
    }
  }

  async function submitForApproval() {
    if (!selected) return
    setBusy(true)
    setError('')
    try {
      const { data } = await api.post<Lead>(`/support/leads/${selected.id}/submit`)
      setSelected(data)
      setMessage('Lead submitted to the Main Admin approval queue.')
      await load()
    } catch (submitError: unknown) {
      const response = submitError as { response?: { data?: { error?: string; details?: { missing_fields?: string[] } } } }
      setError([
        response.response?.data?.error,
        ...(response.response?.data?.details?.missing_fields || []).map((field) => `Missing: ${field}`),
      ].filter(Boolean).join(' '))
    } finally {
      setBusy(false)
    }
  }

  async function review(action: 'APPROVE' | 'REJECT' | 'NEEDS_INFORMATION', comment = '') {
    if (!selected) return
    setBusy(true)
    setError('')
    try {
      const { data } = await api.post<Lead>(`/admin/leads/${selected.id}/review`, { action, comment })
      setSelected(data)
      setMessage(action === 'APPROVE' ? 'Lead approved for sales follow-up.' : 'Lead returned to support with your review comment.')
      await load()
    } catch (reviewError: unknown) {
      const details = (reviewError as { response?: { data?: { error?: string } } }).response?.data?.error
      setError(details || 'Lead review action could not be completed.')
    } finally {
      setBusy(false)
    }
  }

  async function reviewWithReason(action: 'REJECT' | 'NEEDS_INFORMATION') {
    const reason = window.prompt(action === 'REJECT' ? 'Why is this lead being rejected?' : 'What additional information is required?')
    if (!reason?.trim()) return
    await review(action, reason.trim())
  }

  const allowedStatuses = isAdmin ? adminStatuses : supportStatuses

  return <div className="space-y-5">
    <section className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[.16em] text-emerald-700">{isAdmin ? 'Main Admin workspace' : 'Support workspace'}</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 sm:text-[28px]">{isAdmin ? 'Lead approvals' : 'Lead verification'}</h1>
        <p className="mt-1.5 text-sm text-slate-500">{isAdmin ? 'Review the evidence and decide whether leads can enter the sales pipeline.' : 'Validate enquiries, record customer responses, and submit complete leads for approval.'}</p>
      </div>
      <button type="button" onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-700"><RefreshCw size={15} />Refresh</button>
    </section>

    <ol aria-label="Lead approval progress" className="grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-white p-3 text-xs font-medium text-slate-600 sm:grid-cols-5">
      {['Product interest', 'Support verification', 'Admin approval', 'Sales follow-up', 'Purchase & conversion'].map((step, index) => <li key={step} className="flex items-center gap-2 rounded-lg bg-slate-50 px-2 py-2"><span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-100 text-[10px] font-bold text-emerald-900">{index + 1}</span>{step}</li>)}
    </ol>

    {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>}
    {message && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{message}</div>}

    <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="relative min-w-52 flex-1"><Search size={16} className="absolute left-3 top-3 text-slate-400" /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} placeholder="Search leads" className="form-input pl-9" /></label>
        <select aria-label="Filter approval status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1) }} className="form-input sm:w-56">
          <option value="">{isAdmin ? 'Pending approvals' : 'All review stages'}</option>
          {allowedStatuses.map((value) => <option key={value} value={value}>{displayStatus(value)}</option>)}
        </select>
      </div>
      {loading ? <div className="space-y-4 py-3" aria-label="Loading leads">{Array.from({ length: 4 }, (_, index) => <div key={index} className="flex gap-4"><Skeleton className="h-4 w-20" /><Skeleton className="h-4 flex-1" /><Skeleton className="h-4 w-28" /></div>)}</div>
        : !items.length ? <EmptyState icon={isAdmin ? ShieldAlert : Clock3} title="No leads in this review queue" description={isAdmin ? 'Submitted leads awaiting your review will appear here.' : 'Product interests and enquiries assigned to your support queue will appear here.'} />
          : <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm">
            <thead className="text-xs uppercase text-slate-500"><tr><th className="py-3">Lead</th><th className="py-3">Product & source</th><th className="py-3">Support owner</th><th className="py-3">Approval</th><th className="py-3">Updated</th></tr></thead>
            <tbody>{items.map((lead) => <tr key={lead.id} className="cursor-pointer" tabIndex={0} onClick={() => openLead(lead)} onKeyDown={(event) => { if (event.key === 'Enter') openLead(lead) }}>
              <td className="py-3"><span className="block font-semibold text-slate-800">{lead.contact_name}</span><span className="text-xs text-slate-500">{lead.email || lead.phone || 'Contact details missing'}</span></td>
              <td className="py-3"><span className="block">{lead.product?.name || 'Product missing'}</span><span className="text-xs text-slate-500">{lead.source}</span></td>
              <td className="py-3">{lead.support_assignee?.name || lead.support_verified_by?.name || 'Unassigned'}</td>
              <td className="py-3"><span className="crm-badge rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] text-emerald-900">{displayStatus(lead.approval_status)}</span></td>
              <td className="py-3 text-xs text-slate-500">{new Date(lead.submitted_for_approval_at || lead.follow_up_at || '').toLocaleDateString() || '—'}</td>
            </tr>)}</tbody>
          </table></div>}
      <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-500"><span>{total} leads · Page {page} of {pages}</span><div className="flex gap-2"><button type="button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)} className="rounded-lg border px-3 py-2 disabled:opacity-40">Previous</button><button type="button" disabled={page >= pages} onClick={() => setPage((current) => current + 1)} className="rounded-lg border px-3 py-2 disabled:opacity-40">Next</button></div></div>
    </section>

    {!isAdmin && <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
      <div className="mb-4">
        <h2 className="font-semibold text-slate-900">New anonymous product interests</h2>
        <p className="mt-1 text-xs text-slate-500">Visits without customer contact details stay as private, session-hashed activity until an enquiry identifies the visitor.</p>
      </div>
      {!productInterests.length ? <p className="py-3 text-sm text-slate-500">No unlinked product-interest events need review.</p>
        : <div className="overflow-x-auto"><table className="w-full min-w-[600px] text-left text-sm">
          <thead className="text-xs uppercase text-slate-500"><tr><th className="py-3">Product</th><th className="py-3">First viewed</th><th className="py-3">Last viewed</th><th className="py-3">Visits</th></tr></thead>
          <tbody>{productInterests.map((event) => <tr key={event.id}>
            <td className="py-3"><span className="block font-semibold">{event.product_name || 'Product unavailable'}</span><span className="text-xs text-slate-500">Product #{event.product_id} · Anonymous visitor</span></td>
            <td className="py-3 text-xs text-slate-500">{new Date(event.first_seen_at).toLocaleString()}</td>
            <td className="py-3 text-xs text-slate-500">{new Date(event.last_seen_at).toLocaleString()}</td>
            <td className="py-3">{event.visit_count}</td>
          </tr>)}</tbody>
        </table></div>}
      <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">{productInterestTotal} unlinked product-interest events · Page {page} of {pages}</p>
    </section>}

    {selected && <div className="fixed inset-0 z-40 flex justify-end bg-slate-950/45 backdrop-blur-sm" onClick={closeLead}>
      <section role="dialog" aria-modal="true" aria-label={`Review lead ${selected.contact_name}`} className="crm-surface h-full w-full max-w-2xl overflow-y-auto rounded-none border-y-0 border-r-0 p-5 shadow-2xl sm:rounded-l-3xl sm:p-7" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">Lead #{selected.id} · {selected.source}</p><h2 className="mt-2 text-xl font-semibold">{selected.contact_name}</h2><p className="mt-1 text-sm text-slate-500">{selected.product?.name || 'No product linked'} · {displayStatus(selected.approval_status)}</p></div><button type="button" onClick={closeLead} aria-label="Close lead details" className="rounded-lg border p-2"><X size={16} /></button></div>
        {selected.rejection_reason && <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"><strong>Correction requested:</strong> {selected.rejection_reason}</div>}
        {selected.review_comment && selected.approval_status === 'NEEDS_INFORMATION' && <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><strong>More information requested:</strong> {selected.review_comment}</div>}
        <div className="my-5 rounded-xl border border-slate-200 p-4 text-sm">
          <h3 className="mb-2 font-semibold">Product interest activity</h3>
          {selected.interest_events.length ? selected.interest_events.map((event) => <p key={event.id} className="text-slate-600">{event.product_name} · first viewed {new Date(event.first_seen_at).toLocaleString()} · {event.visit_count} visits</p>) : <p className="text-slate-500">Website enquiry; no product visit event recorded.</p>}
        </div>

        {!isAdmin && selected.approval_status !== 'PENDING_APPROVAL' && selected.approval_status !== 'APPROVED' && <form onSubmit={saveVerification} className="space-y-3 border-b border-slate-200 pb-5">
          <h3 className="font-semibold">Support verification</h3>
          <label className="block text-xs font-semibold">Customer name<input name="contact_name" required maxLength={160} defaultValue={selected.contact_name} className="form-input mt-1" /></label>
          <div className="grid gap-3 sm:grid-cols-2"><label className="block text-xs font-semibold">Email<input name="email" type="email" defaultValue={selected.email} className="form-input mt-1" /></label><label className="block text-xs font-semibold">Phone<input name="phone" defaultValue={selected.phone} className="form-input mt-1" /></label></div>
          <label className="block text-xs font-semibold">Company<input name="company" defaultValue={selected.company} className="form-input mt-1" /></label>
          <label className="block text-xs font-semibold">Customer requirements<textarea name="customer_requirements" required maxLength={5000} defaultValue={selected.customer_requirements} rows={3} className="form-input mt-1" /></label>
          <label className="block text-xs font-semibold">Support verification notes<textarea name="support_verification_notes" required maxLength={5000} defaultValue={selected.support_verification_notes} rows={3} className="form-input mt-1" /></label>
          <div className="grid gap-3 sm:grid-cols-2"><label className="block text-xs font-semibold">Customer response<select name="customer_interest_status" defaultValue={selected.customer_interest_status} className="form-input mt-1"><option value="AWAITING_RESPONSE">Awaiting response</option><option value="INTERESTED">Interested</option><option value="NOT_INTERESTED">Not interested</option></select></label><label className="block text-xs font-semibold">Purchase intent<select name="purchase_intent" defaultValue={selected.purchase_intent} className="form-input mt-1"><option value="UNKNOWN">Not yet known</option><option value="YES">Yes</option><option value="NO">No</option></select></label></div>
          <label className="block text-xs font-semibold">Follow-up reminder<input name="follow_up_at" type="datetime-local" defaultValue={selected.follow_up_at?.slice(0, 16) || ''} className="form-input mt-1" /></label>
          <div className="flex flex-wrap gap-2"><button disabled={busy} className="rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white">Save verification</button><button type="button" disabled={busy} onClick={() => void submitForApproval()} className="inline-flex items-center gap-2 rounded-lg border border-emerald-800 px-4 py-2.5 text-sm font-semibold text-emerald-900"><Send size={14} />Submit for approval</button></div>
        </form>}

        {!isAdmin && <form onSubmit={sendEmail} className="my-5 space-y-3 border-b border-slate-200 pb-5">
          <h3 className="flex items-center gap-2 font-semibold"><Mail size={16} />Contact customer</h3>
          <input name="subject" required maxLength={240} placeholder="Email subject" className="form-input" />
          <textarea name="body" required maxLength={10000} rows={3} placeholder="Write a message to the customer" className="form-input" />
          <button disabled={busy || !selected.email} className="rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-40">Queue email</button>
          <p className="text-xs text-slate-500">Uses the CRM system email configuration. A queued or SMTP-accepted message is not proof of customer receipt.</p>
        </form>}

        {isAdmin && selected.approval_status === 'PENDING_APPROVAL' && <section className="my-5 space-y-3 border-b border-slate-200 pb-5">
          <h3 className="font-semibold">Administrator decision</h3>
          <p className="text-sm text-slate-600">Verified by {selected.support_verified_by?.name || 'staff'}{selected.support_verified_by?.role ? ` (${selected.support_verified_by.role.replaceAll('_', ' ').toLowerCase()})` : ''} on {selected.submitted_for_approval_at ? new Date(selected.submitted_for_approval_at).toLocaleString() : '—'}</p>
          <p className="whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-sm">{selected.customer_requirements}</p>
          <p className="text-xs font-semibold text-slate-500">Sales/Support verification notes</p>
          <p className="whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-sm">{selected.support_verification_notes}</p>
          <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => void review('APPROVE')} className="inline-flex items-center gap-2 rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white"><Check size={15} />Approve</button><button type="button" disabled={busy} onClick={() => void reviewWithReason('NEEDS_INFORMATION')} className="rounded-lg border border-amber-300 px-4 py-2.5 text-sm font-semibold text-amber-900">Request information</button><button type="button" disabled={busy} onClick={() => void reviewWithReason('REJECT')} className="rounded-lg border border-rose-200 px-4 py-2.5 text-sm font-semibold text-rose-800">Reject</button></div>
        </section>}

        {selected.communications.length > 0 && <section className="my-5"><h3 className="mb-3 font-semibold">Email communication history</h3><div className="space-y-2">{selected.communications.map((communication) => <article key={communication.id} className="rounded-xl border border-slate-200 p-3"><div className="flex justify-between gap-2"><strong className="text-sm">{communication.subject}</strong><span className="text-xs text-slate-500">{displayStatus(communication.delivery_status)}</span></div><p className="mt-1 whitespace-pre-wrap text-xs text-slate-600">{communication.body}</p><p className="mt-2 text-[10px] text-slate-400">{new Date(communication.created_at).toLocaleString()}</p></article>)}</div></section>}
        <section className="my-5"><h3 className="mb-3 font-semibold">Approval history</h3><ol className="space-y-3 border-l border-slate-200 pl-4">{selected.approval_history.map((entry) => <li key={entry.id} className="text-xs"><p className="font-semibold">{displayStatus(entry.action)} · {entry.actor?.name || 'System'}</p>{entry.comment && <p className="mt-1 text-slate-600">{entry.comment}</p>}<p className="mt-1 text-slate-400">{new Date(entry.created_at).toLocaleString()}</p></li>)}</ol></section>
      </section>
    </div>}
  </div>
}

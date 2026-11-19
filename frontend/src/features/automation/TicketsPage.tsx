import { FormEvent, useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Paperclip, RefreshCw, Send } from 'lucide-react'
import api from '../../lib/api'
import { EmptyState, Skeleton } from '../../components/ui/Feedback'

type Product = { id: number; name: string }
type Person = { id: number; name: string; email: string; role: string }
type Comment = { id: number; author: Person | null; body: string; created_at: string }
type Meeting = { id: number; starts_at: string; jitsi_url: string; duration_minutes: number }
type Ticket = {
  id: number; ticket_number: string; subject: string; description: string
  issue_category: string; priority: string; status: string; department: string
  assignee: Person | null; customer: Person | null; product: { id: number; name: string } | null
  documents: { id: number; name: string }[]; meetings: Meeting[]; comments?: Comment[]
}
type Page = { results: Ticket[]; total: number }
type Profile = { id: number; role: string; department: string | null }

const categories = [
  ['PRODUCT_ENQUIRY', 'Product enquiry'],
  ['PRODUCT_DEFECT', 'Product defect'],
  ['TECHNICAL_SUPPORT', 'Technical support'],
]
const priorities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
const statuses = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'MEETING_SCHEDULED', 'RESOLVED', 'CLOSED']
const panel = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm'
const statusTone = (status: string) => ['RESOLVED', 'CLOSED'].includes(status)
  ? 'bg-emerald-50 text-emerald-700'
  : ['IN_PROGRESS', 'MEETING_SCHEDULED'].includes(status)
    ? 'bg-violet-50 text-violet-700'
    : status === 'ASSIGNED'
      ? 'bg-blue-50 text-blue-700'
      : 'bg-amber-50 text-amber-700'

export default function TicketsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedTicketId = searchParams.get('ticket')
  const [items, setItems] = useState<Ticket[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [profile, setProfile] = useState<Profile | null>(null)
  const [selected, setSelected] = useState<Ticket | null>(null)
  const [search, setSearch] = useState(() => searchParams.get('search') || '')
  const [statusFilter, setStatusFilter] = useState(() => searchParams.get('status') || '')
  const [priorityFilter, setPriorityFilter] = useState(() => searchParams.get('priority') || '')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [priorityBusy, setPriorityBusy] = useState(false)
  const customer = profile?.role === 'CUSTOMER'
  const admin = profile?.role === 'MAIN_ADMIN'
  const canSetPriority = Boolean(profile?.department && selected?.department === profile.department)

  useEffect(() => {
    setSearch(searchParams.get('search') || '')
    setStatusFilter(searchParams.get('status') || '')
    setPriorityFilter(searchParams.get('priority') || '')
  }, [searchParams])

  const loadTickets = useCallback(async () => {
    setLoading(true)
    try {
      const [{ data: me }, { data: productsList }] = await Promise.all([
        api.get<Profile>('/auth/me'),
        api.get<Product[]>('/products'),
      ])
      const params = new URLSearchParams()
      if (search.trim() && me.role !== 'MAIN_ADMIN') params.set('search', search.trim())
      if (statusFilter) params.set('status', statusFilter)
      if (priorityFilter && me.role !== 'MAIN_ADMIN') params.set('priority', priorityFilter)
      const { data: page } = await api.get<Page>(`/tickets?${params.toString()}`)
      setItems(page.results)
      setProfile(me)
      setProducts(productsList)
      setError('')
    } catch {
      setError('Tickets could not be loaded. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [priorityFilter, search, statusFilter])

  useEffect(() => { void loadTickets() }, [loadTickets])

  useEffect(() => {
    if (!requestedTicketId) {
      setSelected(null)
      return
    }
    if (!profile) {
      setSelected(null)
      return
    }
    let active = true
    setSelected(null)
    if (!/^\d+$/.test(requestedTicketId)) {
      setError('The selected ticket link is invalid.')
      return
    }
    api.get<Ticket>(`/tickets/${requestedTicketId}`).then(({ data }) => {
      if (active) {
        setSelected(data)
        setError('')
      }
    }).catch(() => {
      if (active) setError('This ticket could not be opened. It may no longer be available to your account.')
    })
    return () => { active = false }
  }, [profile, requestedTicketId])

  useEffect(() => {
    const refresh = () => { void loadTickets() }
    window.addEventListener('crm:refresh', refresh)
    return () => window.removeEventListener('crm:refresh', refresh)
  }, [loadTickets])

  useEffect(() => {
    if (!selected) return
    let active = true
    const refreshSelected = () => {
      void api.get<Ticket>(`/tickets/${selected.id}`).then(({ data }) => {
        if (active) setSelected(data)
      }).catch(() => {
        if (active) setError('The ticket conversation could not be refreshed.')
      })
    }
    window.addEventListener('crm:refresh', refreshSelected)
    return () => {
      active = false
      window.removeEventListener('crm:refresh', refreshSelected)
    }
  }, [selected])

  async function createTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    setBusy(true)
    setError('')
    try {
      const file = data.get('file') as File | null
      const response = await api.post<{ ticket: Ticket }>('/tickets', {
        subject: data.get('subject'),
        description: data.get('description'),
        issue_category: data.get('issue_category'),
        product_id: data.get('product_id') ? Number(data.get('product_id')) : null,
      })
      if (file?.size) {
        const attachment = new FormData()
        attachment.append('file', file)
        await api.post(`/tickets/${response.data.ticket.id}/documents`, attachment, { headers: { 'Content-Type': 'multipart/form-data' } })
      }
      form.reset()
      await loadTickets()
      setSelected((await api.get<Ticket>(`/tickets/${response.data.ticket.id}`)).data)
    } catch {
      setError('The ticket could not be created. Verify the form fields and attachment, then retry.')
    } finally {
      setBusy(false)
    }
  }

  async function changeStatus(ticket: Ticket, status: string) {
    try {
      await api.patch(`/tickets/${ticket.id}`, { status })
      if (selected?.id === ticket.id) {
        const { data } = await api.get<Ticket>(`/tickets/${ticket.id}`)
        setSelected(data)
      }
      await loadTickets()
    } catch { setError('Ticket status could not be updated.') }
  }

  async function changePriority(ticket: Ticket, priority: string) {
    setPriorityBusy(true)
    try {
      const { data } = await api.patch<Ticket>(`/tickets/${ticket.id}`, { priority })
      setSelected((current) => current?.id === ticket.id ? { ...current, ...data } : current)
      await loadTickets()
    } catch {
      setError("Only the main admin or the ticket's assigned department can change its priority.")
    } finally {
      setPriorityBusy(false)
    }
  }

  async function addComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected) return
    const form = event.currentTarget
    const body = String(new FormData(form).get('body') || '').trim()
    if (!body) return
    try {
      await api.post(`/tickets/${selected.id}/comments`, { body })
      form.reset()
      const { data } = await api.get<Ticket>(`/tickets/${selected.id}`)
      setSelected(data)
    } catch { setError('Your message could not be sent.') }
  }

  async function openTicket(ticket: Ticket) {
    try {
      const { data } = await api.get<Ticket>(`/tickets/${ticket.id}`)
      setSelected(data)
      setError('')
    } catch { setError('Ticket details could not be loaded.') }
  }

  function closeTicket() {
    setSelected(null)
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.delete('ticket')
      return next
    }, { replace: true })
  }

  return <div className="space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><p className="text-xs font-semibold uppercase tracking-wide text-blue-600">Customer service</p><h1 className="mt-2 text-3xl font-bold">Tickets</h1><p className="mt-2 text-sm text-slate-500">{customer ? 'Submit a request and track its progress.' : admin ? 'Review ticket overviews and read-only details.' : 'Review assigned work, update progress, and communicate with customers.'}</p></div>
      <button onClick={() => void loadTickets()} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold"><RefreshCw size={16} />Refresh</button>
    </div>
    {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
    {customer && <section className={panel}>
      <h2 className="mb-4 font-semibold">Open a support ticket</h2>
      <form onSubmit={createTicket} className="grid gap-4 md:grid-cols-2">
        <label className="text-sm">Subject<input name="subject" maxLength={240} required className="form-input mt-1" /></label>
        <label className="text-sm">Product<select name="product_id" className="form-input mt-1"><option value="">Choose a product (optional)</option>{products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="text-sm">Issue category<select name="issue_category" required className="form-input mt-1">{categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="text-sm md:col-span-2">Details<textarea name="description" required maxLength={20000} rows={4} className="form-input mt-1" /></label>
        <label className="text-sm md:col-span-2">Supporting document<input name="file" type="file" accept=".pdf,.png,.jpg,.jpeg,.gif,.txt,.csv,.doc,.docx,.xls,.xlsx" className="form-input mt-1" /></label>
        <button disabled={busy} className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60 md:col-span-2">{busy ? 'Submitting…' : 'Submit ticket'}</button>
      </form>
    </section>}
    <section className={panel}>
      <div className={`mb-4 grid gap-3 ${admin ? 'sm:grid-cols-1' : 'sm:grid-cols-[1fr_190px_190px]'}`}>
        {!admin && <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tickets or customers" className="form-input" />}
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="form-input"><option value="">All statuses</option>{statuses.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select>
        {!admin && <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)} className="form-input"><option value="">All priorities</option>{priorities.map((value) => <option key={value} value={value}>{value}</option>)}</select>}
      </div>
      {loading ? <div className="space-y-4 py-3" aria-label="Loading tickets">{Array.from({ length: 5 }, (_, index) => <div key={index} className="grid gap-4 grid-cols-6"><Skeleton className="h-4 w-20" /><Skeleton className="h-4 w-4/5" /><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-14" /><Skeleton className="h-4 w-20" /><Skeleton className="h-4 w-24" /></div>)}</div> : !items.length ? <EmptyState icon={Paperclip} title="No tickets found" description="Try adjusting the search or filters to see more results." /> : <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm">
        <thead className="text-xs uppercase text-slate-400"><tr><th className="pb-3">Number</th><th className="pb-3">Subject</th><th className="pb-3">Customer</th><th className="pb-3">Priority</th><th className="pb-3">Status</th><th className="pb-3">Team</th></tr></thead>
        <tbody>{items.map((ticket) => <tr key={ticket.id} tabIndex={0} aria-label={`View ticket ${ticket.ticket_number}`} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-blue-600" onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void openTicket(ticket) } }} onClick={() => void openTicket(ticket)}>
          <td className="py-3 font-semibold text-blue-700">{ticket.ticket_number}</td><td className="py-3">{ticket.subject}</td><td className="py-3">{ticket.customer?.name || 'Deleted account'}</td><td className="py-3"><span className="crm-badge rounded-full bg-slate-100 px-2 py-1 text-[10px] text-slate-700">{ticket.priority}</span></td><td className="py-3"><span className={`crm-badge rounded-full px-2 py-1 text-[10px] ${statusTone(ticket.status)}`}>{ticket.status.replaceAll('_', ' ')}</span></td><td className="py-3">{ticket.department}</td>
        </tr>)}</tbody>
      </table></div>}
    </section>
    {selected && <div className="fixed inset-0 z-40 flex justify-end bg-slate-950/45 backdrop-blur-sm" onClick={closeTicket}>
      <section className="crm-surface h-full w-full max-w-2xl overflow-y-auto rounded-none border-y-0 border-r-0 p-5 shadow-2xl sm:rounded-l-3xl sm:p-8" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold text-blue-700">{selected.ticket_number} · {selected.department}</p><h2 className="mt-2 text-2xl font-bold">{selected.subject}</h2><p className="mt-2 text-sm text-slate-500">{selected.customer?.name || 'Deleted account'} · {selected.priority}</p></div><button onClick={closeTicket} className="rounded-lg border px-3 py-2 text-sm">Close</button></div>
        {admin && <section aria-label="Ticket overview" className="my-5 grid gap-3 rounded-xl bg-slate-50 p-4 text-sm sm:grid-cols-2">
          <div><p className="text-xs text-slate-500">Status</p><span className={`crm-badge mt-1 inline-block rounded-full px-2 py-1 text-[10px] ${statusTone(selected.status)}`}>{selected.status.replaceAll('_', ' ')}</span></div>
          <div><p className="text-xs text-slate-500">Priority</p><p className="mt-1 font-medium">{selected.priority}</p></div>
          <div><p className="text-xs text-slate-500">Issue category</p><p className="mt-1 font-medium">{selected.issue_category.replaceAll('_', ' ')}</p></div>
          <div><p className="text-xs text-slate-500">Customer</p><p className="mt-1 font-medium">{selected.customer?.name || 'Deleted account'}{selected.customer?.email ? ` · ${selected.customer.email}` : ''}</p></div>
          <div><p className="text-xs text-slate-500">Product</p><p className="mt-1 font-medium">{selected.product?.name || 'No product'}</p></div>
          <div><p className="text-xs text-slate-500">Assignee</p><p className="mt-1 font-medium">{selected.assignee?.name || 'Unassigned'}</p></div>
        </section>}
        <p className="my-5 whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-sm leading-6">{selected.description}</p>
        {!customer && !admin && <div className="mb-5 flex flex-wrap items-end gap-3">
          <label className="min-w-52 flex-1 text-sm font-semibold">Ticket status<select value={selected.status} onChange={(event) => void changeStatus(selected, event.target.value)} className="form-input mt-2 font-normal">{statuses.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>
          {canSetPriority && <label className="min-w-40 flex-1 text-sm font-semibold">Ticket priority<select disabled={priorityBusy} value={selected.priority} onChange={(event) => void changePriority(selected, event.target.value)} className="form-input mt-2 font-normal disabled:opacity-60">{priorities.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}
          {!customer && !canSetPriority && <p className="pb-3 text-xs text-slate-500">Priority changes are limited to the Main Admin and this ticket’s assigned department.</p>}
        </div>}
        {!admin && selected.meetings.map((meeting) => <a key={meeting.id} href={meeting.jitsi_url} target="_blank" rel="noreferrer" className="mb-4 block rounded-xl bg-blue-50 p-4 text-sm font-semibold text-blue-800">Join meeting · {new Date(meeting.starts_at).toLocaleString()}</a>)}
        {!admin && selected.documents.map((doc) => <button key={doc.id} onClick={async () => {
          try {
            const { data } = await api.get(`/tickets/${selected.id}/documents/${doc.id}`, { responseType: 'blob' })
            const url = URL.createObjectURL(data)
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = doc.name
            anchor.click()
            URL.revokeObjectURL(url)
          } catch { setError('The attachment could not be downloaded.') }
        }} className="mb-2 flex items-center gap-2 text-sm text-blue-700"><Paperclip size={15} />{doc.name}</button>)}
        {!admin && <><div className="my-6 space-y-3"><h3 className="font-semibold">Conversation</h3>{selected.comments?.length ? selected.comments.map((comment) => <article key={comment.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900/55"><p className="text-xs font-semibold">{comment.author?.name || 'Deleted account'}<time className="ml-2 font-normal text-slate-400">{new Date(comment.created_at).toLocaleString()}</time></p><p className="mt-2 whitespace-pre-wrap text-sm">{comment.body}</p></article>) : <EmptyState title="No messages yet" description="Messages about this ticket will appear here." />}</div>
        <form onSubmit={addComment} className="flex gap-2"><input name="body" maxLength={10000} required placeholder="Write a message…" className="form-input flex-1" /><button aria-label="Send message" className="rounded-xl bg-blue-600 px-4 text-white"><Send size={17} /></button></form></>}
      </section>
    </div>}
  </div>
}

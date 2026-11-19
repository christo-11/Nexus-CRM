import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileText,
  Headphones,
  LifeBuoy,
  MessageCircle,
  MessageSquare,
  Package,
  Paperclip,
  Plus,
  Search,
  Send,
  Sparkles,
  Ticket as TicketIcon,
  UserRoundPlus,
  Upload,
  X,
} from 'lucide-react'
import api from '../../lib/api'
import { Link } from 'react-router-dom'

type Profile = { id: number; name: string; email: string; role: string; department: string | null }
type Product = { id: number; name: string; category: string; description: string; price: string; status: string }
type Person = { id: number; name: string; email: string; role: string }
type Comment = { id: number; author: Person | null; body: string; created_at: string; is_internal: boolean }
type Document = { id: number; name: string; content_type: string; created_at: string }
type Meeting = { id: number; ticket_id: number; ticket_number: string; starts_at: string; duration_minutes: number; jitsi_url: string }
type Ticket = {
  id: number
  ticket_number: string
  subject: string
  description: string
  issue_category: string
  priority: string
  status: string
  department: string
  created_at: string
  product: { id: number; name: string } | null
  documents: Document[]
  meetings: Meeting[]
  comments?: Comment[]
}
type TicketPage = { results: Ticket[]; total: number }
type RecentBrowse = { id: number; viewedAt: string }

const recentStorageKey = 'smart-crm.customer.recent-products'
const interestSessionKey = 'smart-crm.customer.interest-session'
const issueCategories = [
  { value: 'PRODUCT_ENQUIRY', label: 'Product enquiry' },
  { value: 'PRODUCT_DEFECT', label: 'Product defect' },
  { value: 'TECHNICAL_SUPPORT', label: 'Technical support' },
]
const acceptedFiles = '.pdf,.png,.jpg,.jpeg,.gif,.txt,.csv,.doc,.docx,.xls,.xlsx'

function readRecentBrowses(): RecentBrowse[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(recentStorageKey) || '[]')
    if (!Array.isArray(value)) return []
    return value.filter((item): item is RecentBrowse =>
      typeof item === 'object' && item !== null &&
      typeof item.id === 'number' && typeof item.viewedAt === 'string',
    ).slice(0, 5)
  } catch {
    return []
  }
}

function formatLabel(value: string) {
  return value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function statusStyle(status: string) {
  if (status === 'RESOLVED' || status === 'CLOSED') return 'crm-badge bg-emerald-50 text-emerald-700'
  if (status === 'IN_PROGRESS' || status === 'MEETING_SCHEDULED') return 'crm-badge bg-violet-50 text-violet-700'
  if (status === 'ASSIGNED') return 'crm-badge bg-blue-50 text-blue-700'
  return 'crm-badge bg-amber-50 text-amber-700'
}

function priorityStyle(priority: string) {
  if (priority === 'CRITICAL') return 'crm-badge bg-rose-50 text-rose-700'
  if (priority === 'HIGH') return 'crm-badge bg-orange-50 text-orange-700'
  if (priority === 'LOW') return 'crm-badge bg-slate-100 text-slate-600'
  return 'crm-badge bg-sky-50 text-sky-700'
}

const card = 'panel-card'

export default function CustomerPortalPage({ profile }: { profile: Profile }) {
  const [products, setProducts] = useState<Product[]>([])
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [recentBrowses, setRecentBrowses] = useState<RecentBrowse[]>(readRecentBrowses)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All categories')
  const [ticketFilter, setTicketFilter] = useState('ALL')
  const [prefillProductId, setPrefillProductId] = useState<number | null>(null)
  const [viewedProduct, setViewedProduct] = useState<Product | null>(null)
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null)
  const [ticketFormOpen, setTicketFormOpen] = useState(false)
  const [leadFormOpen, setLeadFormOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [leadSubmitting, setLeadSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const loadDashboard = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [productResponse, ticketResponse, meetingResponse] = await Promise.all([
        api.get<Product[]>('/products'),
        api.get<TicketPage>('/tickets?per_page=100&sort=created_at&direction=desc'),
        api.get<Meeting[]>('/meetings?upcoming=true'),
      ])
      setProducts(productResponse.data)
      setTickets(ticketResponse.data.results)
      setMeetings(meetingResponse.data)
    } catch {
      setError('Your dashboard could not be loaded. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDashboard()
    const refresh = () => { void loadDashboard() }
    window.addEventListener('crm:refresh', refresh)
    return () => window.removeEventListener('crm:refresh', refresh)
  }, [loadDashboard])

  useEffect(() => {
    if (!selectedTicket) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedTicket(null)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [selectedTicket])

  const categories = useMemo(() => ['All categories', ...new Set(products.map((product) => product.category))], [products])
  const visibleProducts = useMemo(() => products.filter((product) =>
    (category === 'All categories' || product.category === category) &&
    `${product.name} ${product.description} ${product.category}`.toLowerCase().includes(search.trim().toLowerCase()),
  ), [category, products, search])
  const activeTickets = tickets.filter((ticket) => !['RESOLVED', 'CLOSED'].includes(ticket.status))
  const upcomingMeetings = meetings.filter((meeting) => new Date(meeting.starts_at).getTime() >= Date.now())
  const recentProducts = recentBrowses
    .map((browse) => ({ ...browse, product: products.find((product) => product.id === browse.id) }))
    .filter((item): item is RecentBrowse & { product: Product } => Boolean(item.product))
  const filteredTickets = ticketFilter === 'ALL'
    ? tickets
    : ticketFilter === 'RESOLVED'
      ? tickets.filter((ticket) => ['RESOLVED', 'CLOSED'].includes(ticket.status))
      : tickets.filter((ticket) => ticket.status === ticketFilter)

  async function trackProductBrowse(product: Product) {
    const next = [{ id: product.id, viewedAt: new Date().toISOString() }, ...recentBrowses.filter((item) => item.id !== product.id)].slice(0, 5)
    setRecentBrowses(next)
    localStorage.setItem(recentStorageKey, JSON.stringify(next))
    let sessionRef = localStorage.getItem(interestSessionKey)
    if (!sessionRef) {
      sessionRef = crypto.randomUUID()
      localStorage.setItem(interestSessionKey, sessionRef)
    }
    try {
      await api.post('/product-interests', { product_id: product.id, session_ref: sessionRef })
    } catch {
      setError('This product view could not be recorded. You can still contact us about the product.')
    }
  }

  async function createTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    setMessage('')
    const form = event.currentTarget
    const values = new FormData(form)
    try {
      const response = await api.post<{ ticket: Ticket }>('/tickets', {
        subject: String(values.get('subject') || '').trim(),
        description: String(values.get('description') || '').trim(),
        issue_category: values.get('issue_category'),
        product_id: values.get('product_id') ? Number(values.get('product_id')) : null,
      })
      let attachmentFailed = false
      const file = values.get('file')
      if (file instanceof File && file.size > 0) {
        const attachment = new FormData()
        attachment.append('file', file)
        try {
          await api.post(`/tickets/${response.data.ticket.id}/documents`, attachment, {
            headers: { 'Content-Type': 'multipart/form-data' },
          })
        } catch {
          attachmentFailed = true
        }
      }
      form.reset()
      setTicketFormOpen(false)
      setPrefillProductId(null)
      setMessage(attachmentFailed
        ? `Ticket ${response.data.ticket.ticket_number} was created, but its attachment could not be uploaded. You can retry from the ticket details.`
        : `Ticket ${response.data.ticket.ticket_number} was submitted successfully.`)
      await loadDashboard()
      try {
        const { data } = await api.get<Ticket>(`/tickets/${response.data.ticket.id}`)
        setSelectedTicket(data)
      } catch {
        setError('Your ticket was submitted, but its details could not be opened. Select it from Your tickets to view it.')
      }
    } catch {
      setError('The ticket could not be submitted. Check the details and attachment, then try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function createSalesLead(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLeadSubmitting(true)
    setError('')
    setMessage('')
    const values = new FormData(event.currentTarget)
    try {
      const response = await api.post<{ lead_created: boolean; confirmation_email_queued: boolean }>('/leads/enquiry', {
        type: 'sales_enquiry',
        product_id: Number(values.get('product_id')),
        message: String(values.get('message') || '').trim(),
        company: String(values.get('company') || '').trim(),
        phone: String(values.get('phone') || '').trim(),
      })
      setLeadFormOpen(false)
      setPrefillProductId(null)
      setMessage(response.data.lead_created
        ? response.data.confirmation_email_queued
          ? 'Your sales enquiry was submitted. A confirmation email is on its way, and our sales team will follow up with you.'
          : 'Your sales enquiry was submitted, but an email confirmation could not be queued. Our sales team will follow up with you.'
        : 'Your enquiry was added to your existing sales conversation. Our team will follow up with you.')
    } catch {
      setError('Your sales enquiry could not be submitted. Check the product and message, then try again.')
    } finally {
      setLeadSubmitting(false)
    }
  }

  async function openTicket(ticket: Ticket) {
    setError('')
    try {
      const { data } = await api.get<Ticket>(`/tickets/${ticket.id}`)
      setSelectedTicket(data)
    } catch {
      setError('Ticket details could not be loaded. Please try again.')
    }
  }

  async function refreshSelectedTicket() {
    if (!selectedTicket) return
    try {
      const { data } = await api.get<Ticket>(`/tickets/${selectedTicket.id}`)
      setSelectedTicket(data)
    } catch {
      setError('The ticket conversation could not be refreshed.')
    }
  }

  async function addComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedTicket) return
    const form = event.currentTarget
    const body = String(new FormData(form).get('body') || '').trim()
    if (!body) return
    try {
      await api.post(`/tickets/${selectedTicket.id}/comments`, { body })
      form.reset()
      await refreshSelectedTicket()
    } catch {
      setError('Your message could not be sent. Please try again.')
    }
  }

  async function uploadAttachment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedTicket) return
    const form = event.currentTarget
    const file = new FormData(form).get('file')
    if (!(file instanceof File) || !file.size) {
      setError('Choose a file before uploading.')
      return
    }
    const attachment = new FormData()
    attachment.append('file', file)
    try {
      await api.post(`/tickets/${selectedTicket.id}/documents`, attachment, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      form.reset()
      await refreshSelectedTicket()
      setMessage('Attachment uploaded.')
    } catch {
      setError('The attachment could not be uploaded. Check the file type and size.')
    }
  }

  async function downloadAttachment(document: Document) {
    if (!selectedTicket) return
    try {
      const { data } = await api.get(`/tickets/${selectedTicket.id}/documents/${document.id}`, { responseType: 'blob' })
      const url = URL.createObjectURL(data)
      const anchor = window.document.createElement('a')
      anchor.href = url
      anchor.download = document.name
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      setError('This attachment could not be downloaded.')
    }
  }

  return <div className="space-y-8">
    <section className="crm-hero relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#111827] via-[#1e1b4b] to-[#1d4ed8] px-6 py-8 text-white shadow-panel sm:px-9 sm:py-10">
      <div className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full border-[36px] border-white/5" />
      <div className="pointer-events-none absolute bottom-[-6rem] right-40 h-48 w-48 rounded-full bg-cyan-300/10 blur-2xl" />
      <div className="relative flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-2xl">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-cyan-200"><span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />Customer workspace</p>
          <h1 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">Good to see you, {profile.name.split(' ')[0] || 'there'}.</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-blue-100 sm:text-base">Your products, support requests, and upcoming conversations—all in one place.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button onClick={() => { setPrefillProductId(null); setLeadFormOpen(true); setMessage('') }} className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-semibold text-emerald-950 shadow-lg transition hover:bg-emerald-50">
            <UserRoundPlus size={17} /> Talk to sales
          </button>
          <button onClick={() => { setPrefillProductId(null); setTicketFormOpen(true); setMessage('') }} className="inline-flex items-center gap-2 rounded-xl border border-white/25 bg-white/10 px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/20">
            <Plus size={17} /> Create a ticket
          </button>
          <Link to="/feedback" className="inline-flex items-center gap-2 rounded-xl border border-white/25 bg-white/10 px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/20">
            <MessageSquare size={17} /> Share feedback
          </Link>
        </div>
      </div>
    </section>

    {error && <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={16} /></button></div>}
    {message && <div role="status" className="flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"><span>{message}</span><button onClick={() => setMessage('')} aria-label="Dismiss message"><X size={16} /></button></div>}

    <section aria-label="Account overview" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <OverviewCard icon={TicketIcon} label="Active tickets" value={loading ? '—' : activeTickets.length} detail={activeTickets.length === 1 ? 'Request needs attention' : 'Requests in progress'} tone="blue" />
      <OverviewCard icon={Package} label="Products explored" value={recentBrowses.length} detail="Recently viewed in this browser" tone="violet" />
      <OverviewCard icon={CalendarDays} label="Upcoming meetings" value={loading ? '—' : upcomingMeetings.length} detail={upcomingMeetings[0] ? `Next ${new Date(upcomingMeetings[0].starts_at).toLocaleDateString()}` : 'No meetings scheduled'} tone="emerald" />
      <OverviewCard icon={CheckCircle2} label="Resolved tickets" value={loading ? '—' : tickets.filter((ticket) => ['RESOLVED', 'CLOSED'].includes(ticket.status)).length} detail="Your completed requests" tone="amber" />
    </section>

    <section className="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(290px,0.8fr)]">
      <div className={`${card} overflow-hidden`}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-5 sm:px-6">
          <div><p className="text-xs font-semibold uppercase tracking-wider text-blue-600">Discover</p><h2 className="mt-1 text-lg font-bold text-slate-900">Product catalogue</h2><p className="mt-1 text-xs text-slate-500">Explore active products and services.</p></div>
          <span className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-600">{products.length} available</span>
        </div>
        <div className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_200px] sm:px-6">
          <label className="relative block"><Search size={16} className="absolute left-3 top-3.5 text-slate-400" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search products" aria-label="Search products" className="form-input py-2.5 pl-9 text-sm" /></label>
          <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Filter products by category" className="form-input py-2.5 text-sm">{categories.map((item) => <option key={item}>{item}</option>)}</select>
        </div>
        {loading ? <LoadingState label="Loading catalogue…" /> : visibleProducts.length ? <div className="grid gap-3 px-5 pb-5 sm:grid-cols-2 sm:px-6 xl:grid-cols-3">
          {visibleProducts.slice(0, 6).map((product) => <article key={product.id} className="panel-card flex min-h-48 flex-col p-4">
            <div className="flex items-start justify-between gap-2"><span className="grid h-10 w-10 place-items-center rounded-xl bg-blue-50 text-blue-700"><Package size={19} /></span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-semibold text-slate-500">{product.category}</span></div>
            <h3 className="mt-4 font-semibold text-slate-900">{product.name}</h3>
            <p className="mt-1 line-clamp-2 flex-1 text-xs leading-5 text-slate-500">{product.description || 'Learn more about this product by contacting our team.'}</p>
            <button onClick={() => { setViewedProduct(product); void trackProductBrowse(product); setMessage('') }} className="mt-4 inline-flex items-center gap-1.5 self-start text-xs font-semibold text-blue-700 hover:text-blue-900">View product details <ArrowRight size={14} /></button>
          </article>)}
        </div> : <EmptyState icon={Package} title="No products found" detail={products.length ? 'Try another search or category.' : 'The product catalogue is currently empty.'} />}
      </div>

      <div className="space-y-6">
        <section className={`${card} overflow-hidden`}>
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-5"><div><p className="text-xs font-semibold uppercase tracking-wider text-violet-600">Your activity</p><h2 className="mt-1 text-base font-bold text-slate-900">Recently explored</h2></div><Clock3 size={18} className="text-slate-400" /></div>
          {recentProducts.length ? <div className="divide-y divide-slate-100">{recentProducts.slice(0, 4).map(({ product, viewedAt }) => <div key={product.id} className="flex items-center gap-3 px-5 py-3.5"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-violet-50 text-violet-700"><Package size={16} /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-slate-800">{product.name}</p><p className="mt-0.5 text-[10px] text-slate-400">{product.category} · {new Date(viewedAt).toLocaleDateString()}</p></div></div>)}</div> : <p className="px-5 py-7 text-center text-xs leading-5 text-slate-500">Products you ask about will appear here for this browser.</p>}
        </section>
        <section className={`${card} overflow-hidden`}>
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-5"><div><p className="text-xs font-semibold uppercase tracking-wider text-emerald-600">On your calendar</p><h2 className="mt-1 text-base font-bold text-slate-900">Upcoming meetings</h2></div><CalendarDays size={18} className="text-slate-400" /></div>
          {loading ? <LoadingState label="Loading meetings…" /> : upcomingMeetings.length ? <div className="divide-y divide-slate-100">{upcomingMeetings.slice(0, 3).map((meeting) => <div key={meeting.id} className="flex items-center gap-3 px-5 py-4"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700"><CalendarDays size={17} /></span><div className="min-w-0 flex-1"><p className="text-xs font-semibold text-slate-800">Ticket {meeting.ticket_number}</p><p className="mt-1 text-[10px] text-slate-500">{new Date(meeting.starts_at).toLocaleString()}</p></div><a href={meeting.jitsi_url} target="_blank" rel="noreferrer" aria-label={`Join meeting for ticket ${meeting.ticket_number}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-600 text-white hover:bg-blue-700"><ExternalLink size={15} /></a></div>)}</div> : <p className="px-5 py-7 text-center text-xs text-slate-500">No upcoming ticket meetings.</p>}
        </section>
      </div>
    </section>

    {viewedProduct && <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm" onClick={() => setViewedProduct(null)}>
      <section role="dialog" aria-modal="true" aria-labelledby="product-detail-title" className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">{viewedProduct.category}</p><h2 id="product-detail-title" className="mt-2 text-xl font-semibold text-slate-900">{viewedProduct.name}</h2></div><button type="button" onClick={() => setViewedProduct(null)} aria-label="Close product details" className="rounded-lg border border-slate-200 p-2 text-slate-500"><X size={16} /></button></div>
        <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-slate-600">{viewedProduct.description || 'Contact our team to learn more about this product.'}</p>
        <p className="mt-4 text-lg font-semibold text-slate-900">${Number(viewedProduct.price).toFixed(2)}</p>
        <p className="mt-3 text-xs text-slate-500">Viewing this product records product interest for our support team. A visit alone does not create an approved lead or customer account.</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" onClick={() => { setPrefillProductId(viewedProduct.id); setViewedProduct(null); setLeadFormOpen(true); setMessage('') }} className="inline-flex items-center gap-2 rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white"><MessageCircle size={16} />Ask sales about this product</button>
          <button type="button" onClick={() => { setPrefillProductId(viewedProduct.id); setViewedProduct(null); setTicketFormOpen(true); setMessage('') }} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"><LifeBuoy size={16} />Get product support</button>
        </div>
      </section>
    </div>}

    <section className={`${card} overflow-hidden`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-5 sm:px-6">
        <div><p className="text-xs font-semibold uppercase tracking-wider text-blue-600">Support centre</p><h2 className="mt-1 text-lg font-bold text-slate-900">Your tickets</h2><p className="mt-1 text-xs text-slate-500">Track requests and continue conversations with our team.</p></div>
        <button onClick={() => { setPrefillProductId(null); setTicketFormOpen(true); setMessage('') }} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-3.5 py-2.5 text-xs font-semibold text-white hover:bg-blue-700"><Plus size={15} />New ticket</button>
      </div>
      <div className="flex gap-2 overflow-x-auto border-b border-slate-100 px-5 py-3 sm:px-6">
        {[['ALL', 'All tickets'], ['NEW', 'New'], ['IN_PROGRESS', 'In progress'], ['RESOLVED', 'Resolved']].map(([value, label]) => <button key={value} onClick={() => setTicketFilter(value)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${ticketFilter === value ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{label}</button>)}
      </div>
      {loading ? <LoadingState label="Loading tickets…" /> : filteredTickets.length ? <div className="divide-y divide-slate-100">
        {filteredTickets.map((ticket) => <button key={ticket.id} onClick={() => void openTicket(ticket)} className="flex w-full flex-wrap items-center gap-3 px-5 py-4 text-left transition hover:bg-slate-50 sm:px-6">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-700"><LifeBuoy size={18} /></span>
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-900">{ticket.subject}</span><span className="mt-1 block text-[10px] text-slate-400">{ticket.ticket_number} · {new Date(ticket.created_at).toLocaleDateString()}{ticket.product ? ` · ${ticket.product.name}` : ''}</span></span>
          <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${statusStyle(ticket.status)}`}>{formatLabel(ticket.status)}</span>
          <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${priorityStyle(ticket.priority)}`}>{formatLabel(ticket.priority)}{ticket.priority === 'CRITICAL' ? ' · Urgent' : ''}</span>
          <ArrowRight size={16} className="ml-auto text-slate-300 sm:ml-1" />
        </button>)}
      </div> : <EmptyState icon={TicketIcon} title="No tickets here" detail={tickets.length ? 'There are no tickets with this status.' : 'When you contact support, your tickets will show up here.'} />}
    </section>

    <section className="flex flex-col gap-4 rounded-2xl border border-blue-100 bg-blue-50/70 p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-blue-700 shadow-sm"><Headphones size={19} /></span><div><h2 className="text-sm font-bold text-slate-900">Need a hand?</h2><p className="mt-1 text-xs text-slate-600">Our support team is here to help with your products and account.</p></div></div>
      <button onClick={() => { setPrefillProductId(null); setTicketFormOpen(true); setMessage('') }} className="inline-flex items-center justify-center gap-2 rounded-xl border border-blue-200 bg-white px-4 py-2.5 text-xs font-semibold text-blue-800 hover:bg-blue-100"><MessageCircle size={15} />Contact support</button>
    </section>

    {leadFormOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget && !leadSubmitting) { setLeadFormOpen(false); setPrefillProductId(null) } }}>
      <section role="dialog" aria-modal="true" aria-labelledby="sales-enquiry-title" className="grid max-h-[min(760px,calc(100vh-2rem))] w-full max-w-4xl overflow-hidden rounded-3xl bg-white shadow-2xl md:grid-cols-[0.8fr_1.2fr]">
        <aside className="relative hidden flex-col justify-between overflow-hidden bg-emerald-950 p-8 text-white md:flex">
          <div className="pointer-events-none absolute -right-20 -top-16 h-64 w-64 rounded-full border border-white/10" />
          <div className="relative">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-emerald-300/15 text-emerald-200"><Sparkles size={22} /></span>
            <p className="mt-8 text-[11px] font-bold uppercase tracking-[.2em] text-emerald-300">Sales enquiry</p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight">Let&apos;s find the right fit for your team.</h2>
            <p className="mt-4 text-sm leading-6 text-emerald-100/75">Share what you&apos;re interested in. A member of our sales team will get back to you.</p>
          </div>
          <p className="relative text-xs text-emerald-200/60">Your account details are included automatically.</p>
        </aside>
        <div className="flex min-h-0 flex-col overflow-y-auto">
          <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-5 sm:px-7">
            <div>
              <p className="text-xs font-bold uppercase tracking-[.16em] text-emerald-700">New opportunity</p>
              <h2 id="sales-enquiry-title" className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Contact sales</h2>
              <p className="mt-1 text-sm text-slate-500">{profile.name} · {profile.email}</p>
            </div>
            <button type="button" aria-label="Close sales enquiry" disabled={leadSubmitting} onClick={() => { setLeadFormOpen(false); setPrefillProductId(null) }} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-slate-500 transition hover:bg-slate-100 disabled:opacity-50"><X size={18} /></button>
          </header>
          <form onSubmit={(event) => void createSalesLead(event)} className="flex min-h-0 flex-1 flex-col">
            <div className="space-y-5 overflow-y-auto px-5 py-6 sm:px-7">
              <label className="block text-xs font-semibold text-slate-600">Product you&apos;re interested in <span className="text-rose-700">*</span>
                <select name="product_id" required defaultValue={prefillProductId ?? ''} className="form-input mt-1.5">
                  <option value="" disabled>Choose a product</option>
                  {products.map((product) => <option key={product.id} value={product.id}>{product.name} · ${Number(product.price).toFixed(2)}</option>)}
                </select>
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-xs font-semibold text-slate-600">Company <span className="font-normal text-slate-400">Optional</span><input name="company" autoComplete="organization" maxLength={180} className="form-input mt-1.5" placeholder="Your organization" /></label>
                <label className="block text-xs font-semibold text-slate-600">Phone <span className="font-normal text-slate-400">Optional</span><input name="phone" autoComplete="tel" maxLength={40} className="form-input mt-1.5" placeholder="Best contact number" /></label>
              </div>
              <label className="block text-xs font-semibold text-slate-600">How can our sales team help? <span className="text-rose-700">*</span><textarea name="message" required maxLength={20000} rows={5} className="form-input mt-1.5 resize-y" placeholder="Tell us what you need, your goals, or any questions about the product." /></label>
            </div>
            <footer className="mt-auto flex gap-3 border-t border-slate-100 bg-slate-50/80 px-5 py-4 sm:px-7">
              <button type="button" disabled={leadSubmitting} onClick={() => { setLeadFormOpen(false); setPrefillProductId(null) }} className="rounded-xl border border-slate-200 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60">Cancel</button>
              <button type="submit" disabled={leadSubmitting || loading || products.length === 0} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-800 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-900 disabled:cursor-wait disabled:opacity-60">{leadSubmitting ? 'Sending enquiry…' : 'Send sales enquiry'}{!leadSubmitting && <ArrowRight size={16} />}</button>
            </footer>
          </form>
        </div>
      </section>
    </div>}

    {ticketFormOpen && <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-950/50 sm:items-center sm:p-5" onMouseDown={(event) => { if (event.target === event.currentTarget) setTicketFormOpen(false) }}>
      <section role="dialog" aria-modal="true" aria-labelledby="new-ticket-title" className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-3xl sm:p-7">
        <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-wider text-blue-600">We’re here to help</p><h2 id="new-ticket-title" className="mt-1 text-xl font-bold text-slate-900">Create a support ticket</h2><p className="mt-1 text-xs text-slate-500">Tell us what’s happening and our team will follow up.</p></div><button onClick={() => setTicketFormOpen(false)} aria-label="Close ticket form" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><X size={18} /></button></div>
        <form onSubmit={(event) => void createTicket(event)} className="mt-5 space-y-4">
          <label className="block text-xs font-semibold text-slate-700">Subject<input name="subject" required maxLength={240} className="form-input mt-1.5 text-sm" placeholder="Briefly describe what you need" /></label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-xs font-semibold text-slate-700">Request type<select name="issue_category" required className="form-input mt-1.5 text-sm">{issueCategories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
            <div className="flex items-end"><p className="pb-3 text-[11px] leading-4 text-slate-500">Our support team will review your request and set its priority.</p></div>
          </div>
          <label className="block text-xs font-semibold text-slate-700">Related product<select name="product_id" key={prefillProductId ?? 'none'} defaultValue={prefillProductId ?? ''} className="form-input mt-1.5 text-sm"><option value="">No specific product</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
          <label className="block text-xs font-semibold text-slate-700">Details<textarea name="description" required maxLength={20000} rows={4} className="form-input mt-1.5 resize-y text-sm" placeholder="Share any details that will help us resolve this." /></label>
          <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-slate-300 px-4 py-3 text-xs text-slate-600 hover:border-blue-400"><Paperclip size={16} className="shrink-0 text-blue-600" /><span className="flex-1">Attach a file <span className="block pt-0.5 text-[10px] text-slate-400">PDF, image, document, or spreadsheet</span></span><input name="file" type="file" accept={acceptedFiles} className="max-w-36 text-[10px]" /></label>
          <button disabled={submitting} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-wait disabled:opacity-60">{submitting ? 'Submitting ticket…' : 'Submit ticket'}<ArrowRight size={16} /></button>
        </form>
      </section>
    </div>}

    {selectedTicket && <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/50" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedTicket(null) }}>
      <section role="dialog" aria-modal="true" aria-labelledby="ticket-details-title" className="flex h-full w-full max-w-2xl flex-col overflow-hidden bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-5 sm:px-7">
          <div className="min-w-0"><p className="text-xs font-semibold text-blue-700">{selectedTicket.ticket_number} <span className="mx-1 text-slate-300">·</span>{selectedTicket.department}</p><h2 id="ticket-details-title" className="mt-1 truncate text-xl font-bold text-slate-900">{selectedTicket.subject}</h2><div className="mt-2 flex flex-wrap gap-2"><span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${statusStyle(selectedTicket.status)}`}>{formatLabel(selectedTicket.status)}</span><span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${priorityStyle(selectedTicket.priority)}`}>{formatLabel(selectedTicket.priority)} priority</span></div></div>
          <button onClick={() => setSelectedTicket(null)} aria-label="Close ticket details" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><X size={19} /></button>
        </header>
        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5 sm:px-7">
          <section><h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Request details</h3><p className="mt-2 whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-sm leading-6 text-slate-700">{selectedTicket.description}</p><p className="mt-2 text-[10px] text-slate-400">Submitted {new Date(selectedTicket.created_at).toLocaleString()}{selectedTicket.product ? ` · ${selectedTicket.product.name}` : ''}</p></section>
          {selectedTicket.meetings.length > 0 && <section><h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">Ticket meetings</h3><div className="space-y-2">{selectedTicket.meetings.map((meeting) => <a key={meeting.id} href={meeting.jitsi_url} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-xl border border-blue-100 bg-blue-50 p-3 text-sm hover:bg-blue-100"><CalendarDays size={17} className="text-blue-700" /><span className="min-w-0 flex-1"><span className="block font-semibold text-blue-900">Join video meeting</span><span className="text-xs text-blue-700">{new Date(meeting.starts_at).toLocaleString()} · {meeting.duration_minutes} min</span></span><ExternalLink size={15} className="text-blue-700" /></a>)}</div></section>}
          <section><div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Attachments</h3><form onSubmit={(event) => void uploadAttachment(event)} className="flex items-center gap-2"><label className="sr-only" htmlFor="ticket-upload">Choose an attachment</label><input id="ticket-upload" name="file" type="file" required accept={acceptedFiles} className="max-w-40 text-[10px]" /><button aria-label="Upload attachment" className="grid h-8 w-8 place-items-center rounded-lg bg-blue-600 text-white hover:bg-blue-700"><Upload size={15} /></button></form></div>
            {selectedTicket.documents.length ? <div className="space-y-1">{selectedTicket.documents.map((document) => <button key={document.id} onClick={() => void downloadAttachment(document)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-blue-700 hover:bg-blue-50"><FileText size={15} /><span className="flex-1 truncate">{document.name}</span><ArrowDownToLine size={14} /></button>)}</div> : <p className="text-xs text-slate-400">No attachments yet.</p>}
          </section>
          <section><h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">Conversation</h3><div className="space-y-3">{selectedTicket.comments?.length ? selectedTicket.comments.filter((comment) => !comment.is_internal).map((comment) => <article key={comment.id} className={`max-w-[92%] rounded-xl border p-3 ${comment.author?.id === profile.id ? 'ml-auto border-indigo-200 bg-indigo-50/70 dark:border-indigo-900 dark:bg-indigo-950/30' : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900/55'}`}><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold text-slate-800">{comment.author?.id === profile.id ? 'You' : comment.author?.name || 'Deleted account'}</p><time className="text-[10px] text-slate-400">{new Date(comment.created_at).toLocaleString()}</time></div><p className="mt-2 whitespace-pre-wrap text-sm leading-5 text-slate-700">{comment.body}</p></article>) : <p className="rounded-xl bg-slate-50 p-4 text-center text-xs text-slate-500">No messages yet. Send a message to start the conversation.</p>}</div></section>
        </div>
        <form onSubmit={(event) => void addComment(event)} className="flex gap-2 border-t border-slate-100 bg-white p-4 sm:px-7"><label className="sr-only" htmlFor="ticket-comment">Write a message</label><input id="ticket-comment" name="body" maxLength={10000} required placeholder="Write a message to your support team…" className="form-input flex-1 py-2.5 text-sm" /><button aria-label="Send message" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-blue-600 text-white hover:bg-blue-700"><Send size={17} /></button></form>
      </section>
    </div>}
  </div>
}

function OverviewCard({ icon: Icon, label, value, detail, tone }: {
  icon: typeof TicketIcon
  label: string
  value: number | string
  detail: string
  tone: 'blue' | 'violet' | 'emerald' | 'amber'
}) {
  const tones = {
    blue: 'bg-blue-50 text-blue-700',
    violet: 'bg-violet-50 text-violet-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
  }
  return <article className={`crm-metric ${card} p-5`}>
    <div className="flex items-start justify-between"><div><p className="text-xs font-medium text-slate-500">{label}</p><p className="mt-2 text-3xl font-bold tracking-tight text-slate-900">{value}</p></div><span className={`crm-glow-icon grid h-10 w-10 place-items-center rounded-xl ${tones[tone]}`}><Icon size={19} /></span></div>
    <p className="mt-3 truncate text-[10px] text-slate-400">{detail}</p>
  </article>
}

function LoadingState({ label }: { label: string }) {
  return <div className="flex items-center justify-center gap-2 px-5 py-10 text-xs text-slate-400"><span className="h-4 w-4 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600" />{label}</div>
}

function EmptyState({ icon: Icon, title, detail }: { icon: typeof Package; title: string; detail: string }) {
  return <div className="px-5 py-10 text-center"><span className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-slate-100 text-slate-400"><Icon size={20} /></span><p className="mt-3 text-sm font-semibold text-slate-700">{title}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div>
}

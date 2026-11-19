import { FormEvent, useCallback, useEffect, useState } from 'react'
import { CalendarDays, ExternalLink } from 'lucide-react'
import api from '../../lib/api'
import { EmptyState, Skeleton } from '../../components/ui/Feedback'

type Ticket = { id: number; ticket_number: string; subject: string; status: string }
type Meeting = { id: number; ticket_id: number | null; ticket_number: string | null; lead_id: number | null; lead_contact_name: string | null; starts_at: string; duration_minutes: number; jitsi_url: string; created_by: { name: string } | null }

export default function MeetingsPage() {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [role, setRole] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [{ data: rows }, { data: page }, { data: me }] = await Promise.all([
        api.get<Meeting[]>('/meetings'),
        api.get<{ results: Ticket[] }>('/tickets?per_page=100'),
        api.get<{ role: string }>('/auth/me'),
      ])
      setMeetings(rows)
      setTickets(page.results)
      setRole(me.role)
    } catch { setError('Meetings could not be loaded.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  async function schedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setMessage('')
    const form = event.currentTarget
    const data = new FormData(form)
    try {
      const starts = new Date(String(data.get('starts_at')))
      if (!Number.isFinite(starts.getTime())) {
        setError('Choose a valid meeting date and time.')
        return
      }
      const { data: result } = await api.post<{ created: boolean }>('/meetings', {
        ticket_id: Number(data.get('ticket_id')),
        starts_at: starts.toISOString(),
        duration_minutes: Number(data.get('duration_minutes')),
      })
      setMessage(result.created
        ? 'Meeting scheduled. The Jitsi link and notification have been sent.'
        : 'This meeting is already scheduled. No duplicate notification was sent.')
      form.reset()
      await load()
    } catch { setError('The meeting could not be scheduled. Check the ticket and choose a future time.') }
  }

  const staff = role !== '' && role !== 'CUSTOMER'
  return <div className="space-y-5">
    <div><p className="text-xs font-semibold uppercase tracking-wide text-blue-600">Customer conversations</p><h1 className="mt-2 text-3xl font-bold">Meetings</h1><p className="mt-2 text-sm text-slate-500">Schedule lead or ticket-linked calls and join through a free Jitsi room.</p></div>
    {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
    {message && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">{message}</p>}
    {staff && <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-4 font-semibold">Schedule a meeting</h2>
      <form onSubmit={schedule} className="grid gap-3 sm:grid-cols-3">
        <select name="ticket_id" required className="form-input sm:col-span-3"><option value="">Select a ticket</option>{tickets.map((ticket) => <option key={ticket.id} value={ticket.id}>{ticket.ticket_number} — {ticket.subject}</option>)}</select>
        <label className="text-sm">Date and time<input name="starts_at" type="datetime-local" required className="form-input mt-1" /></label>
        <label className="text-sm">Duration (minutes)<input name="duration_minutes" type="number" min="5" max="480" defaultValue="30" required className="form-input mt-1" /></label>
        <button className="mt-5 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white">Schedule meeting</button>
      </form>
    </section>}
    <section className="space-y-3">
      {loading ? Array.from({ length: 3 }, (_, index) => <article key={index} className="panel-card flex items-center gap-4 p-5"><Skeleton className="h-10 w-10 rounded-lg" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-56" /></div><Skeleton className="h-9 w-24 rounded-lg" /></article>) : !meetings.length ? <article className="panel-card"><EmptyState icon={CalendarDays} title="No meetings scheduled" description="Schedule a lead or ticket-linked call to see it here." /></article> : meetings.map((meeting) => <article key={meeting.id} className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-start gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-blue-50 text-blue-700"><CalendarDays size={19} /></span><div><p className="font-semibold">{meeting.ticket_number || meeting.lead_contact_name || 'Customer meeting'}</p><p className="mt-1 text-sm text-slate-500">{new Date(meeting.starts_at).toLocaleString()} · {meeting.duration_minutes} minutes</p><p className="mt-1 text-xs text-slate-400">Scheduled by {meeting.created_by?.name || 'Deleted account'}</p></div></div>
        <a href={meeting.jitsi_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white">Join Jitsi <ExternalLink size={15} /></a>
      </article>)}
    </section>
  </div>
}

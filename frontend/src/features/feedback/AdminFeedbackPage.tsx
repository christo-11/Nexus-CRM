import { useCallback, useEffect, useState } from 'react'
import { Navigate, useOutletContext } from 'react-router-dom'
import { Star } from 'lucide-react'
import api from '../../lib/api'

type Profile = { role: string }
type Review = {
  id: number
  title: string | null
  comment: string
  rating: number
  display_name: string
  status: 'pending' | 'approved' | 'rejected'
  created_at: string
}
type ReviewPage = { results: Review[]; page: number; per_page: number; total: number }

export default function AdminFeedbackPage() {
  const profile = useOutletContext<Profile | null>()
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<ReviewPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const loadReviews = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const { data: response } = await api.get<ReviewPage>(`/admin/feedback?status=${status}&page=${page}&per_page=10`)
      setData(response)
    } catch {
      setError('The moderation queue could not be loaded. Confirm your admin access and try again.')
    } finally {
      setLoading(false)
    }
  }, [page, status])

  useEffect(() => { void loadReviews() }, [loadReviews])

  async function moderate(review: Review, nextStatus: 'approved' | 'rejected') {
    setBusyId(review.id)
    setError('')
    setMessage('')
    try {
      await api.patch(`/admin/feedback/${review.id}`, { status: nextStatus })
      setMessage(`Review ${nextStatus}.`)
      await loadReviews()
    } catch {
      setError('The review could not be updated. It may have changed; refresh the queue and try again.')
    } finally {
      setBusyId(null)
    }
  }

  if (!profile) return <p role="status" className="py-10 text-center text-sm text-slate-500">Loading administrator access…</p>
  if (profile.role !== 'MAIN_ADMIN') return <Navigate to="/" replace />

  return <div className="mx-auto max-w-5xl space-y-6">
    <header><p className="text-xs font-bold uppercase tracking-[.16em] text-emerald-700">Administration</p><h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">Feedback moderation</h1><p className="mt-2 text-sm text-slate-600">Approve or reject customer reviews. Submitted review text is never editable here.</p></header>
    {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>}
    {message && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{message}</div>}
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-lg font-semibold text-slate-900">Review queue</h2><p className="text-sm text-slate-500">{data?.total ?? 0} {status} reviews</p></div>
        <label className="flex items-center gap-2 text-sm text-slate-600">Status
          <select value={status} onChange={(event) => { setStatus(event.target.value as typeof status); setPage(1) }} className="form-input w-auto py-2">
            <option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option>
          </select>
        </label>
      </div>
      {loading ? <p role="status" className="py-10 text-center text-sm text-slate-500">Loading moderation queue…</p>
        : data?.results.length ? <div className="mt-5 space-y-4">
          {data.results.map((review) => <article key={review.id} className="rounded-xl border border-slate-200 p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><div className="flex flex-wrap items-center gap-2"><span aria-label={`${review.rating} out of 5 stars`} className="inline-flex gap-0.5 text-amber-500">{Array.from({ length: 5 }, (_, index) => <Star key={index} size={14} fill={index < review.rating ? 'currentColor' : 'none'} />)}</span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold capitalize text-slate-600">{review.status}</span></div>
                {review.title && <h3 className="mt-3 font-semibold text-slate-900">{review.title}</h3>}</div>
              <time className="text-xs text-slate-500">{new Date(review.created_at).toLocaleString()}</time>
            </div>
            <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">{review.comment}</p>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
              <p className="text-xs text-slate-500">Author: {review.display_name}</p>
              <div className="flex gap-2">
                {review.status !== 'approved' && <button disabled={busyId === review.id} onClick={() => void moderate(review, 'approved')} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">Approve</button>}
                {review.status !== 'rejected' && <button disabled={busyId === review.id} onClick={() => void moderate(review, 'rejected')} className="rounded-lg border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50">Reject</button>}
              </div>
            </div>
          </article>)}
          <nav aria-label="Moderation pages" className="flex items-center justify-between py-2">
            <button disabled={page <= 1} onClick={() => setPage((value) => value - 1)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold disabled:opacity-40">Previous</button>
            <span className="text-xs text-slate-500">Page {page} of {Math.max(1, Math.ceil(data.total / data.per_page))}</span>
            <button disabled={page * data.per_page >= data.total} onClick={() => setPage((value) => value + 1)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold disabled:opacity-40">Next</button>
          </nav>
        </div>
          : <p className="mt-5 rounded-xl bg-slate-50 p-8 text-center text-sm text-slate-500">No {status} reviews to display.</p>}
    </section>
  </div>
}

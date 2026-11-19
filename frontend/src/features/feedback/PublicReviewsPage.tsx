import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Star } from 'lucide-react'
import Brand from '../../components/ui/Brand'
import api from '../../lib/api'

type Review = {
  id: number
  title: string | null
  comment: string
  rating: number
  display_name: string
  created_at: string
}
type ReviewPage = {
  average_rating: number | null
  total_reviews: number
  results: Review[]
  page: number
  per_page: number
  total: number
}

function ReviewStars({ rating }: { rating: number }) {
  return <span aria-label={`${rating} out of 5 stars`} className="inline-flex gap-0.5 text-amber-500">
    {Array.from({ length: 5 }, (_, index) => <Star key={index} size={16} fill={index < rating ? 'currentColor' : 'none'} />)}
  </span>
}

export default function PublicReviewsPage() {
  const [data, setData] = useState<ReviewPage | null>(null)
  const [rating, setRating] = useState('')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    async function loadReviews() {
      setLoading(true)
      setError('')
      try {
        const params = new URLSearchParams({ page: String(page), per_page: '10' })
        if (rating) params.set('rating', rating)
        const response = await api.get<ReviewPage>(`/feedback/public?${params.toString()}`, { signal: controller.signal })
        setData(response.data)
      } catch {
        if (!controller.signal.aborted) setError('Reviews could not be loaded. Check your connection and try again.')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void loadReviews()
    return () => controller.abort()
  }, [page, rating, reload])

  function changeRating(value: string) {
    setPage(1)
    setRating(value)
  }

  return <main className="min-h-screen bg-[#f6f4ec] px-4 py-8 sm:px-8">
    <div className="mx-auto max-w-5xl">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Link to="/" aria-label="NEXUS CRM home"><Brand markClassName="h-10 w-10" /></Link>
        <div className="flex items-center gap-3">
          <Link to="/login" className="rounded-lg px-3 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50">Sign in</Link>
          <Link to="/feedback" className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800">Share feedback</Link>
        </div>
      </header>

      <section className="mt-10 rounded-3xl bg-[#123d32] px-6 py-8 text-white sm:px-10 sm:py-11">
        <p className="text-xs font-semibold uppercase tracking-[.18em] text-emerald-200">Customer voices</p>
        <div className="mt-4 flex flex-wrap items-end justify-between gap-6">
          <div><h1 className="font-display text-3xl font-bold sm:text-4xl">Reviews & feedback</h1><p className="mt-3 max-w-xl text-sm leading-6 text-emerald-100">Feedback shared by our customers, published after moderation.</p></div>
          <div className="min-w-36 rounded-2xl border border-white/15 bg-white/[.07] p-4">
            <p className="text-xs text-emerald-100">Average rating</p>
            <p className="mt-1 text-3xl font-bold">{data?.average_rating?.toFixed(2) ?? '—'}<span className="ml-1 text-base text-emerald-100">/ 5</span></p>
            <p className="mt-1 text-xs text-emerald-100">{data?.total_reviews ?? '—'} approved reviews</p>
          </div>
        </div>
      </section>

      <section className="mt-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-lg font-bold text-slate-900">Customer reviews</h2><p className="text-sm text-slate-500">Only approved reviews are shown.</p></div>
          <label className="flex items-center gap-2 text-sm text-slate-600">Filter by rating
            <select value={rating} onChange={(event) => changeRating(event.target.value)} className="form-input w-auto py-2">
              <option value="">All ratings</option>
              {[5, 4, 3, 2, 1].map((value) => <option key={value} value={value}>{value} stars</option>)}
            </select>
          </label>
        </div>
        {loading ? <div role="status" className="rounded-2xl bg-white p-8 text-center text-sm text-slate-500">Loading approved reviews…</div>
          : error ? <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-800">{error}<button onClick={() => setReload((value) => value + 1)} className="ml-2 font-semibold underline">Retry</button></div>
            : data?.results.length ? <div className="space-y-4">
              {data.results.map((review) => <article key={review.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><ReviewStars rating={review.rating} />{review.title && <h3 className="mt-2 text-base font-semibold text-slate-900">{review.title}</h3>}</div>
                  <time className="text-xs text-slate-500">{new Date(review.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</time>
                </div>
                <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">{review.comment}</p>
                <p className="mt-4 text-xs font-semibold text-slate-500">{review.display_name}</p>
              </article>)}
              <nav aria-label="Review pages" className="flex items-center justify-between py-3">
                <button disabled={page <= 1} onClick={() => setPage((value) => value - 1)} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold disabled:opacity-40">Previous</button>
                <span className="text-xs text-slate-500">Page {page} of {Math.max(1, Math.ceil(data.total / data.per_page))}</span>
                <button disabled={page * data.per_page >= data.total} onClick={() => setPage((value) => value + 1)} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold disabled:opacity-40">Next</button>
              </nav>
            </div>
            : <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center"><h3 className="font-semibold text-slate-800">No approved reviews yet</h3><p className="mt-2 text-sm text-slate-500">Check back later for customer feedback.</p></div>}
      </section>
    </div>
  </main>
}

import { FormEvent, useCallback, useEffect, useState } from 'react'
import { LayoutGrid, List, Package, Pencil, Plus, Search } from 'lucide-react'
import api from '../../lib/api'
import { EmptyState, Skeleton } from '../../components/ui/Feedback'

type Product = { id: number; name: string; category: string; description: string; price: string; status: string }
const initial = { id: 0, name: '', category: '', description: '', price: '0', status: 'ACTIVE' }

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([])
  const [profile, setProfile] = useState<{ role: string } | null>(null)
  const [draft, setDraft] = useState(initial)
  const [search, setSearch] = useState('')
  const [view, setView] = useState<'grid' | 'list'>(() => localStorage.getItem('smart-crm.products-view') === 'list' ? 'list' : 'grid')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const isAdmin = profile?.role === 'MAIN_ADMIN'

  useEffect(() => {
    localStorage.setItem('smart-crm.products-view', view)
  }, [view])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [{ data: list }, { data: me }] = await Promise.all([
        api.get<Product[]>(`/products?search=${encodeURIComponent(search)}${isAdmin ? '&status=all' : ''}`),
        api.get<{ role: string }>('/auth/me'),
      ])
      setProducts(list)
      setProfile(me)
    } catch { setError('Products could not be loaded.') }
    finally { setLoading(false) }
  }, [isAdmin, search])
  useEffect(() => { void load() }, [load])

  async function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setMessage('')
    try {
      if (draft.id) await api.patch(`/products/${draft.id}`, draft)
      else await api.post('/products', draft)
      setMessage(draft.id ? 'Product updated.' : 'Product created.')
      setDraft(initial)
      await load()
    } catch { setError('Product could not be saved. Check that price is a non-negative number.') }
  }

  async function archive(product: Product) {
    try {
      await api.patch(`/products/${product.id}`, { status: product.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' })
      await load()
    } catch { setError('Product status could not be changed.') }
  }

  return <div className="space-y-5">
    <div><p className="text-xs font-semibold uppercase tracking-wide text-blue-600">Catalog</p><h1 className="mt-2 text-3xl font-bold">Products</h1><p className="mt-2 text-sm text-slate-500">Explore products and attach them to customer enquiries.</p></div>
    {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
    {message && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">{message}</p>}
    {isAdmin && <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-4 font-semibold">{draft.id ? 'Edit product' : 'Add product'}</h2>
      <form onSubmit={saveProduct} className="grid gap-3 sm:grid-cols-2">
        <input required maxLength={180} placeholder="Product name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="form-input" />
        <input required maxLength={100} placeholder="Category" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} className="form-input" />
        <input required type="number" min="0" step="0.01" placeholder="Price" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} className="form-input" />
        <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })} className="form-input"><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select>
        <textarea placeholder="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className="form-input sm:col-span-2" rows={3} />
        <div className="flex gap-2 sm:col-span-2"><button className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white"><Plus size={16} />{draft.id ? 'Save changes' : 'Add product'}</button>{draft.id > 0 && <button type="button" onClick={() => setDraft(initial)} className="rounded-xl border px-4 text-sm">Cancel</button>}</div>
      </form>
    </section>}
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <label className="relative min-w-52 flex-1"><Search size={16} className="absolute left-3 top-3 text-slate-400" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search products" className="form-input pl-9" /></label>
        <div className="crm-filter-tabs" role="group" aria-label="Product view">
          <button type="button" aria-pressed={view === 'grid'} aria-label="Grid view" title="Grid view" onClick={() => setView('grid')}><LayoutGrid size={16} /></button>
          <button type="button" aria-pressed={view === 'list'} aria-label="List view" title="List view" onClick={() => setView('list')}><List size={16} /></button>
        </div>
      </div>
      {loading ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, index) => <div key={index} className="space-y-3 rounded-xl border border-slate-200 p-4"><Skeleton className="h-3 w-20" /><Skeleton className="h-5 w-2/3" /><Skeleton className="h-12 w-full" /><Skeleton className="h-4 w-24" /></div>)}</div> : !products.length ? <EmptyState icon={Package} title="No products found" description={search ? 'Try a different search term.' : 'Products available to customers will appear here.'} /> : <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {view === 'grid' ? products.map((product) => <article key={product.id} className="crm-surface rounded-xl border border-slate-200 bg-white/70 p-4">
          <div className="flex items-start justify-between gap-2"><div><span className="text-xs font-semibold uppercase text-emerald-800">{product.category}</span><h2 className="mt-1 font-semibold">{product.name}</h2></div>{isAdmin && <button aria-label={`Edit ${product.name}`} onClick={() => setDraft({ ...product, price: String(product.price) })} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><Pencil size={15} /></button>}</div>
          <p className="mt-2 min-h-10 text-sm text-slate-500">{product.description || 'No description provided.'}</p>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2"><span className="font-bold">${Number(product.price).toFixed(2)}</span><span className={`crm-badge rounded-full px-2 py-1 text-[10px] ${product.status === 'ACTIVE' ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{product.status}</span>{isAdmin && <button onClick={() => void archive(product)} className="text-xs font-semibold text-emerald-800">{product.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}</button>}</div>
        </article>) : <div className="overflow-x-auto sm:col-span-2 xl:col-span-3"><table className="w-full min-w-[640px] text-left text-sm">
          <thead className="text-xs uppercase text-slate-500"><tr><th className="py-3">Product</th><th className="py-3">Category</th><th className="py-3">Price</th><th className="py-3">Status</th>{isAdmin && <th className="py-3">Actions</th>}</tr></thead>
          <tbody>{products.map((product) => <tr key={product.id}>
            <td className="py-3"><span className="font-semibold">{product.name}</span><span className="mt-1 block max-w-md truncate text-xs text-slate-500">{product.description || 'No description provided.'}</span></td>
            <td className="py-3">{product.category}</td>
            <td className="py-3 font-semibold">${Number(product.price).toFixed(2)}</td>
            <td className="py-3"><span className={`crm-badge rounded-full px-2 py-1 text-[10px] ${product.status === 'ACTIVE' ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{product.status}</span></td>
            {isAdmin && <td className="py-3"><div className="flex items-center gap-2"><button aria-label={`Edit ${product.name}`} onClick={() => setDraft({ ...product, price: String(product.price) })} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><Pencil size={15} /></button><button onClick={() => void archive(product)} className="text-xs font-semibold text-emerald-800">{product.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}</button></div></td>}
          </tr>)}</tbody>
        </table></div>}
      </div>}
    </section>
  </div>
}

import { FormEvent, useEffect, useState } from 'react'
import axios from 'axios'
import { Download, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import api from '../../lib/api'
import { EmptyState, Skeleton } from '../../components/ui/Feedback'

type User = { id: number; name: string; email: string; role: string; department: string | null; is_active: boolean }
type Department = { id: number; name: string; slug: string; member_count: number }
type Role = { id: number; name: string }
type Activity = { id: number; summary: string; action: string; created_at: string; actor: User | null }

export default function AdminPage() {
  const [users, setUsers] = useState<User[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [activities, setActivities] = useState<Activity[]>([])
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  async function load() {
    setLoading(true)
    try {
      const { data: me } = await api.get<User>('/auth/me')
      setIsAdmin(me.role === 'MAIN_ADMIN')
      if (me.role !== 'MAIN_ADMIN') return
      const [userResult, departmentResult, roleResult, activityResult] = await Promise.all([
        api.get<User[]>('/admin/users'),
        api.get<Department[]>('/admin/departments'),
        api.get<Role[]>('/admin/roles'),
        api.get<Activity[]>('/admin/activities'),
      ])
      setUsers(userResult.data)
      setDepartments(departmentResult.data)
      setRoles(roleResult.data.filter((role) => role.name !== 'MAIN_ADMIN' && role.name !== 'CUSTOMER'))
      setActivities(activityResult.data)
    } catch { setError('Admin workspace could not be loaded. Verify that this account has admin access.') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    setError('')
    setMessage('')
    try {
      await api.post('/admin/users', {
        name: data.get('name'),
        email: data.get('email'),
        password: data.get('password'),
        role: data.get('role'),
        department_id: Number(data.get('department_id')),
      })
      setMessage('Team account created.')
      form.reset()
      await load()
    } catch { setError('Could not create the account. Check unique email, role, department, and password length (12+).') }
  }

  async function createDepartment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    try {
      await api.post('/admin/departments', { name: data.get('name'), slug: data.get('slug') })
      setMessage('Department created.')
      form.reset()
      await load()
    } catch { setError('Department could not be created. Names and slugs must be unique.') }
  }

  async function toggleUser(user: User) {
    try {
      await api.patch(`/admin/users/${user.id}`, { is_active: !user.is_active })
      setMessage(`${user.name} was ${user.is_active ? 'deactivated' : 'activated'}.`)
      await load()
    } catch { setError('This account could not be deactivated.') }
  }

  async function deleteUser(user: User) {
    if (!window.confirm(`Delete ${user.name}'s deactivated account? Linked history will remain anonymized.`)) return
    setError('')
    setMessage('')
    try {
      await api.delete(`/admin/users/${user.id}`)
      setMessage(`${user.name}'s account was deleted.`)
      setUsers((current) => current.filter((item) => item.id !== user.id))
    } catch (deleteError: unknown) {
      const serverMessage = axios.isAxiosError<{ error?: string }>(deleteError)
        ? deleteError.response?.data?.error
        : undefined
      setError(serverMessage || 'This account could not be deleted.')
    }
  }

  async function downloadReport(format: 'csv' | 'xlsx' | 'pdf') {
    try {
      const { data } = await api.get(`/admin/reports/tickets.${format}`, { responseType: 'blob' })
      const url = URL.createObjectURL(data)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `smart-crm-tickets.${format}`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch { setError(`The ${format.toUpperCase()} report could not be exported.`) }
  }

  if (isAdmin === null) return <div className="panel-card space-y-4 p-6" aria-label="Loading administrator access"><Skeleton className="h-5 w-48" /><Skeleton className="h-4 w-72" /></div>
  if (!isAdmin) return <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">This page is available to the main administrator only.</div>

  return <div className="space-y-5">
    <div><p className="text-xs font-semibold uppercase tracking-wide text-blue-600">Workspace control</p><h1 className="mt-2 text-3xl font-bold">Admin and team</h1><p className="mt-2 text-sm text-slate-500">Manage access and departments, review activity, and export ticket reports.</p></div>
    {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
    {message && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">{message}</p>}
    <section className="grid gap-4 xl:grid-cols-2">
      <form onSubmit={createUser} className="panel-card space-y-3 p-5">
        <h2 className="flex items-center gap-2 font-semibold"><Plus size={17} />Create team member</h2>
        <input name="name" required maxLength={160} placeholder="Full name" className="form-input" />
        <input name="email" type="email" required placeholder="Email address" className="form-input" />
        <input name="password" type="password" required minLength={12} maxLength={128} placeholder="Temporary password (12+ characters)" className="form-input" />
        <select name="role" required className="form-input"><option value="">Select role</option>{roles.map((role) => <option key={role.id} value={role.name}>{role.name.replaceAll('_', ' ')}</option>)}</select>
        <select name="department_id" required className="form-input"><option value="">Select department</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select>
        <button className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white">Create account</button>
      </form>
      <form onSubmit={createDepartment} className="panel-card space-y-3 p-5">
        <h2 className="flex items-center gap-2 font-semibold"><Plus size={17} />Create department</h2>
        <input name="name" required maxLength={80} placeholder="Department name" className="form-input" />
        <input name="slug" required maxLength={80} pattern="[a-z0-9-]+" placeholder="slug-like-this" className="form-input" />
        <button className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold">Add department</button>
        <div className="border-t border-slate-100 pt-3">{departments.map((department) => <p key={department.id} className="flex justify-between py-1 text-sm"><span>{department.name}</span><span className="text-slate-500">{department.member_count} members</span></p>)}</div>
      </form>
    </section>
    <section className="panel-card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 font-semibold"><ShieldCheck size={17} />User access</h2>
        <div className="flex gap-2">{(['csv', 'xlsx', 'pdf'] as const).map((format) => <button key={format} onClick={() => void downloadReport(format)} className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-2 text-xs font-semibold uppercase"><Download size={14} />{format}</button>)}</div>
      </div>
      <div className="overflow-x-auto"><table className="w-full min-w-[600px] text-left text-sm"><thead className="text-xs uppercase text-slate-400"><tr><th className="pb-3">Name</th><th className="pb-3">Email</th><th className="pb-3">Role</th><th className="pb-3">Department</th><th className="pb-3">Status</th><th className="pb-3">Action</th></tr></thead><tbody>{loading ? Array.from({ length: 4 }, (_, index) => <tr key={index}>{Array.from({ length: 6 }, (_, cell) => <td key={cell} className="py-3"><Skeleton className="h-3 w-20" /></td>)}</tr>) : users.length ? users.map((user) => <tr key={user.id} className="border-t border-slate-100"><td className="py-3 font-semibold">{user.name}</td><td className="py-3">{user.email}</td><td className="py-3">{user.role.replaceAll('_', ' ')}</td><td className="py-3">{user.department || '—'}</td><td className="py-3"><span className={`crm-badge rounded-full px-2 py-1 text-[10px] ${user.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{user.is_active ? 'Active' : 'Inactive'}</span></td><td className="py-3">{user.role !== 'MAIN_ADMIN' && <div className="flex items-center gap-3"><button onClick={() => void toggleUser(user)} className="text-xs font-semibold text-blue-700">{user.is_active ? 'Deactivate' : 'Activate'}</button>{!user.is_active && <button onClick={() => void deleteUser(user)} aria-label={`Delete ${user.name}`} title="Delete deactivated account" className="rounded p-1 text-rose-600 hover:bg-rose-50"><Trash2 size={16} /></button>}</div>}</td></tr>) : <tr><td colSpan={6}><EmptyState icon={ShieldCheck} title="No team accounts yet" description="Create a team member to manage access here." /></td></tr>}</tbody></table></div>
    </section>
    <section className="panel-card p-5"><h2 className="mb-3 font-semibold">Recent activity</h2>
      {activities.length ? <div className="divide-y divide-slate-100">{activities.map((item) => <p key={item.id} className="py-3 text-sm"><span className="font-medium">{item.actor?.name || 'System'}</span> · {item.summary}<time className="mt-1 block text-xs text-slate-400">{new Date(item.created_at).toLocaleString()}</time></p>)}</div> : <p className="py-5 text-sm text-slate-500">No activity recorded.</p>}
    </section>
  </div>
}

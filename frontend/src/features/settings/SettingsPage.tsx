import { useEffect, useState } from 'react'
import api from '../../lib/api'

type Profile = {
  name: string
  email: string
  role: string
  department: string | null
}

export default function SettingsPage() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get<Profile>('/auth/me')
      .then(({ data }) => setProfile(data))
      .catch(() => setError('Your profile could not be loaded.'))
      .finally(() => setLoading(false))
  }, [])

  return <div className="mx-auto max-w-3xl space-y-6">
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-blue-600">Account</p>
      <h1 className="mt-2 text-[28px] font-bold tracking-tight text-slate-900">Profile</h1>
      <p className="mt-1 text-sm text-slate-500">View your account details.</p>
    </div>
    {error && <div role="alert" className="rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}

    <section className="panel-card p-5 sm:p-6">
      <h2 className="text-base font-bold text-slate-900">Profile</h2>
      {loading ? <p className="mt-3 text-sm text-slate-500">Loading profile…</p> : profile && <div className="mt-4 space-y-2 text-sm text-slate-600">
        <p><span className="font-semibold text-slate-800">Name:</span> {profile.name}</p>
        <p><span className="font-semibold text-slate-800">Account email:</span> {profile.email}</p>
        <p><span className="font-semibold text-slate-800">Role:</span> {profile.role.replaceAll('_', ' ')}{profile.department ? ` · ${profile.department}` : ''}</p>
      </div>}
    </section>
  </div>
}

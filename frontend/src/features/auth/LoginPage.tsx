import { ArrowRight, Eye, EyeOff, LockKeyhole, Mail } from 'lucide-react'
import axios from 'axios'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, Navigate } from 'react-router-dom'
import { useAuthStore } from '../../stores/auth'
import Brand from '../../components/ui/Brand'

type LoginFields = { email: string; password: string }

export default function LoginPage() {
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)
  const loading = useAuthStore((state) => state.isLoading)
  const login = useAuthStore((state) => state.login)
  const { register, handleSubmit, formState: { errors } } = useForm<LoginFields>()
  if (isAuthenticated) return <Navigate to="/" replace />

  const submit = handleSubmit(async ({ email, password }) => {
    setError('')
    try {
      await login(email, password)
    } catch (loginError: unknown) {
      if (!axios.isAxiosError(loginError)) {
        setError('An unexpected sign-in error occurred. Please try again.')
      } else if (!loginError.response) {
        setError('The CRM server could not be reached. Check that the API is running, then try again.')
      } else if (loginError.response.status === 401) {
        setError('The email or password was not accepted, or this account is inactive. Main Admin credentials are the ones configured for the existing account; changing the backend .env does not reset its password.')
      } else if (loginError.response.status === 429) {
        setError('Too many sign-in attempts. Wait a minute before trying again.')
      } else {
        setError('The CRM could not complete sign-in. Check the API server logs and try again.')
      }
    }
  })

  return (
    <main className="auth-layout grid min-h-screen bg-white lg:grid-cols-[1.02fr_.98fr]">
      <section className="auth-brand-panel relative hidden overflow-hidden bg-[#123d32] p-12 text-white lg:flex lg:flex-col lg:justify-between xl:p-16">
        <div className="auth-hero-ring auth-hero-ring-outer absolute -right-40 -top-24 h-[500px] w-[500px] rounded-full" />
        <div className="auth-hero-ring auth-hero-ring-inner absolute -right-16 top-16 h-[360px] w-[360px] rounded-full" />
        <div className="absolute -bottom-40 -left-32 h-[480px] w-[480px] rounded-full bg-emerald-600/10 blur-[90px]" />
        <div className="relative z-10">
          <Brand markClassName="h-11 w-11" wordmarkClassName="auth-glow-wordmark" />
        </div>
        <div className="relative z-10 max-w-lg">
          <div className="auth-glass-chip auth-hero-badge mb-6 inline-flex items-center gap-2 rounded-full border border-[#d5b875]/25 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-[#e4d5aa]"><span className="h-1.5 w-1.5 rounded-full bg-[#d5b875]" /> Customer relationships, clearly in view</div>
          <h1 className="text-[42px] font-semibold leading-[1.12] tracking-[-0.04em] xl:text-[52px]">A considered view<br />of every <span className="auth-glow-text text-[#bfe6d2]">conversation.</span></h1>
          <p className="mt-5 max-w-md text-[15px] leading-7 text-[#cad8d0]">One calm workspace for customer requests, product support, scheduled meetings, and the people who move them forward.</p>
          <div className="mt-9 flex flex-wrap gap-2 text-xs font-medium text-[#cad8d0]">{['Customer support', 'Sales leads', 'Team operations'].map((item) => <span key={item} className="auth-glass-chip auth-feature-pill rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5">{item}</span>)}</div>
        </div>
        <p className="relative z-10 text-[11px] text-[#9bb2a5]">NEXUS CRM · Private workspace</p>
      </section>

      <section className="auth-form-panel flex min-h-screen items-center justify-center bg-[#f6f4ec] px-5 py-12 sm:px-10">
        <div className="w-full max-w-[420px]">
          <div className="mb-10 lg:hidden"><Brand markClassName="h-10 w-10" wordmarkClassName="auth-glow-wordmark" /></div>
          <div className="mb-8"><p className="text-[11px] font-bold uppercase tracking-[0.15em] text-emerald-700">Welcome back</p><h2 className="mt-2 text-[30px] font-bold tracking-tight text-[#25332d]">Sign in to your workspace</h2><p className="mt-2 text-sm text-[#68766f]">Use your account details to continue.</p></div>
          {error && <div role="alert" className="mb-5 rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
          <form onSubmit={submit} className="space-y-5">
            <label className="block"><span className="mb-2 block text-[13px] font-semibold text-slate-700">Work email</span><span className="relative block"><Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={17} /><input {...register('email', { required: 'Enter your work email', pattern: { value: /^\S+@\S+\.\S+$/, message: 'Enter a valid email address' } })} type="email" autoComplete="email" placeholder="you@company.com" className="form-input pl-11" /></span>{errors.email && <span className="mt-1.5 block text-xs text-rose-600">{errors.email.message}</span>}</label>
            <label className="block"><span className="mb-2 block text-[13px] font-semibold text-slate-700">Password</span><span className="relative block"><LockKeyhole className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={17} /><input {...register('password', { required: 'Enter your password' })} type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Enter your password" className="form-input px-11" /><button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></span>{errors.password && <span className="mt-1.5 block text-xs text-rose-600">{errors.password.message}</span>}</label>
            <div className="flex justify-end"><Link className="text-xs font-semibold text-emerald-800 hover:text-emerald-900" to="/forgot-password">Forgot password?</Link></div>
            <button disabled={loading} className="auth-submit-button flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-700 py-3.5 text-sm font-semibold text-white shadow-lg shadow-emerald-900/15 transition hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-70">{loading ? 'Signing in…' : 'Sign in'}{!loading && <ArrowRight size={17} />}</button>
          </form>
          <p className="mt-5 text-center text-xs text-slate-500">New to NEXUS CRM? <Link to="/signup" className="font-semibold text-emerald-800">Create an account</Link></p>
          <p className="mt-3 text-center text-xs text-slate-500">See what customers are saying? <Link to="/reviews" className="font-semibold text-emerald-800">Read reviews</Link></p>
        </div>
      </section>
    </main>
  )
}

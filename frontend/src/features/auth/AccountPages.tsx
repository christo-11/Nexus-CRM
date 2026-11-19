import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { ArrowLeft, CheckCircle2 } from 'lucide-react'
import api from '../../lib/api'
import Brand from '../../components/ui/Brand'

type SignupForm = { full_name: string; organization_name: string; email: string; password: string; password_confirmation: string }
type ResetForm = { new_password: string; password_confirmation: string }

function AuthFrame({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <main className="auth-frame grid min-h-screen place-items-center bg-transparent px-4 py-10">
      <section className="auth-frame-card crm-surface w-full max-w-[460px] p-6 sm:p-9">
        <Link to="/login" className="mb-8 inline-flex text-slate-800"><Brand /></Link>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
        <p className="mt-2 text-sm leading-5 text-slate-500">{description}</p>
        <div className="mt-6">{children}</div>
      </section>
    </main>
  )
}

export function SignupPage() {
  const [error, setError] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<SignupForm>()
  const onSubmit = handleSubmit(async (values) => {
    setError('')
    try {
      await api.post('/auth/signup/', {
        name: values.full_name,
        email: values.email,
        password: values.password,
      })
      setSubmitted(true)
    } catch {
      setError('Account could not be created. The email may already be registered, or the password may not meet requirements.')
    }
  })
  return <AuthFrame title={submitted ? 'Account created' : 'Create your account'} description={submitted ? 'Your account is ready. You can sign in now.' : 'Register as a customer to browse products and submit enquiries.'}>
    {submitted ? <div className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">Your account has been created successfully. You can sign in with your email and password.<Link className="mt-4 block font-semibold text-blue-700" to="/login">Go to sign in</Link></div> : <>
      {error && <p role="alert" className="mb-4 rounded-lg bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
      <form onSubmit={onSubmit} className="space-y-4">
        {([
          ['full_name', 'Your name', 'text'],
          ['email', 'Work email', 'email'],
          ['password', 'Password', 'password'],
          ['password_confirmation', 'Confirm password', 'password'],
        ] as const).map(([name, label, type]) => <label className="block" key={name}><span className="mb-1.5 block text-xs font-semibold text-slate-700">{label}</span><input {...register(name, { required: `${label} is required`, ...(name === 'password' ? { minLength: { value: 12, message: 'Use at least 12 characters' } } : {}), ...(name === 'password_confirmation' ? { validate: (value) => value === watch('password') || 'Passwords do not match' } : {}) })} type={type} className="form-input" autoComplete={name === 'password_confirmation' ? 'new-password' : type === 'password' ? 'new-password' : name === 'email' ? 'email' : 'name'} />{errors[name] && <span className="mt-1 text-[11px] text-rose-600">{errors[name]?.message}</span>}</label>)}
        <button disabled={isSubmitting} className="w-full rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">{isSubmitting ? 'Creating workspace…' : 'Create account'}</button>
      </form>
      <p className="mt-5 text-center text-xs text-slate-500">Already registered? <Link to="/login" className="font-semibold text-blue-600">Sign in</Link></p>
    </>}
  </AuthFrame>
}

export function VerifyEmailPage() {
  const { token: pathToken = '' } = useParams()
  const [params] = useSearchParams()
  const token = pathToken || params.get('token') || ''
  const [message, setMessage] = useState('Verifying your email…')
  const [success, setSuccess] = useState(false)
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    api.post('/auth/verify-email/', { token })
      .then(() => { setSuccess(true); setMessage('Your email is verified. You can now sign in.') })
      .catch(() => setMessage('This verification link is invalid or expired. Request another link below.'))
  }, [token])
  async function resend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    try {
      await api.post('/auth/verify-email/request/', { email })
      setSent(true)
    } catch {
      setError('The verification request could not be sent. Try again.')
    }
  }
  return <AuthFrame title={success ? 'Email verified' : 'Verify your email'} description={message}><div className={`flex items-center gap-2 rounded-lg p-3 text-sm ${success ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'}`}><CheckCircle2 size={18} />{message}</div>{!success && <form onSubmit={resend} className="mt-5 space-y-3"><label className="block"><span className="mb-1.5 block text-xs font-semibold text-slate-700">Work email</span><input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required className="form-input" /></label>{error && <p role="alert" className="text-xs text-rose-600">{error}</p>}{sent && <p role="status" className="text-xs text-emerald-700">If verification is needed, a new link has been sent.</p>}<button className="text-xs font-semibold text-blue-600">Resend verification email</button></form>}<Link to="/login" className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-blue-600"><ArrowLeft size={16} /> Sign in</Link></AuthFrame>
}

export function ForgotPasswordPage() {
  const [submitted, setSubmitted] = useState(false)
  const [resetUrl, setResetUrl] = useState('')
  const [error, setError] = useState('')
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<{ email: string }>()
  const onSubmit = handleSubmit(async (values) => {
    setError('')
    try {
      const { data } = await api.post<{ development_reset_url?: string }>('/auth/password-reset/', values)
      setResetUrl(data.development_reset_url || '')
      setSubmitted(true)
    } catch {
      setError('The reset request could not be sent. Please try again.')
    }
  })
  return <AuthFrame title="Reset your password" description="Enter your work email and we’ll send a reset link if an account exists.">
    {submitted ? <div role="status" className="rounded-xl bg-blue-50 p-4 text-sm leading-5 text-blue-800">If an account exists for that email, a reset link has been sent.{resetUrl && <a href={resetUrl} className="mt-3 block break-all font-semibold text-blue-700 underline">Open the local development reset link</a>}<Link className="mt-4 block font-semibold text-blue-700" to="/login">Return to sign in</Link></div> : <form onSubmit={onSubmit} className="space-y-4">{error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}<label className="block"><span className="mb-1.5 block text-xs font-semibold text-slate-700">Work email</span><input {...register('email', { required: 'Enter your work email' })} type="email" className="form-input" />{errors.email && <span className="mt-1 text-[11px] text-rose-600">{errors.email.message}</span>}</label><button disabled={isSubmitting} className="w-full rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white disabled:opacity-60">{isSubmitting ? 'Sending…' : 'Send reset link'}</button><Link to="/login" className="block text-center text-xs font-semibold text-blue-600">Back to sign in</Link></form>}
  </AuthFrame>
}

export function ResetPasswordPage() {
  const { token: pathToken = '' } = useParams()
  const [params] = useSearchParams()
  const token = pathToken || params.get('token') || ''
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const navigate = useNavigate()
  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<ResetForm>()
  const onSubmit = handleSubmit(async ({ new_password }) => {
    setError('')
    try {
      await api.post('/auth/password-reset/confirm/', { token, new_password })
      setSuccess(true)
      window.setTimeout(() => navigate('/login', { replace: true }), 1800)
    } catch {
      setError('This reset link is expired or invalid. Request a new password reset link.')
    }
  })
  return <AuthFrame title={success ? 'Password updated' : 'Choose a new password'} description={success ? 'Your password was changed. Redirecting you to sign in…' : 'Use a unique password with at least 12 characters.'}>
    {success ? <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">Password changed successfully.</p> : <form onSubmit={onSubmit} className="space-y-4">{error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}{(['new_password', 'password_confirmation'] as const).map((field) => <label key={field} className="block"><span className="mb-1.5 block text-xs font-semibold capitalize text-slate-700">{field.replace('_', ' ')}</span><input {...register(field, { required: 'This field is required', ...(field === 'new_password' ? { minLength: { value: 12, message: 'Use at least 12 characters' } } : { validate: (value) => value === watch('new_password') || 'Passwords do not match' }) })} type="password" autoComplete="new-password" className="form-input" />{errors[field] && <span className="mt-1 text-[11px] text-rose-600">{errors[field]?.message}</span>}</label>)}<button disabled={isSubmitting} className="w-full rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white disabled:opacity-60">{isSubmitting ? 'Updating…' : 'Update password'}</button></form>}
  </AuthFrame>
}

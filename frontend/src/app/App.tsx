import { lazy, Suspense, useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import AutomationLayout from '../components/layout/AutomationLayout'
import { useAuthStore } from '../stores/auth'

const LoginPage = lazy(() => import('../features/auth/LoginPage'))
const SignupPage = lazy(() => import('../features/auth/AccountPages').then((module) => ({ default: module.SignupPage })))
const VerifyEmailPage = lazy(() => import('../features/auth/AccountPages').then((module) => ({ default: module.VerifyEmailPage })))
const ForgotPasswordPage = lazy(() => import('../features/auth/AccountPages').then((module) => ({ default: module.ForgotPasswordPage })))
const ResetPasswordPage = lazy(() => import('../features/auth/AccountPages').then((module) => ({ default: module.ResetPasswordPage })))
const Dashboard = lazy(() => import('../features/automation/Dashboard'))
const AISupportPage = lazy(() => import('../features/automation/AISupportPage'))
const TicketsPage = lazy(() => import('../features/automation/TicketsPage'))
const ProductsPage = lazy(() => import('../features/automation/ProductsPage'))
const MeetingsPage = lazy(() => import('../features/automation/MeetingsPage'))
const AdminPage = lazy(() => import('../features/automation/AdminPage'))
const LeadsPage = lazy(() => import('../features/automation/LeadsPage'))
const LeadReviewPage = lazy(() => import('../features/automation/LeadReviewPage'))
const SettingsPage = lazy(() => import('../features/settings/SettingsPage'))
const PublicReviewsPage = lazy(() => import('../features/feedback/PublicReviewsPage'))
const CustomerFeedbackPage = lazy(() => import('../features/feedback/CustomerFeedbackPage'))
const AdminFeedbackPage = lazy(() => import('../features/feedback/AdminFeedbackPage'))

function ProtectedLayout() {
  const authenticated = useAuthStore((state) => state.isAuthenticated)
  return authenticated ? <AutomationLayout /> : <Navigate to="/login" replace />
}

export default function App() {
  const restore = useAuthStore((state) => state.restore)
  const logout = useAuthStore((state) => state.logout)

  useEffect(() => {
    restore()
    window.addEventListener('crm:unauthorized', logout)
    return () => window.removeEventListener('crm:unauthorized', logout)
  }, [restore, logout])

  return (
    <Suspense fallback={<div className="grid min-h-screen place-items-center text-sm text-slate-500">Loading workspace…</div>}>
      <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/reviews" element={<PublicReviewsPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/verify-email/:uid/:token" element={<VerifyEmailPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/reset-password/:uid/:token" element={<ResetPasswordPage />} />
          <Route element={<ProtectedLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="/ask-ai" element={<AISupportPage />} />
            <Route path="/ai-support" element={<AISupportPage />} />
            <Route path="/tickets" element={<TicketsPage />} />
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/meetings" element={<MeetingsPage />} />
            <Route path="/leads" element={<LeadsPage />} />
            <Route path="/lead-review" element={<LeadReviewPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/admin/feedback" element={<AdminFeedbackPage />} />
            <Route path="/feedback" element={<CustomerFeedbackPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}

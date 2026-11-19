import { create } from 'zustand'
import api from '../lib/api'
import { clearAuthTokens, readToken, writeAuthTokens } from '../lib/authStorage'

type AuthState = {
  isAuthenticated: boolean
  isLoading: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => void
  restore: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: Boolean(readToken('crm.access')),
  isLoading: false,
  login: async (email, password) => {
    set({ isLoading: true })
    try {
      const { data } = await api.post<{ access: string; refresh: string }>('/auth/token/', { email, password })
      writeAuthTokens(data.access, data.refresh)
      set({ isAuthenticated: true })
    } finally {
      set({ isLoading: false })
    }
  },
  logout: () => {
    const refresh = readToken('crm.refresh')
    const access = readToken('crm.access')
    if (refresh && access) {
      void api.post('/auth/logout/').catch((error: unknown) => {
        console.error('Could not revoke the CRM refresh token.', error)
      })
    }
    clearAuthTokens()
    set({ isAuthenticated: false })
  },
  restore: () => {
    clearAuthTokens()
    set({ isAuthenticated: false })
  },
}))

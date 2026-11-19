import axios from 'axios'
import { clearAuthTokens, readToken, updateAuthTokens } from './authStorage'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api/v1',
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.request.use((config) => {
  const access = readToken('crm.access')
  if (access) config.headers.Authorization = `Bearer ${access}`
  return config
})

let refreshRequest: Promise<string> | null = null

api.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    if (!axios.isAxiosError(error) || error.response?.status !== 401) throw error
    const original = error.config
    if (!original || original.url?.includes('/auth/token') || original.headers['x-auth-retried']) {
      clearAuthTokens()
      window.dispatchEvent(new Event('crm:unauthorized'))
      throw error
    }
    const refresh = readToken('crm.refresh')
    if (!refresh) {
      clearAuthTokens()
      window.dispatchEvent(new Event('crm:unauthorized'))
      throw error
    }
    original.headers['x-auth-retried'] = 'true'
    refreshRequest ??= axios
      .post<{ access: string; refresh?: string }>(`${api.defaults.baseURL}/auth/token/refresh/`, { refresh })
      .then(({ data }) => {
        updateAuthTokens(data.access, data.refresh)
        return data.access
      })
      .finally(() => {
        refreshRequest = null
      })
    try {
      original.headers.Authorization = `Bearer ${await refreshRequest}`
      return api(original)
    } catch (refreshError) {
      clearAuthTokens()
      window.dispatchEvent(new Event('crm:unauthorized'))
      throw refreshError
    }
  },
)

export default api

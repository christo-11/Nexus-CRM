const accessKey = 'crm.access'
const refreshKey = 'crm.refresh'

function storageForToken(key: string): Storage {
  return localStorage.getItem(key) !== null ? localStorage : sessionStorage
}

export function readToken(key: string): string | null {
  return localStorage.getItem(key) ?? sessionStorage.getItem(key)
}

export function writeAuthTokens(access: string, refresh: string) {
  clearAuthTokens()
  sessionStorage.setItem(accessKey, access)
  sessionStorage.setItem(refreshKey, refresh)
}

export function updateAuthTokens(access: string, refresh?: string) {
  const storage = storageForToken(refreshKey)
  storage.setItem(accessKey, access)
  if (refresh) storage.setItem(refreshKey, refresh)
}

export function clearAuthTokens() {
  localStorage.removeItem(accessKey)
  localStorage.removeItem(refreshKey)
  sessionStorage.removeItem(accessKey)
  sessionStorage.removeItem(refreshKey)
}

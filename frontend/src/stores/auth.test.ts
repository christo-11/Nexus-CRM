import { afterEach, expect, it, vi } from 'vitest'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, String(value))
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('clears saved credentials and requires login when the app starts', async () => {
  const localStorage = new MemoryStorage()
  const sessionStorage = new MemoryStorage()
  localStorage.setItem('crm.access', 'saved-access')
  localStorage.setItem('crm.refresh', 'saved-refresh')
  sessionStorage.setItem('crm.access', 'temporary-access')
  sessionStorage.setItem('crm.refresh', 'temporary-refresh')
  vi.stubGlobal('localStorage', localStorage)
  vi.stubGlobal('sessionStorage', sessionStorage)

  const { useAuthStore } = await import('./auth')

  expect(useAuthStore.getState().isAuthenticated).toBe(true)
  useAuthStore.getState().restore()

  expect(useAuthStore.getState().isAuthenticated).toBe(false)
  expect(localStorage.getItem('crm.access')).toBeNull()
  expect(localStorage.getItem('crm.refresh')).toBeNull()
  expect(sessionStorage.getItem('crm.access')).toBeNull()
  expect(sessionStorage.getItem('crm.refresh')).toBeNull()
})

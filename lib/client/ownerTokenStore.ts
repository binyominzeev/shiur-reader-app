const OWNER_TOKEN_STORAGE_KEY = 'shiur-reader-owner-token'

export function loadOwnerToken(): string | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const value = window.localStorage.getItem(OWNER_TOKEN_STORAGE_KEY)
    return value?.trim() || null
  } catch {
    return null
  }
}

export function saveOwnerToken(token: string): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(OWNER_TOKEN_STORAGE_KEY, token)
  } catch {
    // Ignore storage failures; the cookie remains the primary persistence path.
  }
}
import { BrowserWindow, session, type Session } from 'electron'
import type { AuthStatus } from '@shared/ipc'

/**
 * Authentication via Electron's own persistent session. Cookies set during the
 * embedded login live in this partition on disk, so the user logs in once and
 * stays logged in across launches — no manual cookie extraction or OS-keychain
 * storage required. All Patreon API calls and downloads reuse this session, so
 * they run inside Chromium's network stack (which clears Cloudflare challenges).
 */
export const PATREON_PARTITION = 'persist:patreon'

// A desktop Chrome UA; Electron's default UA contains "Electron" and is more
// likely to be challenged. The version must match the Chromium actually bundled
// with Electron: a hard-coded old version disagrees with the client hints the
// browser sends, which bot checks treat as a red flag and loop on.
function platformToken(): string {
  if (process.platform === 'darwin') return 'Macintosh; Intel Mac OS X 10_15_7'
  if (process.platform === 'linux') return 'X11; Linux x86_64'
  return 'Windows NT 10.0; Win64; x64'
}
const CHROME_MAJOR = (process.versions.chrome ?? '126').split('.')[0]
const CHROME_UA = `Mozilla/5.0 (${platformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`

let configured = false
export function patreonSession(): Session {
  const ses = session.fromPartition(PATREON_PARTITION)
  if (!configured) {
    ses.setUserAgent(CHROME_UA)
    configured = true
  }
  return ses
}

/** GET a Patreon JSON:API path with the persistent session. Returns null on failure. */
export async function apiGetJson(path: string): Promise<any | null> {
  try {
    const res = await patreonSession().fetch(`https://www.patreon.com${path}`, {
      headers: { Accept: 'application/json' }
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export async function getAuthStatus(): Promise<AuthStatus> {
  // /api/current_user returns the signed-in identity (or 401 when logged out).
  const me = await apiGetJson('/api/current_user')
  if (!me?.data) return { loggedIn: false, hasPaidAccess: false }
  const a = me.data.attributes ?? {}
  return {
    loggedIn: true,
    user: { name: a.full_name ?? a.first_name ?? undefined, imageUrl: a.image_url ?? undefined },
    // Paid access is resolved authoritatively during catalog load (whether any
    // gated attachment is viewable); left false here as a conservative default.
    hasPaidAccess: false
  }
}

/**
 * Opens the Patreon login page in a window using the persistent partition and
 * resolves once the session is authenticated (or the user closes the window).
 */
export function login(): Promise<AuthStatus> {
  const win = new BrowserWindow({
    width: 520,
    height: 760,
    title: 'Sign in to Patreon',
    autoHideMenuBar: true,
    webPreferences: { partition: PATREON_PARTITION, contextIsolation: true, sandbox: true }
  })
  void win.loadURL('https://www.patreon.com/login')

  return new Promise<AuthStatus>((resolve) => {
    let settled = false
    const settle = (status: AuthStatus): void => {
      if (settled) return
      settled = true
      win.removeAllListeners('closed')
      if (!win.isDestroyed()) win.close()
      resolve(status)
    }

    const check = async (): Promise<void> => {
      const status = await getAuthStatus()
      if (status.loggedIn) settle(status)
    }

    // After any navigation that lands logged-in (e.g. redirect to /home), finish.
    win.webContents.on('did-navigate', () => void check())
    win.webContents.on('did-navigate-in-page', () => void check())
    win.on('closed', () => {
      if (!settled) {
        settled = true
        resolve({ loggedIn: false, hasPaidAccess: false })
      }
    })
  })
}

/**
 * Alternative sign-in for when Patreon's bot check keeps looping in the embedded
 * login window: the user signs in to patreon.com in their normal browser and
 * pastes the value of its `session_id` cookie. It is stored only in this app's
 * own persistent session, exactly where the embedded login would have put it.
 */
export async function loginWithSessionCookie(raw: string): Promise<AuthStatus> {
  let value = (raw ?? '').trim()
  // Accept a pasted "session_id=..." pair or a whole cookie header too.
  const m = value.match(/(?:^|;\s*)session_id=([^;]+)/)
  if (m) value = m[1].trim()
  value = value.replace(/^"|"$/g, '')
  if (!value || /\s/.test(value)) return { loggedIn: false, hasPaidAccess: false }

  const ses = patreonSession()
  await ses.cookies.set({
    url: 'https://www.patreon.com',
    domain: '.patreon.com',
    path: '/',
    name: 'session_id',
    value,
    secure: true,
    httpOnly: true,
    sameSite: 'no_restriction',
    expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 180
  })
  await ses.cookies.flushStore()

  const status = await getAuthStatus()
  if (!status.loggedIn) {
    await ses.cookies.remove('https://www.patreon.com', 'session_id')
  }
  return status
}

export async function logout(): Promise<void> {
  await patreonSession().clearStorageData()
}

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  AttemptLimiter,
  SessionStore,
  parseCookies,
  sanitizeReturnPath,
  verifyPassword,
  verifyPlainPassword,
} from './auth.js'

export const name = 'dsh-web-auth'

export const Config = Schema.object({
  // Any bind address is allowed: a concrete LAN IPv4/IPv6, a host name, or the
  // loopback/all-interfaces literals. Authentication is forced for every
  // non-loopback bind (see authRequired below), so opening a specific network
  // address still cannot reach the control surface without a login.
  host: Schema.string().default('127.0.0.1'),
  port: Schema.number().min(0).max(65_535).default(3080),
  authMode: Schema.union(['always', 'non-loopback']).default('always'),
  username: Schema.string().default('admin'),
  password: Schema.string(),
  passwordHash: Schema.string(),
  sessionTtlMinutes: Schema.number().min(1).max(43_200).default(720),
  maxAttempts: Schema.number().min(1).max(1_000).default(5),
  attemptWindowSeconds: Schema.number().min(1).max(86_400).default(300),
  secureCookie: Schema.union(['auto', 'always', 'never']).default('auto'),
  trustProxy: Schema.boolean().default(false),
})

const COOKIE_NAME = 'dsh_web_auth'
const AUTH_PREFIX = '/auth'
const MAX_LOGIN_BODY_BYTES = 16 * 1024
const DEEPSEEK_FAVICON = readFileSync(new URL('./assets/deepseek-favicon.svg', import.meta.url), 'utf8')
const AUTH_BOOTSTRAP_SCRIPT = `(() => {
  const nativeFetch = globalThis.fetch.bind(globalThis)
  let redirecting = false
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href)
    const sameOrigin = url.origin === location.origin
    const response = await nativeFetch(input, sameOrigin ? { ...init, credentials: 'same-origin' } : init)
    if (sameOrigin && response.status === 401 && !redirecting) {
      void response.clone().json().then((body) => {
        if (body?.error !== 'authentication_required' || redirecting) return
        redirecting = true
        const next = location.pathname + location.search + location.hash
        location.replace('/auth/login?next=' + encodeURIComponent(next))
      }).catch(() => {})
    }
    return response
  }
})()`

function injectAuthBootstrap(html) {
  return html.replace('<head>', '<head>\n<script src="/auth/bootstrap.js"></script>')
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function loginPage(next, message = '') {
  const safeNext = escapeHtml(sanitizeReturnPath(next))
  const feedback = message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/auth/favicon.svg">
  <meta name="color-scheme" content="light dark">
  <title>登录 | DeepSeek Harness</title>
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2329;background:#f7f9fc}
    *{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;background:#f7f9fc}
    main{width:min(100%,400px);background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:34px 34px 30px;box-shadow:0 12px 30px rgba(31,35,41,.08);animation:rise .35s ease-out both}
    .brand{display:flex;align-items:center;gap:10px;color:#1f2329;font-size:18px;font-weight:700;letter-spacing:0}
    .mark{width:34px;height:34px;display:grid;place-items:center;border-radius:10px;background:#f0f3f8;box-shadow:0 4px 10px rgba(31,35,41,.1);overflow:hidden}.mark img{display:block;width:100%;height:100%;object-fit:contain}
    h1{font-size:24px;line-height:1.25;margin:28px 0 7px;letter-spacing:0;color:#1f2329}p{margin:0 0 24px;color:#697386;font-size:14px;line-height:1.5}
    label{display:block;font-size:13px;font-weight:650;margin:16px 0 7px;color:#374151}input{width:100%;height:44px;border:1px solid #d7dce5;border-radius:7px;padding:0 12px;font:inherit;background:#fff;color:#1f2329;outline:none;transition:border-color .18s ease,box-shadow .18s ease}input:focus{border-color:#4d6bfe;box-shadow:0 0 0 3px rgba(77,107,254,.14)}
    button{width:100%;height:44px;margin-top:22px;border:0;border-radius:7px;background:#4d6bfe;color:#fff;font:inherit;font-weight:700;cursor:pointer;transition:background .18s ease,transform .18s ease,box-shadow .18s ease;box-shadow:0 4px 10px rgba(77,107,254,.18)}button:hover{background:#4059d8;box-shadow:0 6px 14px rgba(77,107,254,.24)}button:active{transform:translateY(1px)}.error{margin:0 0 14px;padding:10px 12px;border-left:3px solid #d14343;background:#fff5f5;color:#a12d2d;border-radius:5px;font-size:13px}
    footer{margin-top:22px;color:#9aa3b2;font-size:12px;text-align:center}@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}@media(prefers-reduced-motion:reduce){main,input,button{animation:none;transition:none}}
  </style>
</head>
<body>
  <main>
    <div class="brand"><div class="mark" aria-hidden="true"><img src="/auth/favicon.svg" alt=""></div><span>DeepSeek</span></div>
    <h1>DeepSeek Harness</h1>
    <p>此服务需要身份验证。</p>
    ${feedback}
    <form method="post" action="/auth/login">
      <input type="hidden" name="next" value="${safeNext}">
      <label for="username">用户名</label>
      <input id="username" name="username" autocomplete="username" required autofocus>
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">登录</button>
    </form>
    <footer>DSH Web Auth</footer>
  </main>
</body>
</html>`
}

function addSecurityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
}

function sendHtml(res, status, html) {
  addSecurityHeaders(res)
  res.statusCode = status
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(html))
  res.end(html)
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  addSecurityHeaders(res)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

async function readLoginBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_LOGIN_BODY_BYTES) throw new Error('LOGIN_BODY_TOO_LARGE')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim()
  if (contentType === 'application/json') {
    const parsed = JSON.parse(raw)
    return {
      username: typeof parsed.username === 'string' ? parsed.username : '',
      password: typeof parsed.password === 'string' ? parsed.password : '',
      next: typeof parsed.next === 'string' ? parsed.next : '/',
    }
  }
  const parsed = new URLSearchParams(raw)
  return {
    username: parsed.get('username') ?? '',
    password: parsed.get('password') ?? '',
    next: parsed.get('next') ?? '/',
  }
}

export default class AuthenticatedWebServer extends Service {
  static Config = Config
  constructor(ctx, config) {
    super(ctx, 'webServer')
    this.config = config
    this.logger = ctx.logger('dsh-web-auth')
    this.routes = new Map()
    this.upgrades = new Map()
    this.indexTaps = [injectAuthBootstrap]
    this.fallback = undefined
    this.boundPort = config.port
    this.authRequired = config.authMode === 'always' || config.host !== '127.0.0.1'

    if (this.authRequired && !config.password && !config.passwordHash) {
      throw new Error('dsh-web-auth requires DSH_WEB_AUTH_PASSWORD_HASH or DSH_WEB_AUTH_PASSWORD when authentication is active.')
    }
    if (config.passwordHash && !config.passwordHash.startsWith('scrypt$')) {
      throw new Error('dsh-web-auth passwordHash must use the scrypt format generated by dsh-web-auth hash-password.')
    }

    this.sessions = new SessionStore(config.sessionTtlMinutes * 60_000)
    this.limiter = new AttemptLimiter(config.maxAttempts, config.attemptWindowSeconds * 1000)
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => this.handleRequestError(error, res))
    })
    this.server.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket, head).catch((error) => {
        this.logger.warn('WebSocket upgrade failed: %s', error instanceof Error ? error.message : String(error))
        socket.destroy()
      })
    })

  }

  async [Service.init]() {
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error)
      this.server.once('error', onError)
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off('error', onError)
        const address = this.server.address()
        if (address && typeof address === 'object') this.boundPort = address.port
        resolve()
      })
    })
    return async () => {
      this.server.closeAllConnections?.()
      await new Promise((resolve) => this.server.close(() => resolve()))
    }
  }

  get host() {
    return this.config.host
  }

  get port() {
    return this.boundPort
  }

  register(route) {
    this.validateRoute(route)
    const key = `${route.kind}:${route.path}`
    if (this.routes.has(key)) throw new Error(`Duplicate Web route: ${key}`)
    this.routes.set(key, route)
    return () => this.routes.delete(key)
  }

  registerUpgrade(route) {
    // Match stock dsh-host-webserver: absolute path required; trailing slash is allowed
    // (e.g. remote-web-ui registers exact "/m/" for the mobile SPA root).
    if (!route || typeof route.path !== 'string' || !route.path.startsWith('/')) {
      throw new Error('Web upgrade route path must be an absolute path.')
    }
    if (this.upgrades.has(route.path)) throw new Error(`Duplicate Web upgrade route: ${route.path}`)
    this.upgrades.set(route.path, route.handler)
    return () => this.upgrades.delete(route.path)
  }

  registerFallback(handler) {
    if (this.fallback) throw new Error('The Web fallback route is already registered.')
    this.fallback = handler
    return () => {
      if (this.fallback === handler) this.fallback = undefined
    }
  }

  tapIndex(transform) {
    this.indexTaps.push(transform)
    return () => {
      const index = this.indexTaps.indexOf(transform)
      if (index >= 0) this.indexTaps.splice(index, 1)
    }
  }

  applyIndexTaps(html) {
    return this.indexTaps.reduce((current, transform) => transform(current), html)
  }

  validateRoute(route) {
    if (!route || !['exact', 'prefix'].includes(route.kind) || typeof route.handler !== 'function') {
      throw new Error('Invalid Web route registration.')
    }
    // Match stock dsh-host-webserver: absolute path required; trailing slash is allowed
    // (e.g. remote-web-ui registers exact "/m/" for the mobile SPA root).
    if (typeof route.path !== 'string' || !route.path.startsWith('/')) {
      throw new Error('Web route path must be an absolute path.')
    }
  }

  requestIp(req) {
    if (this.config.trustProxy) {
      const forwarded = req.headers['x-forwarded-for']
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',', 1)[0]
      if (first?.trim()) return first.trim()
    }
    return req.socket.remoteAddress ?? 'unknown'
  }

  isSecureRequest(req) {
    if (this.config.secureCookie === 'always') return true
    if (this.config.secureCookie === 'never') return false
    if (req.socket.encrypted) return true
    if (!this.config.trustProxy) return false
    const proto = req.headers['x-forwarded-proto']
    return (Array.isArray(proto) ? proto[0] : proto?.split(',', 1)[0])?.trim().toLowerCase() === 'https'
  }

  cookieHeader(token, req, maxAgeSeconds) {
    const parts = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`]
    if (this.isSecureRequest(req)) parts.push('Secure')
    return parts.join('; ')
  }

  currentSession(req) {
    if (!this.authRequired) return { username: this.config.username }
    return this.sessions.get(parseCookies(req.headers.cookie).get(COOKIE_NAME))
  }

  credentialsMatch(username, password) {
    const userMatches = verifyPlainPassword(username, this.config.username)
    const passwordMatches = this.config.passwordHash
      ? verifyPassword(password, this.config.passwordHash)
      : verifyPlainPassword(password, this.config.password)
    return userMatches && passwordMatches
  }

  validOrigin(req) {
    const origin = req.headers.origin
    if (!origin) return true
    try {
      const scheme = this.isSecureRequest(req) ? 'https:' : 'http:'
      const requestOrigin = new URL(`${scheme}//${req.headers.host}`).origin
      return new URL(origin).origin === requestOrigin
    } catch {
      return false
    }
  }

  async handleAuthRoute(pathname, url, req, res) {
    if (pathname === '/auth/bootstrap.js' && (req.method === 'GET' || req.method === 'HEAD')) {
      addSecurityHeaders(res)
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
      res.setHeader('Content-Length', Buffer.byteLength(AUTH_BOOTSTRAP_SCRIPT))
      return res.end(req.method === 'HEAD' ? undefined : AUTH_BOOTSTRAP_SCRIPT)
    }

    if (pathname === '/auth/favicon.svg' && (req.method === 'GET' || req.method === 'HEAD')) {
      addSecurityHeaders(res)
      res.statusCode = 200
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
      res.setHeader('Content-Length', Buffer.byteLength(DEEPSEEK_FAVICON))
      return res.end(req.method === 'HEAD' ? undefined : DEEPSEEK_FAVICON)
    }

    if (pathname === '/auth/login' && (req.method === 'GET' || req.method === 'HEAD')) {
      const html = loginPage(url.searchParams.get('next') ?? '/')
      if (req.method === 'HEAD') {
        addSecurityHeaders(res)
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        return res.end()
      }
      return sendHtml(res, 200, html)
    }

    if (pathname === '/auth/login' && req.method === 'POST') {
      if (!this.validOrigin(req)) return sendJson(res, 403, { error: 'invalid_origin' })
      const ip = this.requestIp(req)
      const decision = this.limiter.check(ip)
      if (!decision.allowed) {
        res.setHeader('Retry-After', decision.retryAfterSeconds)
        return sendHtml(res, 429, loginPage('/', '尝试次数过多，请稍后重试。'))
      }
      let body
      try {
        body = await readLoginBody(req)
      } catch {
        return sendJson(res, 400, { error: 'invalid_login_request' })
      }
      if (!this.credentialsMatch(body.username, body.password)) {
        this.limiter.fail(ip)
        return sendHtml(res, 401, loginPage(body.next, '用户名或密码错误。'))
      }
      this.limiter.clear(ip)
      const token = this.sessions.create(this.config.username)
      res.statusCode = 303
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Set-Cookie', this.cookieHeader(token, req, this.config.sessionTtlMinutes * 60))
      res.setHeader('Location', sanitizeReturnPath(body.next))
      return res.end()
    }

    if (pathname === '/auth/logout' && req.method === 'POST') {
      if (!this.validOrigin(req)) return sendJson(res, 403, { error: 'invalid_origin' })
      this.sessions.delete(parseCookies(req.headers.cookie).get(COOKIE_NAME))
      res.statusCode = 303
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Set-Cookie', this.cookieHeader('', req, 0))
      res.setHeader('Location', '/auth/login')
      return res.end()
    }

    if (pathname === '/auth/status' && req.method === 'GET') {
      const session = this.currentSession(req)
      return sendJson(res, session ? 200 : 401, {
        authenticated: Boolean(session),
        required: this.authRequired,
        username: session?.username,
      })
    }

    res.statusCode = 405
    res.setHeader('Allow', pathname === '/auth/status' ? 'GET' : 'GET, HEAD, POST')
    return res.end()
  }

  async handleRequest(req, res) {
    const url = new URL(req.url ?? '/', 'http://dsh.local')
    const pathname = decodeURIComponent(url.pathname)

    if (pathname === AUTH_PREFIX || pathname.startsWith(`${AUTH_PREFIX}/`)) {
      return this.handleAuthRoute(pathname, url, req, res)
    }

    if (!this.currentSession(req)) {
      const acceptsHtml = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')
      if (acceptsHtml) {
        res.statusCode = 302
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Location', `/auth/login?next=${encodeURIComponent(sanitizeReturnPath(req.url ?? '/'))}`)
        return res.end()
      }
      return sendJson(res, 401, { error: 'authentication_required' })
    }

    const exact = this.routes.get(`exact:${pathname}`)
    if (exact) return exact.handler(req, res)

    const prefix = [...this.routes.values()]
      .filter((route) => route.kind === 'prefix' && (pathname === route.path || pathname.startsWith(`${route.path}/`)))
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (prefix) return prefix.handler(req, res)
    if (this.fallback) return this.fallback(req, res)
    res.statusCode = 404
    res.end('Not Found')
  }

  async handleUpgrade(req, socket, head) {
    const url = new URL(req.url ?? '/', 'http://dsh.local')
    const pathname = decodeURIComponent(url.pathname)
    if (!this.currentSession(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n{"error":"authentication_required"}')
      socket.destroy()
      return
    }
    const handler = this.upgrades.get(pathname)
    if (!handler) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    await handler(req, socket, head)
  }

  handleRequestError(error, res) {
    this.logger.warn('HTTP request failed: %s', error instanceof Error ? error.message : String(error))
    if (res.headersSent) return res.destroy()
    sendJson(res, 400, { error: 'bad_request' })
  }
}

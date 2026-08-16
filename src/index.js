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
  host: Schema.union(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
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
  <meta name="color-scheme" content="light dark">
  <title>登录 | DeepSeek Harness</title>
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#17211b;background:#eef2ef}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:linear-gradient(145deg,#e8efeb 0%,#f7f8f7 55%,#e7ece9 100%)}
    main{width:min(100%,380px);background:#fff;border:1px solid #d9e0dc;border-radius:8px;padding:30px;box-shadow:0 16px 50px rgba(22,38,29,.12)}
    .mark{width:38px;height:38px;display:grid;place-items:center;background:#153c2b;color:#fff;border-radius:7px;font-weight:750;font-size:17px}
    h1{font-size:22px;line-height:1.25;margin:22px 0 6px;letter-spacing:0}p{margin:0 0 22px;color:#617067;font-size:14px;line-height:1.5}
    label{display:block;font-size:13px;font-weight:650;margin:14px 0 7px}input{width:100%;height:42px;border:1px solid #b9c5be;border-radius:6px;padding:0 11px;font:inherit;background:#fff;color:#17211b;outline:none}input:focus{border-color:#1d6847;box-shadow:0 0 0 3px rgba(29,104,71,.14)}
    button{width:100%;height:42px;margin-top:20px;border:0;border-radius:6px;background:#17633f;color:#fff;font:inherit;font-weight:700;cursor:pointer}button:hover{background:#105234}.error{margin:0 0 12px;padding:10px 12px;border-left:3px solid #bd2c2c;background:#fff2f2;color:#8f2020;border-radius:3px;font-size:13px}
    footer{margin-top:20px;color:#7a8780;font-size:12px;text-align:center}@media(prefers-color-scheme:dark){:root{color:#e9efeb;background:#111713}body{background:#111713}main{background:#19211c;border-color:#344139;box-shadow:none}p,footer{color:#a7b4ac}input{background:#111713;color:#eef3ef;border-color:#4b5b51}.error{background:#351d1d;color:#ffb9b9}}
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">DS</div>
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
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
  res.setHeader('Referrer-Policy', 'no-referrer')
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
    this.indexTaps = []
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
    if (!route || typeof route.path !== 'string' || !route.path.startsWith('/') || route.path.endsWith('/')) {
      throw new Error('Web upgrade route path must be absolute and have no trailing slash.')
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
    if (typeof route.path !== 'string' || !route.path.startsWith('/') || (route.path !== '/' && route.path.endsWith('/'))) {
      throw new Error('Web route path must be absolute and have no trailing slash.')
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
      return new URL(origin).host === req.headers.host
    } catch {
      return false
    }
  }

  async handleAuthRoute(pathname, url, req, res) {
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

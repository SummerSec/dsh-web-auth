import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AuthenticatedWebServer from '../src/index.js'

const config = {
  host: '127.0.0.1',
  port: 0,
  authMode: 'always',
  username: 'admin',
  password: 'a long integration password',
  sessionTtlMinutes: 10,
  maxAttempts: 5,
  attemptWindowSeconds: 60,
  secureCookie: 'never',
  trustProxy: false,
}

function rawUpgrade(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let response = ''
    socket.setEncoding('utf8')
    socket.setTimeout(2000, () => socket.destroy(new Error('upgrade response timeout')))
    socket.on('connect', () => {
      socket.write('GET /socket HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    })
    socket.on('data', (chunk) => { response += chunk })
    socket.on('close', () => resolve(response))
    socket.on('error', reject)
  })
}

test('the live provider gates navigation, API routes, and upgrades', async (t) => {
  const ctx = new Context()
  const fiber = ctx.plugin(AuthenticatedWebServer, config)
  await fiber.await()
  t.after(() => fiber.dispose())

  const origin = `http://127.0.0.1:${ctx.webServer.port}`
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/test',
    handler: (_req, res) => res.end('ok'),
  })

  const navigation = await fetch(`${origin}/`, {
    headers: { accept: 'text/html' },
    redirect: 'manual',
  })
  assert.equal(navigation.status, 302)
  assert.equal(navigation.headers.get('location'), '/auth/login?next=%2F')

  const loginPage = await fetch(`${origin}/auth/login`)
  assert.equal(loginPage.status, 200)
  assert.equal(loginPage.headers.get('referrer-policy'), 'same-origin')
  assert.match(loginPage.headers.get('content-security-policy') ?? '', /script-src 'self'/)
  assert.match(await loginPage.text(), /href="\/auth\/favicon\.svg"/)

  const favicon = await fetch(`${origin}/auth/favicon.svg`)
  assert.equal(favicon.status, 200)
  assert.equal(favicon.headers.get('content-type'), 'image/svg+xml; charset=utf-8')
  assert.match(await favicon.text(), /<svg\b/)

  const bootstrap = await fetch(`${origin}/auth/bootstrap.js`)
  assert.equal(bootstrap.status, 200)
  assert.match(await bootstrap.text(), /credentials: 'same-origin'/)
  assert.match(ctx.webServer.applyIndexTaps('<html><head></head></html>'), /\/auth\/bootstrap\.js/)

  const denied = await fetch(`${origin}/api/test`)
  assert.equal(denied.status, 401)

  const login = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    body: new URLSearchParams({
      username: 'admin',
      password: config.password,
      next: '/api/test',
    }),
    redirect: 'manual',
  })
  assert.equal(login.status, 303)
  assert.match(login.headers.get('set-cookie') ?? '', /HttpOnly/)
  assert.match(login.headers.get('set-cookie') ?? '', /SameSite=Strict/)

  const cookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0]
  const allowed = await fetch(`${origin}/api/test`, { headers: { cookie } })
  assert.equal(allowed.status, 200)
  assert.equal(await allowed.text(), 'ok')

  assert.match(await rawUpgrade(ctx.webServer.port), /^HTTP\/1\.1 401 Unauthorized/)
})

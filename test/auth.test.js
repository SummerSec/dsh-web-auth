import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AttemptLimiter,
  SessionStore,
  hashPassword,
  parseCookies,
  sanitizeReturnPath,
  verifyPassword,
  verifyPlainPassword,
} from '../src/auth.js'

test('scrypt password hashes verify without accepting malformed values', () => {
  const encoded = hashPassword('a sufficiently long password', { salt: Buffer.alloc(16, 7) })
  assert.equal(verifyPassword('a sufficiently long password', encoded), true)
  assert.equal(verifyPassword('wrong password', encoded), false)
  assert.equal(verifyPassword('anything', 'scrypt$bad'), false)
})

test('plain password comparison rejects non-matches', () => {
  assert.equal(verifyPlainPassword('correct horse battery staple', 'correct horse battery staple'), true)
  assert.equal(verifyPlainPassword('wrong', 'correct horse battery staple'), false)
})

test('cookie parser tolerates malformed values', () => {
  const cookies = parseCookies('theme=dark; dsh_auth=abc%20123; broken=%E0%A4%A')
  assert.equal(cookies.get('theme'), 'dark')
  assert.equal(cookies.get('dsh_auth'), 'abc 123')
  assert.equal(cookies.has('broken'), false)
})

test('return paths cannot become external redirects or response splitting', () => {
  assert.equal(sanitizeReturnPath('/sessions/1?tab=chat'), '/sessions/1?tab=chat')
  assert.equal(sanitizeReturnPath('//evil.example'), '/')
  assert.equal(sanitizeReturnPath('https://evil.example'), '/')
  assert.equal(sanitizeReturnPath('/ok\r\nLocation: https://evil.example'), '/')
})

test('sessions expire and slide while active', () => {
  let now = 1000
  const sessions = new SessionStore(100, () => now)
  const token = sessions.create('admin')
  now = 1050
  assert.equal(sessions.get(token)?.username, 'admin')
  now = 1120
  assert.equal(sessions.get(token)?.username, 'admin')
  now = 1221
  assert.equal(sessions.get(token), undefined)
})

test('attempt limiter blocks at the configured threshold and resets', () => {
  let now = 1000
  const limiter = new AttemptLimiter(2, 500, () => now)
  assert.equal(limiter.check('ip').allowed, true)
  limiter.fail('ip')
  limiter.fail('ip')
  assert.equal(limiter.check('ip').allowed, false)
  now = 1501
  assert.equal(limiter.check('ip').allowed, true)
})

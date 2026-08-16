#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { hashPassword } from '../src/auth.js'

function usage() {
  console.error('Usage:')
  console.error('  dsh-web-auth generate')
  console.error('  $env:WEB_AUTH_PASSWORD="..."; dsh-web-auth hash-password')
  console.error('  echo "..." | dsh-web-auth hash-password')
}

async function readPassword() {
  if (process.env.WEB_AUTH_PASSWORD) return process.env.WEB_AUTH_PASSWORD
  if (!process.stdin.isTTY) return (await readFile(0, 'utf8')).replace(/[\r\n]+$/, '')
  throw new Error('Set WEB_AUTH_PASSWORD or pipe the password through stdin; passwords are not accepted as command arguments.')
}

const command = process.argv[2]
try {
  if (command === 'generate') {
    const password = randomBytes(24).toString('base64url')
    console.log(`WEB_AUTH_PASSWORD=${password}`)
    console.log(`WEB_AUTH_PASSWORD_HASH=${hashPassword(password)}`)
  } else if (command === 'hash-password') {
    console.log(hashPassword(await readPassword()))
  } else {
    usage()
    process.exitCode = 1
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

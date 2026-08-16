# dsh-web-auth

A transport-level login gate for the DeepSeek Harness Web GUI. It replaces the official `webserver` row while preserving the `ctx.webServer` contract, authenticating requests before they reach the GUI, plugin bundles, `/api`, SSE, or WebSocket routes.

See [README.zh-CN.md](./README.zh-CN.md) for full setup and deployment instructions.

## Quick start

```powershell
node .\bin\dsh-web-auth.js generate
$env:WEB_AUTH_PASSWORD_HASH = 'scrypt$...'
dsh plugin --profile web add @summersec/dsh-web-auth
dsh web
```

Authentication is enabled for every bind by default. Use `WEB_AUTH_MODE=non-loopback` only when loopback access should remain unauthenticated. Public deployments still require an HTTPS reverse proxy.

## Checks

```powershell
node --test
npm pack --dry-run
dsh --profile web --dump-config
```

MIT

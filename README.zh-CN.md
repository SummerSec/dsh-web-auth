# dsh-web-auth

DeepSeek Harness Web GUI 的传输层登录门。它替换官方 `webserver` 配置行，但保持 `ctx.webServer` 契约不变，在请求进入官方页面、插件 bundle、`/api`、SSE 和 WebSocket 路由前统一校验会话。

## 安全特性

- 默认 `always`：即使只监听 `127.0.0.1` 也必须登录。
- 可选 `non-loopback`：仅在绑定 `0.0.0.0` 时启用鉴权。
- 服务端随机会话，`HttpOnly; SameSite=Strict` Cookie，滑动过期。
- scrypt 口令散列与恒定时间比较；也支持通过进程环境临时传入明文口令。
- 按客户端 IP 限制登录失败次数。
- 同时保护 HTTP 路由与 HTTP upgrade，不依赖前端遮罩。

## 安装

在本项目上级目录执行：

```powershell
# 生成随机口令和散列；妥善保存第一行口令
node .\dsh-web-auth\bin\dsh-web-auth.js generate

# 当前 PowerShell 会话设置散列
$env:WEB_AUTH_PASSWORD_HASH = 'scrypt$...'
$env:WEB_AUTH_USERNAME = 'admin'

# 安装到 web profile
dsh plugin --profile web add @summersec/dsh-web-auth
```

重启 `dsh web` 后访问原地址，未登录会跳转到 `/auth/login`。不要把口令或散列提交到仓库，也不要把它们写进项目的 `.env`。

已有口令可以这样生成散列：

```powershell
$env:WEB_AUTH_PASSWORD = '至少十二个字符的强口令'
node .\dsh-web-auth\bin\dsh-web-auth.js hash-password
Remove-Item Env:WEB_AUTH_PASSWORD
```

## 部署模式

默认总是鉴权：

```powershell
$env:WEB_AUTH_MODE = 'always'
dsh web
```

只在内网/公网监听时鉴权：

```powershell
$env:WEB_AUTH_MODE = 'non-loopback'
dsh web --host 0.0.0.0
```

公网部署必须在 DSH 前放置 HTTPS 反向代理。默认 `secureCookie: auto` 会在直接 TLS 连接时加 `Secure`；若 TLS 在反向代理终止，需要在 profile 覆盖配置中设置 `trustProxy: true`，并确保 DSH 端口只允许可信代理访问。否则攻击者可伪造 `X-Forwarded-*`。

## 配置

插件 bundle 通过环境变量提供最常用配置：

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `WEB_AUTH_MODE` | `always` | `always` 或 `non-loopback` |
| `WEB_AUTH_USERNAME` | `admin` | 登录用户名 |
| `WEB_AUTH_PASSWORD_HASH` | 无 | 推荐的 scrypt 散列 |
| `WEB_AUTH_PASSWORD` | 无 | 仅用于临时部署的明文口令 |

bundle 会禁用官方 `webserver` 行并插入兼容的 `webserver-auth` 行。高级选项在 profile 的 `cordis.patch.yml` 中覆盖 `webserver-auth`；配置按整块替换，必须完整保留所需字段：

```yaml
- id: webserver-auth
  name: '@summersec/dsh-web-auth'
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
    authMode: always
    username: admin
    passwordHash: !!js process.env.WEB_AUTH_PASSWORD_HASH
    sessionTtlMinutes: 720
    maxAttempts: 5
    attemptWindowSeconds: 300
    secureCookie: auto
    trustProxy: false
```

`secureCookie` 可取 `auto | always | never`。`trustProxy` 只应在受控反向代理拓扑中启用。

## 发布到 npm

`@summersec/dsh-web-auth` 当前未被占用。首次发布前确认登录账号对 `@summersec` scope 有发布权限：

```powershell
cd D:\ghproject\dsh-web-auth
npm login
npm whoami
npm run check
npm pack --dry-run
npm publish --access public
```

如果账号开启了双因素认证，发布时按提示输入 OTP，或执行 `npm publish --access public --otp=123456`。后续版本不能重复发布 `0.1.0`，先按变更级别升级版本：

```powershell
npm version patch   # 0.1.0 -> 0.1.1
npm publish --access public
```

发布成功后验证：

```powershell
npm view @summersec/dsh-web-auth version
dsh plugin --profile web add @summersec/dsh-web-auth
```

## 验证

```powershell
npm run check
npm pack --dry-run
dsh --profile web --dump-config
```

检查 dump 中官方 `webserver` 行为 `disabled: true`，并存在名称为 `@summersec/dsh-web-auth` 的 `webserver-auth` 行；启动日志不得出现 `FAILED`。

## 限制

- 会话保存在内存中，DSH 重启后需要重新登录。
- 当前是单账号共享访问边界，不提供用户级权限隔离或审计角色。
- 插件保护的是 DSH 自带 HTTP 服务；若代理额外暴露了其他端口，需要在代理层单独鉴权。

MIT

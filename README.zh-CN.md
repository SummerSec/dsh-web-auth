# dsh-web-auth

[![npm](https://img.shields.io/npm/v/@summersec/dsh-web-auth.svg)](https://www.npmjs.com/package/@summersec/dsh-web-auth)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-111827)](https://github.com/topics/dsh-plugin)

DeepSeek Harness（DSH）Web GUI 的**传输层登录门**。

官方 `webserver` 会直接暴露 GUI、插件 bundle、`/api`、SSE 与 WebSocket，没有统一的身份边界。本插件会**禁用**未鉴权的官方载体，并替换为兼容 `ctx.webServer` 契约的服务：在请求进入业务路由之前完成会话校验。

English: [README.md](./README.md)

---

## 登录页面

![DeepSeek Harness 登录页面](./docs/assets/dsh-web-auth-login-v0.1.2.png)

---

## 为什么需要它

DSH 自带 Web 宿主适合本地调试，但不是产品级访问控制：

- 监听 `0.0.0.0` 或挂到反向代理后，控制面可能被整站暴露。
- 仅靠前端“登录页”挡不住 `/api`、静态插件资源、SSE 与 WebSocket upgrade。
- 会话与口令校验必须落在 HTTP 载体本身。

`@summersec/dsh-web-auth` 做的事：

1. 禁用 `@deepseek-ai/dsh-host-webserver`。
2. 插入 `webserver-auth`，继续提供相同的 `ctx.webServer` 接口（`register` / `registerUpgrade` / `registerFallback` / `tapIndex` / `host` / `port`）。
3. 用服务端会话 Cookie 拦截 HTTP 与 upgrade 流量。

其他插件仍按原方式注册路由，无需感知鉴权实现。

---

## 功能一览

| 方面 | 行为 |
| --- | --- |
| 保护范围 | HTTP 路由 **与** WebSocket / HTTP upgrade |
| 默认模式 | `always`：即使绑定 `127.0.0.1` 也要登录 |
| 可选模式 | `non-loopback`：仅非 loopback 绑定时启用鉴权 |
| 口令 | scrypt 散列（`scrypt$N$r$p$salt$key`）；明文环境变量仅作临时用途 |
| 会话 | 32 字节随机 token、内存存储、滑动过期 |
| Cookie | `HttpOnly`、`SameSite=Strict`，按需 `Secure` |
| 防爆破 | 按客户端 IP 限制登录失败次数，返回 `Retry-After` |
| 登录体验 | 内置 `/auth/login` 页面（浅色/深色），支持表单与 JSON |
| 加固 | 登录/登出 Origin 校验、回跳路径净化、鉴权响应 CSP 与防嵌套 |

---

## 环境要求

- **Node.js** `>= 22`
- 已配置 **web profile** 的 DeepSeek Harness（peer：`@deepseek-ai/cordis` `^4.0.1`）
- 进程环境中的口令**散列**（推荐），或临时明文口令

---

## 快速开始

```powershell
# 1) 生成随机口令与 scrypt 散列（请离线妥善保存口令）
npx --yes @summersec/dsh-web-auth generate

# 2) 仅在当前 shell 导出散列（不要提交到仓库）
$env:WEB_AUTH_PASSWORD_HASH = 'scrypt$...'
$env:WEB_AUTH_USERNAME = 'admin'

# 3) 安装到 web profile
dsh plugin --profile web add @summersec/dsh-web-auth

# 4) 启动 GUI
dsh web
```

访问原来的 DSH 地址。未登录的浏览器导航会跳转到 `/auth/login`；API 等非 HTML 客户端收到 `401` JSON：

```json
{ "error": "authentication_required" }
```

登录成功后写入会话 Cookie，并跳回原路径。页面注入的浏览器引导会让同源 API、SSE 和第三方插件请求明确携带该 Cookie；如果内存会话过期或服务重启导致旧会话失效，收到 `authentication_required` 时会自动回到登录页，避免插件停留在无提示的传输失败状态。

> **不要**把口令或散列写进会共享/提交的项目 `.env`。优先使用进程环境、密钥管理系统，或仓库外的主机级环境文件。

---

## 从源码安装

```powershell
git clone https://github.com/SummerSec/dsh-web-auth.git
cd dsh-web-auth
npm install

node .\bin\dsh-web-auth.js generate
$env:WEB_AUTH_PASSWORD_HASH = 'scrypt$...'

# 在 DSH 工作区侧，或使用本地路径安装：
dsh plugin --profile web add <path-to-dsh-web-auth>
dsh web
```

已有口令生成散列（至少 **12** 个字符）：

```powershell
$env:WEB_AUTH_PASSWORD = '至少十二个字符的强口令'
node .\bin\dsh-web-auth.js hash-password
Remove-Item Env:WEB_AUTH_PASSWORD
```

也可通过 stdin 传入（CLI **不会**接受命令行参数形式的口令）：

```powershell
'至少十二个字符的强口令' | node .\bin\dsh-web-auth.js hash-password
```

---

## 鉴权模式

| `authMode` / `WEB_AUTH_MODE` | 何时启用鉴权 |
| --- | --- |
| `always`（**默认**） | 始终启用，包括 `host: 127.0.0.1` |
| `non-loopback` | 仅当 `host` 不是 `127.0.0.1` 时启用（例如具体局域网 IP） |

```powershell
# 默认：永远需要登录
$env:WEB_AUTH_MODE = 'always'
dsh web

# loopback 可不登录；绑定任何非 loopback 地址都会自动开闸
$env:WEB_AUTH_MODE = 'non-loopback'
dsh web --host 192.168.1.20
```

当鉴权处于启用状态，且既未配置 `passwordHash` 也未配置 `password` 时，插件会在**启动阶段直接抛错**，避免误上线成“空门”服务。

---

## 环境变量

bundle（`cordis.patch.yml`）将这些变量映射到插件配置：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `WEB_AUTH_MODE` | `always` | `always` 或 `non-loopback` |
| `WEB_AUTH_USERNAME` | `admin` | 登录用户名 |
| `WEB_AUTH_PASSWORD_HASH` | （无） | 推荐：由 `generate` / `hash-password` 生成的 scrypt 散列 |
| `WEB_AUTH_PASSWORD` | （无） | 明文口令，仅建议临时/实验环境使用 |

生产与长期部署请优先使用 `WEB_AUTH_PASSWORD_HASH`。

---

## 高级配置

bundle 会：

1. 将官方 `webserver` 行设为 `disabled: true`。
2. 插入名为 `@summersec/dsh-web-auth` 的 `webserver-auth` 行。

DSH 补丁对配置是**整块替换**。若要覆盖高级字段，请在 profile 的 `cordis.patch.yml` 中完整重写 `webserver-auth`：

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

### 配置项说明

| 字段 | 类型 / 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `host` | IP 或主机名 | `127.0.0.1` | 监听地址；任何非 loopback 绑定都会强制鉴权 |
| `port` | `0`–`65535` | `3080` | 监听端口；`0` 表示系统分配 |
| `authMode` | `always` \| `non-loopback` | `always` | 见[鉴权模式](#鉴权模式) |
| `username` | string | `admin` | 单账号共享访问边界 |
| `password` | string | — | 明文；生产环境避免使用 |
| `passwordHash` | `scrypt$...` | — | 必须为 CLI 生成的格式 |
| `sessionTtlMinutes` | `1`–`43200` | `720`（12 小时） | 滑动过期：每次鉴权成功访问会续期 |
| `maxAttempts` | `1`–`1000` | `5` | 同一 IP 在窗口内允许的失败次数 |
| `attemptWindowSeconds` | `1`–`86400` | `300` | 失败计数窗口长度 |
| `secureCookie` | `auto` \| `always` \| `never` | `auto` | 是否附加 Cookie `Secure` |
| `trustProxy` | boolean | `false` | 是否信任 `X-Forwarded-*`（仅受控代理后开启） |

### `secureCookie` 与 `trustProxy`

| 场景 | 建议 |
| --- | --- |
| 本机 loopback HTTP | `secureCookie: auto`，`trustProxy: false` |
| Node 进程直接终结 TLS | `secureCookie: auto`（加密 socket 时自动加 `Secure`） |
| nginx / Caddy / Cloudflare 终结 HTTPS | `secureCookie: auto` 或 `always`，**`trustProxy: true`**，并保证**只有**代理能访问 DSH 端口 |

若在端口可被不可信客户端直连时开启 `trustProxy`，攻击者可伪造 `X-Forwarded-For` / `X-Forwarded-Proto`，削弱 IP 限流或 Cookie 安全语义。务必先锁死网络访问路径。

公网部署请在 DSH 前放置 HTTPS 反向代理。

---

## 登录失败限流

插件按客户端 IP 记录登录失败次数。默认配置下，同一 IP 在 300 秒内失败 5 次后，后续登录会收到 `429 Too Many Requests` 和 `Retry-After`，直到计数窗口过期。登录成功会清除该 IP 的失败记录。

阈值由以下配置控制：

```yaml
maxAttempts: 5
attemptWindowSeconds: 300
```

这项防护有明确边界：

- 计数保存在进程内存中，服务重启后会清空，多实例之间也不会共享。
- 限制对象是 IP，不是账号。攻击者轮换来源 IP 时，可以绕过单 IP 阈值。
- `trustProxy: false` 时使用 socket 地址；开启 `trustProxy` 后会信任 `X-Forwarded-For` 的第一个值，因此 DSH 端口必须只允许受控代理访问。

公网部署时，建议同时在反向代理或防火墙设置限流。这项功能不能替代 HTTPS、网络隔离和强口令。

---

## 鉴权 HTTP 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` / `HEAD` | `/auth/login` | 登录页；`?next=/path` 控制登录后回跳 |
| `POST` | `/auth/login` | 登录（`application/x-www-form-urlencoded` 或 `application/json`） |
| `POST` | `/auth/logout` | 清除会话 Cookie 并跳转登录页 |
| `GET` | `/auth/status` | 返回 `{ authenticated, required, username? }`，状态码 `200` 或 `401` |

### 登录 JSON 示例

```json
{
  "username": "admin",
  "password": "...",
  "next": "/"
}
```

### 行为说明

- 表单登录成功：`303` + `Set-Cookie`（`dsh_web_auth`）+ `Location` 为**净化后**的相对路径（拦截 `//evil`、绝对 URL、响应拆分字符）。
- 登录失败：带错误提示的登录页（`401`），或限流页（`429` + `Retry-After`）。
- 登录/登出在存在 `Origin` 头时校验其 host 是否与请求 `Host` 一致。
- 无有效会话的 WebSocket upgrade 会被关闭，并返回 `401` JSON。
- 鉴权相关 HTML 响应设置 `Cache-Control: no-store`、严格 CSP、`X-Frame-Options: DENY` 等安全头。

---

## 在 DSH 中的位置

```text
浏览器 / 客户端
       │
       ▼
┌──────────────────────┐
│  dsh-web-auth        │  ← 会话 Cookie / 登录路由
│  (Authenticated      │
│   WebServer service) │
└──────────┬───────────┘
           │ 仅已认证请求
           ▼
  GUI · 插件 bundle · /api · SSE · WS
  （通过 ctx.webServer.* 注册）
```

与官方 web 服务兼容的接口：

- `register({ kind, path, handler })`
- `registerUpgrade({ path, handler })`
- `registerFallback(handler)`
- `tapIndex(transform)`
- `host` / `port` 访问器

---

## 命令行工具

包内二进制：`dsh-web-auth`

```text
dsh-web-auth generate
  输出 WEB_AUTH_PASSWORD=... 与 WEB_AUTH_PASSWORD_HASH=...

dsh-web-auth hash-password
  从 WEB_AUTH_PASSWORD 或 stdin 读取口令，只打印 scrypt 散列
```

### 口令散列算法

CLI 使用 Node.js 内置的 `crypto.scryptSync`，对应 RFC 7914 定义的 scrypt 口令派生函数。scrypt 属于内存困难算法，相比普通快速散列，批量猜测口令需要付出更多 CPU 和内存成本。

每次生成散列时，插件会：

1. 通过 `crypto.randomBytes` 生成新的 16 字节随机盐。
2. 使用 `N=16384`、`r=8`、`p=1` 派生 64 字节密钥。
3. 将算法名、参数、盐和派生密钥保存为一个字符串；盐与密钥使用无填充的 Base64URL 编码。
4. 登录校验时读取已保存的参数，重新派生密钥，再通过 `crypto.timingSafeEqual` 做恒定时间比较。

插件不会保存原始口令。散列结果也不是可解密的密文。传给散列 CLI 的口令至少需要 **12** 个字符。

存储格式：

```text
scrypt$N$r$p$<salt-base64url>$<key-base64url>
```

默认参数中，`N=16384` 控制 CPU/内存成本，`r=8` 是块大小，`p=1` 是并行度；派生密钥为 64 字节，盐为 16 字节。Node.js scrypt 调用的内存上限至少设置为 64 MiB。

---

## 验证

```powershell
npm run check          # 语法检查 + 单元测试
npm pack --dry-run     # 检查发布文件集合
dsh --profile web --dump-config
```

在 dump 中确认：

- 官方 `webserver` 行为 `disabled: true`
- 存在名称为 `@summersec/dsh-web-auth` 的 `webserver-auth` 行
- 启动日志不出现 `FAILED`

手动冒烟：

1. 无 Cookie 打开 GUI → 跳转 `/auth/login`。
2. 登录成功 → 进入应用，存在 Cookie `dsh_web_auth`。
3. 带 Cookie 访问 `GET /auth/status` → `authenticated: true`。
4. `POST /auth/logout` → 会话清除。
5. 连续登录失败超过阈值 → `429`，窗口过期后恢复。

---

## 发布到 npm

包名：`@summersec/dsh-web-auth`（public scope）。

发布仅通过仓库的 GitHub Actions 工作流完成。**不要将本地 `npm publish` 作为发布路径。**

首次发布前，请在仓库 Actions Secrets 中配置名为 `NPM_TOKEN` 的 secret。该 npm token 必须拥有发布 `@summersec` 包的权限，并且 npm 组织的 2FA 与 CI 发布策略必须允许 GitHub Actions 使用此 token。

通过以下任一工作流入口发布：

1. 创建 GitHub Release，并使用与 `package.json` 中 `X.Y.Z` 版本严格对应的 `vX.Y.Z` tag。
2. 手动运行 **Publish Node.js Package**（`workflow_dispatch`），并填写完全一致的包版本号。

工作流会验证版本、运行检查，然后发布到 npm 与 GitHub Packages。push 和 pull request 只运行验证 job，不能发布包。

如果 GitHub Packages 已发布成功但 npm 发布失败，请打开该工作流运行记录并选择 **Re-run failed jobs**。不要重新运行整个工作流，否则会再次尝试发布相同版本的 GitHub Packages。

---

## 限制

- **内存会话**：进程重启后全部失效；多实例无共享会话存储。
- **单账号边界**：共享用户名/口令，不提供多用户 RBAC 或审计角色。
- **只保护 DSH Web 载体**：其他端口或旁路服务需自行防护。
- **不能替代 TLS**：非 loopback / 多用户网络务必前置 HTTPS。
- **`trustProxy` 配置错误风险高**：仅在监听端口只对可信反向代理开放时启用。

---

## 安全建议

- 优先使用 scrypt 散列，避免长期依赖明文环境变量。
- 默认 `always` 可避免“以为 loopback 就够安全”的误判（尤其是共享机器）。
- Cookie 标志与 Origin 校验能降低常见会话窃取与 CSRF 面，但不能替代网络隔离与 HTTPS。
- 若发现安全问题，请私下报告，勿在公开 issue 中贴完整利用细节。

---

## 目录结构

```text
dsh-web-auth/
├── bin/dsh-web-auth.js   # generate / hash-password CLI
├── cordis.patch.yml      # DSH bundle：禁用官方 webserver，插入 webserver-auth
├── src/
│   ├── auth.js           # scrypt、会话、限流、Cookie 工具
│   └── index.js          # AuthenticatedWebServer 服务与登录页
├── test/                 # node:test 单元测试
├── package.json
├── README.md
└── README.zh-CN.md
```

---

## 友情链接

- 仓库：[github.com/SummerSec/dsh-web-auth](https://github.com/SummerSec/dsh-web-auth)
- npm：[@summersec/dsh-web-auth](https://www.npmjs.com/package/@summersec/dsh-web-auth)
- Topic：[dsh-plugin](https://github.com/topics/dsh-plugin)
- [LINUX DO](https://linux.do/)

---

## 许可证

[MIT](./LICENSE)

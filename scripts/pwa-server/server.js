#!/usr/bin/env node
/*
 * Minimal host for the published Chatbox PWA: serves the static build, accepts client error
 * reports on /api/telemetry, and exposes a token-guarded view of what came in.
 *
 * Deliberately dependency-free (Node core only): the deploy sandbox provides a single port and
 * no database, so reports are appended to a JSONL file next to this script.
 */
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const ROOT = __dirname
const PORT = Number(process.env.PORT || 3000)
const MAX_BODY_BYTES = 64 * 1024
const MAX_LOG_BYTES = 8 * 1024 * 1024
const KEEP_LATEST = 500

/**
 * The deploy sandbox usually lets us write next to the app, but treat that as a preference rather
 * than an assumption: fall back to the system temp dir so a read-only mount degrades to
 * "reports are volatile" instead of "reports are lost".
 */
let DATA_DIR = path.join(ROOT, 'telemetry')

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, '.probe')
    fs.writeFileSync(probe, '1')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

function resolveDataDir() {
  if (canWrite(DATA_DIR)) return
  const fallback = path.join(os.tmpdir(), 'chatbox-telemetry')
  if (canWrite(fallback)) {
    console.warn(`[pwa-server] ${DATA_DIR} is not writable, falling back to ${fallback}`)
    DATA_DIR = fallback
  } else {
    console.error('[pwa-server] no writable directory for telemetry; reports will be dropped')
  }
}

let LOG_FILE = ''
let TOKEN_FILE = ''

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  LOG_FILE = path.join(DATA_DIR, 'errors.jsonl')
  TOKEN_FILE = path.join(DATA_DIR, 'admin-token.txt')
  if (!fs.existsSync(TOKEN_FILE)) {
    const token = process.env.ADMIN_TOKEN || crypto.randomBytes(18).toString('base64url')
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 })
    console.log(`[pwa-server] admin token stored in ${TOKEN_FILE}`)
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  LOG_FILE = path.join(DATA_DIR, 'errors.jsonl')
  TOKEN_FILE = path.join(DATA_DIR, 'admin-token.txt')
  if (!fs.existsSync(TOKEN_FILE)) {
    const token = process.env.ADMIN_TOKEN || crypto.randomBytes(18).toString('base64url')
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 })
    console.log(`[pwa-server] admin token stored in ${TOKEN_FILE}`)
  }
}

function adminToken() {
  ensureDataDir()
  return fs.readFileSync(TOKEN_FILE, 'utf8').trim()
}

function rotateIfNeeded() {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`)
    }
  } catch {
    // rotation is best-effort
  }
}

function readRecent(limit = KEEP_LATEST) {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean)
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return { raw: line }
        }
      })
      .reverse()
  } catch {
    return []
  }
}

function sanitizeString(value, max) {
  if (typeof value !== 'string') return undefined
  return value.length > max ? value.slice(0, max) : value
}

function buildRecord(body, req) {
  const allowed = [
    'window_error',
    'unhandled_rejection',
    'attachment_preprocess_error',
    'rag_index_error',
    'rag_query_error',
    'rag_query_result',
    'rag_vector_error',
  ]
  const kind = allowed.includes(body.kind) ? body.kind : 'other'
  let context
  if (body.context && typeof body.context === 'object') {
    try {
      context = JSON.parse(JSON.stringify(body.context).slice(0, 2000))
    } catch {
      context = undefined
    }
  }
  return {
    at: new Date().toISOString(),
    kind,
    message: sanitizeString(body.message, 500),
    stack: sanitizeString(body.stack, 4000),
    route: sanitizeString(body.route, 300),
    version: sanitizeString(body.version, 40),
    ua: sanitizeString(body.ua, 300),
    ip: req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim(),
    context,
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

/** Escape untrusted text for HTML (error messages routinely contain angle brackets). */
function esc(value, indent) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, indent)
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function renderAdmin(rows, token) {
  const counts = rows.reduce((acc, row) => {
    acc[row.kind] = (acc[row.kind] || 0) + 1
    return acc
  }, {})
  const items = rows
    .map((row) => {
      const ctx = row.context ? `<pre>${esc(row.context, 2)}</pre>` : ''
      const stack = row.stack ? `<details><summary>stack</summary><pre>${esc(row.stack)}</pre></details>` : ''
      const hits = row.context && typeof row.context.hits === 'number' ? row.context.hits : null
      // A retrieval call that returned nothing is the actual symptom users report as "KB 没生效".
      const empty = row.kind === 'rag_query_result' && hits === 0
      const badge = row.kind === 'rag_query_result' ? `<span class="hits">${hits ?? '?'} 命中</span>` : ''
      return `<li class="${empty ? 'warn' : ''}"><b>${esc(row.kind)}</b>${badge} <span class="t">${esc(row.at)}</span><br>${esc(row.message)}
<div class="meta">route=${esc(row.route || '-')} · ua=${esc((row.ua || '').slice(0, 80))}${row.ip ? ` · ip=${esc(row.ip)}` : ''}</div>
${ctx}${stack}</li>`
    })
    .join('')

  return `<!doctype html><meta charset="utf-8"><title>Chatbox 错误上报</title>
<style>
body{font:14px/1.6 -apple-system,system-ui,"Segoe UI",sans-serif;margin:24px;color:#1b1b1b}
h1{font-size:18px;margin:0 0 12px}
.chips span{display:inline-block;background:#eef2ff;border-radius:999px;padding:2px 10px;margin:0 6px 6px 0}
ul{list-style:none;padding:0}
li{border:1px solid #e5e7eb;border-radius:10px;padding:12px;margin:0 0 10px}
li.warn{border-color:#fca5a5;background:#fef2f2}
.hits{background:#eef2ff;border-radius:999px;padding:0 8px;font-size:12px;margin-left:6px}
.t{color:#6b7280;font-size:12px}
.meta{color:#6b7280;font-size:12px;margin-top:4px}
pre{background:#f8fafc;padding:8px;border-radius:6px;overflow:auto;font-size:12px}
details{margin-top:6px}
.refresh{display:inline-block;margin-left:12px;font-size:12px}
</style>
<h1>Chatbox 客户端错误 · 最近 ${rows.length} 条</h1>
<div class="chips">${Object.entries(counts)
    .map(([k, v]) => `<span>${k}: ${v}</span>`)
    .join('')}</div>
<p><a class="refresh" href="/admin/errors?token=${encodeURIComponent(token)}">刷新</a>
 · <a class="refresh" href="/admin/errors.json?token=${encodeURIComponent(token)}">JSON</a></p>
<ul>${items || '<li>还没有上报。</li>'}</ul>`
}

function handleTelemetry(req, res) {
  let size = 0
  const chunks = []
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const record = buildRecord(body, req)
      ensureDataDir()
      rotateIfNeeded()
      fs.appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`)
      res.writeHead(204, { 'Cache-Control': 'no-store' })
      res.end()
    } catch {
      res.writeHead(400)
      res.end('bad request')
    }
  })
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0])

  // Never serve the token or the collected reports.
  if (urlPath.startsWith('/telemetry') || urlPath === '/admin-token.txt' || urlPath === '/server.js') {
    res.writeHead(404)
    res.end('not found')
    return
  }

  let filePath = path.join(ROOT, urlPath)
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403)
    res.end()
    return
  }

  let stat = null
  try {
    stat = fs.statSync(filePath)
  } catch {
    stat = null
  }
  if (!stat || stat.isDirectory()) {
    // History routing: unknown paths get the app shell, exactly like the service worker does.
    filePath = path.join(ROOT, 'index.html')
    try {
      stat = fs.statSync(filePath)
    } catch {
      res.writeHead(404)
      res.end('not found')
      return
    }
  }

  const ext = path.extname(filePath)
  const immutable = /\/js\/|\/assets\/|\/fonts\//.test(urlPath)
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'Service-Worker-Allowed': '/',
  })
  fs.createReadStream(filePath).pipe(res)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (url.pathname === '/api/telemetry' && req.method === 'POST') {
    handleTelemetry(req, res)
    return
  }

  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true })
    return
  }

  if (url.pathname === '/admin/errors' || url.pathname === '/admin/errors.json') {
    const token = url.searchParams.get('token') || ''
    const expected = adminToken()
    if (!token || token !== expected) {
      sendJson(res, 401, { error: 'unauthorized', hint: 'append ?token=<admin token>' })
      return
    }
    const rows = readRecent()
    if (url.pathname.endsWith('.json')) {
      sendJson(res, 200, rows)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(renderAdmin(rows, token))
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    res.end()
    return
  }

  serveStatic(req, res)
})

resolveDataDir()
ensureDataDir()
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[pwa-server] listening on ${PORT}, telemetry -> ${DATA_DIR}`)
})

#!/usr/bin/env node
// ponytail: stdlib-only bridge between a Claude Code pane and headless Chrome.
//   node bridge.mjs --board <session dir> [url]   show the session's board (or url first), rebuilt when the agent writes
//   node bridge.mjs <url>                         show any page
// Talks to Chrome over --remote-debugging-pipe (no open port), writes each screencast frame as a
// PNG file for the pane's Image, and takes input as JSON POSTs on a Unix socket.
// stdout, one JSON line each: {socket} once ready, {frame, n} per frame, {error}.
// Ceiling: Chrome encodes every frame as PNG; raw pixels over shared memory if that is too slow.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { assemble, isInput } from './board.mjs'

const SCALE = +process.env.AGENT_CANVAS_SCALE || 2 // device pixels per CSS pixel; the Image scales the frame to its box
const FPS = +process.env.AGENT_CANVAS_FPS || 60
const CELL = { w: 8, h: 18 } // CSS pixels per terminal cell
const CHROMES = [process.env.AGENT_CANVAS_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
const CHROME = CHROMES.find(p => p && fs.existsSync(p))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-canvas-'))
const say = o => process.stdout.write(JSON.stringify(o) + '\n')

const boardDir = process.argv[2] === '--board' ? process.argv[3] : null
const boardUrl = boardDir && `file://${path.join(boardDir, 'board.html')}`
let url = (boardDir ? process.argv[4] : process.argv[2]) || boardUrl || 'about:blank'
let columns = 100, rows = 40
if (!CHROME) { say({ error: 'no Chrome or Chromium found; set AGENT_CANVAS_CHROME' }); process.exit(1) }

const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${dir}/profile`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', `--force-device-scale-factor=${SCALE}`],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
const toChrome = chrome.stdio[3], fromChrome = chrome.stdio[4]
const waiting = new Map()
let id = 0, inbox = '', session = null

fromChrome.setEncoding('utf8')
fromChrome.on('data', d => {
  inbox += d
  for (let i; (i = inbox.indexOf('\0')) >= 0;) {
    const msg = JSON.parse(inbox.slice(0, i)); inbox = inbox.slice(i + 1)
    if (msg.id && waiting.has(msg.id)) {
      const { ok, fail } = waiting.get(msg.id); waiting.delete(msg.id)
      msg.error ? fail(new Error(msg.error.message)) : ok(msg.result)
    } else if (msg.method === 'Page.screencastFrame') frame(msg.params)
  }
})

function send(method, params = {}, sessionId) {
  return new Promise((ok, fail) => {
    const msg = { id: ++id, method, params }
    if (sessionId) msg.sessionId = sessionId
    waiting.set(msg.id, { ok, fail })
    toChrome.write(JSON.stringify(msg) + '\0')
  })
}
const page = (method, params) => send(method, params, session)

let n = 0, lastAck = 0
function frame({ data, sessionId }) {
  // Chrome sends the next frame only after the ack, so a late ack caps its frame rate at FPS.
  const ack = () => { lastAck = Date.now(); page('Page.screencastFrameAck', { sessionId }).catch(() => {}) }
  setTimeout(ack, Math.max(0, 1000 / FPS - (Date.now() - lastAck)))
  // Four names in turn, each written whole then renamed, so the terminal never reads half a file.
  const file = path.join(dir, `frame-${++n % 4}.png`)
  fs.writeFileSync(file + '.tmp', Buffer.from(data, 'base64'))
  fs.renameSync(file + '.tmp', file)
  say({ frame: file, n })
}

async function resize(c, r) {
  columns = c; rows = r
  const width = c * CELL.w, height = r * CELL.h
  await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: SCALE, mobile: false })
  await page('Page.stopScreencast').catch(() => {})
  await page('Page.startScreencast', { format: 'png', maxWidth: width * SCALE, maxHeight: height * SCALE })
}

const KEYS = { return: ['Enter', 13, '\r'], backspace: ['Backspace', 8], tab: ['Tab', 9], delete: ['Delete', 46],
  up: ['ArrowUp', 38], down: ['ArrowDown', 40], left: ['ArrowLeft', 37], right: ['ArrowRight', 39],
  pageup: ['PageUp', 33], pagedown: ['PageDown', 34], home: ['Home', 36], end: ['End', 35] }

async function key({ key: k, ctrl, shift, meta }) {
  if (!KEYS[k] && k.length === 1 && !ctrl && !meta) return page('Input.insertText', { text: k })
  const [key, code, text] = KEYS[k] || [k, k.toUpperCase().charCodeAt(0)]
  const modifiers = (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0)
  await page('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: code, modifiers, text })
  await page('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code, modifiers })
}

let held = 0
function input(m) {
  const x = (m.x ?? columns / 2) * CELL.w, y = (m.y ?? rows / 2) * CELL.h
  const button = m.button || 'left'
  switch (m.t) {
    case 'down': held = 1; return page('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: 1, clickCount: 1 })
    case 'up': held = 0; return page('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 })
    case 'move': return page('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: held ? 'left' : 'none', buttons: held })
    case 'wheel': return page('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: m.dy * CELL.h * 3 })
    case 'key': return key(m)
    case 'resize': return m.columns === columns && m.rows === rows ? null : resize(m.columns, m.rows)
    case 'navigate': url = m.url || boardUrl || url; return page('Page.navigate', { url })
  }
}

// Calls fn (debounced) when a file named by `matches` changes in `folder`.
function watch(folder, matches, fn) {
  let t
  fs.watch(folder, (_, name) => { if (name && matches(name)) { clearTimeout(t); t = setTimeout(fn, 120) } })
}

function quit() {
  try { chrome.kill() } catch {}
  fs.rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGTERM', quit)
process.on('SIGINT', quit)
process.stdout.on('error', quit)
chrome.on('exit', code => { say({ error: `Chrome exited (${code})` }); quit() })
setInterval(() => { if (process.ppid === 1) quit() }, 2000) // Claude Code died without killing us

if (boardDir) {
  fs.mkdirSync(path.join(boardDir, 'panels'), { recursive: true })
  assemble(boardDir)
}
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
session = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId
await page('Page.enable')
await resize(columns, rows)
await page('Page.navigate', { url })

if (boardDir) {
  // A write by the agent rebuilds the board and shows it, also when an earlier turn was open.
  const rebuild = () => { assemble(boardDir); if (url === boardUrl) page('Page.navigate', { url }).catch(() => {}) }
  watch(boardDir, isInput, rebuild)
  watch(path.join(boardDir, 'panels'), name => name.endsWith('.html'), rebuild)
}
if (url !== boardUrl && url.startsWith('file://')) { // any other local page reloads when its file is rewritten
  const file = decodeURIComponent(new URL(url).pathname)
  watch(path.dirname(file), name => name === path.basename(file), () => page('Page.reload').catch(() => {}))
}

const sock = path.join(dir, 'bridge.sock')
http.createServer((req, res) => {
  let body = ''
  req.on('data', d => { body += d })
  req.on('end', async () => {
    try { await input(JSON.parse(body || '{}')); res.end('ok') } catch (e) { res.statusCode = 500; res.end(String(e)) }
  })
}).listen(sock, () => say({ socket: sock }))

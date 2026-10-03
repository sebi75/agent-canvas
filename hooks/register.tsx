import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// A live board for the session in a Claude Code pane. bridge/bridge.mjs runs headless Chrome on
// the board page (or any URL) and writes frames as PNG files; an Image shows them, swapped in with
// $.ui.blit; a Client laid over it (input.tsx) catches clicks, keys and the pane size. While the
// board is on, the rules in RULES.md join the system prompt, and the Stop event is blocked until
// the agent has written this turn's turn.html.
const PANE = 'agent-canvas'
const NO_IMAGES = 'This terminal draws no images for Claude Code. Use Ghostty, kitty or WezTerm.'
const NO_IMAGES_HERDR = 'Images are off: this claude started without CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1. Set it in your shell for Herdr, then start claude again.'
const isOnRef = atom({ plugin: 'agent-canvas', key: 'isOn' } as const, false)

let dir = '' // this session's board files
let rules = ''
let home = ''
let maxFps = 60
let scale = '2'
let noImages = NO_IMAGES
let url = '' // what the pane shows: '' is the board

let bridge: AsyncGenerator<unknown, unknown> | null = null
let socket: string | null = null
let frame: { file: string; n: number } | null = null // the newest frame the bridge wrote
let shownN = 0
let isBlitting = false
let note = 'starting Chrome'
let stats = { frames: 0, ms: 0, since: Date.now(), text: '' }
let seen = { instance: '', seq: 0 }
let size: { t: 'resize'; columns: number; rows: number } | null = null // the pane's last size, sent again once Chrome is up
let chain: Promise<unknown> = Promise.resolve()

let turnStart = 0 // when the current prompt arrived
let lastWork = 0 // when the last tool call that was not a board write finished
let isLoopTick = false // a /loop firing: a quiet tick may leave the board alone

const toUrl = (s: string) => (/^[a-z]+:\/\//.test(s) ? s : `file://${s.replace(/^~/, home)}`)

// Input goes to the bridge in order, one request at a time.
function send($: EngineInterface, ev: object) {
  const at = socket
  if (!at) return chain
  chain = chain.then(() =>
    $.http.fetch('http://bridge/', { method: 'POST', body: JSON.stringify(ev), socketPath: at }).catch(() => undefined))
  return chain
}

// One blit at a time, always of the newest frame: frames that arrive meanwhile are skipped, so a
// slow terminal shows fewer frames instead of falling further behind.
async function show($: EngineInterface) {
  if (isBlitting) return
  isBlitting = true
  while (frame && frame.n !== shownN) {
    const { file, n } = frame
    const t = Date.now()
    const r = await $.ui.blit({ requestId: PANE, key: 'view', source: { file, format: 'png', generation: n } })
    if (r.deny) {
      if (r.deny.includes('alt')) note = noImages
      $.ui.invalidate('ui.render') // not mounted yet, resized, or no images: draw the tree again
      break
    }
    shownN = n
    stats.frames++
    stats.ms += Date.now() - t
    if (Date.now() - stats.since >= 1000) { // the footer's frame rate, redrawn once a second
      stats = { frames: 0, ms: 0, since: Date.now(), text: `${stats.frames} fps` }
      $.ui.invalidate('ui.render')
    }
    if (maxFps < 60) await $.clock.sleep(Math.max(0, 1000 / maxFps - (Date.now() - t)))
  }
  isBlitting = false
}

function start($: EngineInterface) {
  if (bridge) return
  const argv = ['node', `${$.plugin.root}/bridge/bridge.mjs`, '--board', dir, ...(url ? [url] : [])]
  const child = $.process.spawn({ argv, env: { AGENT_CANVAS_SCALE: scale, AGENT_CANVAS_FPS: String(maxFps) } })
  bridge = child
  void (async () => {
    let buf = ''
    try {
      for await (const chunk of child) {
        if (chunk.stream === 'stderr') { note = chunk.text.trim().slice(0, 160); continue }
        buf += chunk.text
        for (let i; (i = buf.indexOf('\n')) >= 0;) {
          const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
          if (m.socket) { socket = m.socket; note = ''; if (size) void send($, size); $.ui.invalidate('ui.render') }
          if (m.frame) frame = { file: m.frame, n: m.n }
          if (m.error) note = m.error
        }
        void show($) // not awaited: the loop keeps reading, show() picks up the newest frame
      }
    } catch (err) {
      note = `bridge failed: ${String(err).slice(0, 160)}`
    }
    bridge = null
    socket = null
    frame = null
    $.ui.invalidate('ui.render')
  })()
}

function stop() {
  void bridge?.return(undefined) // leaving the stream ends the child, and the bridge closes Chrome
  bridge = null
}

async function turnOn($: EngineInterface) {
  await update($, isOnRef, () => true)
  await $.ui.open({ id: PANE, title: 'Canvas' })
  start($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'agent-canvas', description: 'Live board for this session (off: close it; a URL or path: show that page)' })
    const started = await next(e)
    home = (await $.env.get('HOME')) ?? ''
    dir = `${home}/.claude/agent-canvas/sessions/${await $.session.id()}`
    rules = (await $.fs.read(`${$.plugin.root}/RULES.md`)).replaceAll('{{DIR}}', dir)
    maxFps = Number(await $.env.get('AGENT_CANVAS_FPS')) || 60
    scale = (await $.env.get('AGENT_CANVAS_SCALE')) || '2'
    if (await $.env.get('HERDR_ENV')) noImages = NO_IMAGES_HERDR
    if ((await $.env.get('AGENT_CANVAS_OPEN')) === '1' || (await read($, isOnRef))) await turnOn($)
    return started
  })

  on('command.run', { command: 'agent-canvas' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off') {
      await update($, isOnRef, () => false)
      stop()
      await $.ui.close({ id: PANE })
      return { text: 'Canvas off.' }
    }
    url = arg && arg !== 'board' ? toUrl(arg) : ''
    await send($, { t: 'navigate', url }) // a running bridge switches page; '' is the board
    await turnOn($)
    return { text: url ? `Canvas shows ${url}` : `Canvas on: ${dir}` }
  })

  // The rules ride in the system prompt while the board is on, so a compaction cannot lose them.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, isOnRef))) return composed
    return { sections: [...composed.sections, { id: 'agent-canvas:rules', text: rules, scope: 'session' as const }] }
  })

  on('prompt.submit', async ($, e, next) => {
    turnStart = Date.now()
    lastWork = 0
    isLoopTick = /^\s*\/loop\b|<<autonomous-loop/.test(e.text)
    if (await read($, isOnRef)) await $.fs.write(`${dir}/turn`, String(turnStart)) // the board marks panels written after this
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (!JSON.stringify(e).includes(dir)) lastWork = Date.now() // board writes are not work the board must describe
    return result
  })

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (!(await read($, isOnRef)) || e.stop_hook_active || isLoopTick || !turnStart) return result
    const file = `${dir}/turn.html`
    const written = (await $.fs.exists(file)) ? (await $.fs.stat(file)).mtimeMs : 0
    if (written < turnStart) {
      return { ...result, block: `The canvas is on but ${file} was not written this turn. Write this reply's turn.html, update the panels that changed and append to log.txt, as the canvas rules say, then finish.` }
    }
    if (written < lastWork) {
      return { ...result, block: `${file} was written before the rest of this turn's work, so it describes the plan instead of the result. Rewrite it to say what is true now, then finish.` }
    }
    return result
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const data = e.data as { instance: string; events: { seq: number; t: string }[] }
    if (data.instance !== seen.instance) seen = { instance: data.instance, seq: 0 }
    for (const ev of data.events) {
      if (ev.seq <= seen.seq) continue
      seen.seq = ev.seq
      if (ev.t === 'resize') size = ev as unknown as typeof size
      void send($, ev)
    }
    await chain
    return {}
  })

  on('ui.scroll', async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    await send($, { t: 'wheel', dy: e.by })
    return { deny: 'the page scrolls itself' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    if (e.surface !== 'terminal' || !('Image' in ui)) {
      const { Text } = ui
      return <Text>The canvas needs a terminal that draws images (Ghostty, kitty, WezTerm).</Text>
    }
    const { Box, Text, Image, Client } = ui
    const columns = Math.max(20, e.props.bodyColumns)
    const rows = Math.max(5, e.props.scroll.bodyRows - 1)
    const where = url ? url.replace(/^file:\/\//, '') : 'board'
    return (
      <Box flexDirection="column">
        <Box width={columns} height={rows}>
          {frame
            ? <Image key="view" source={{ file: frame.file, format: 'png', generation: frame.n }} columns={columns} rows={rows} alt={noImages} />
            : <Text dimColor>{note || 'starting Chrome'}</Text>}
          <Box position="absolute" top={0} left={0}>
            <Client key="input" module="./input.tsx" props={{ columns, rows }} width={columns} height={rows} />
          </Box>
        </Box>
        <Text dimColor wrap="truncate-end">{[where, note, stats.text, 'click to use the page, Esc gives the keys back'].filter(Boolean).join(' · ')}</Text>
      </Box>
    )
  })
}

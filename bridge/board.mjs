// Builds a session's board page from the files the agent writes:
//   turn.html          this reply's news, replaced every reply
//   panels/<name>.html what outlives a turn, edited only when it changes
//   log.txt            one line per turn, newest ten shown
//   title              the session topic
//   turn               when the current prompt arrived (ms), written by the mod
// into board.html, plus one snapshot per turn under history/ and an index of them.
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const TEMPLATE = path.join(HERE, 'template.html')
const MERMAID = path.join(HERE, 'vendor', 'mermaid.min.js')

const read = (file, fallback = '') => { try { return fs.readFileSync(file, 'utf8') } catch { return fallback } }
const mtime = file => { try { return fs.statSync(file).mtimeMs } catch { return null } }
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const pad = n => String(n).padStart(2, '0')
const clock = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const stampOf = ms => { const d = new Date(ms); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` }

export const turnStart = dir => Number(read(path.join(dir, 'turn'), '0')) || 0

// The files whose change means the agent wrote something worth showing.
export const isInput = name => ['turn.html', 'log.txt', 'title'].includes(name)

export function panels(dir) {
  const pdir = path.join(dir, 'panels')
  let names = []
  try { names = fs.readdirSync(pdir).filter(n => n.endsWith('.html')) } catch {}
  return names.map(name => ({ name, file: path.join(pdir, name), t: mtime(path.join(pdir, name)) })).filter(p => p.t !== null)
}

// Panels written this turn first, marked updated; the rest after, with the time they last changed.
export function board(dir) {
  const start = turnStart(dir)
  return panels(dir)
    .sort((a, b) => (a.t < start) - (b.t < start) || a.name.localeCompare(b.name))
    .map(p => {
      const label = esc(p.name.slice(0, -5).replace(/^\d+-/, '').replace(/-/g, ' '))
      const isNew = p.t >= start
      const mark = isNew ? '<span class="tag">updated</span>' : `<span class="since">since ${clock(p.t)}</span>`
      return `<section class="panel${isNew ? ' new' : ''}"><h2>${label}${mark}</h2>\n${read(p.file)}\n</section>`
    })
    .join('\n')
}

function page(dir, nav) {
  const title = read(path.join(dir, 'title'), 'Agent canvas').trim()
  const turn = read(path.join(dir, 'turn.html'), '<div class="status">Canvas on. Waiting for the first reply.</div>')
  const panes = board(dir)
  const log = read(path.join(dir, 'log.txt')).split('\n').filter(l => l.trim()).slice(-10).reverse()
    .map(l => { const [t, ...rest] = l.split(' '); return `<li><time>${esc(t)}</time>${esc(rest.join(' '))}</li>` })
    .join('\n')
  // Function replacements: the agent's HTML may contain "$&" or "$1", which a string replacement would expand.
  let html = read(TEMPLATE)
    .replaceAll('{{TITLE}}', () => esc(title)).replace('{{NAV}}', () => nav)
    .replace('{{TURN}}', () => turn).replace('{{BOARD}}', () => panes).replace('{{LOG}}', () => log)
  if (/class="mermaid"/.test(turn + panes)) { // loaded only when the page draws a diagram
    html += `<script src="file://${MERMAID}"></script><script>mermaid.initialize({startOnLoad:true,theme:"dark"})</script>`
  }
  return html
}

export function assemble(dir) {
  const hist = path.join(dir, 'history')
  fs.mkdirSync(hist, { recursive: true })
  const out = path.join(dir, 'board.html')
  fs.writeFileSync(out, page(dir, '<a href="history/index.html">earlier turns</a>'))
  // One snapshot per turn, overwritten until the next prompt, so each keeps that turn's final board.
  // Before the first prompt there is no turn yet, so nothing to keep.
  if (turnStart(dir)) {
    const snap = `turn-${stampOf(turnStart(dir))}.html`
    fs.writeFileSync(path.join(hist, snap), page(dir, '<a href="index.html">all turns</a> · <a href="../board.html">live</a>'))
  }
  const turns = fs.readdirSync(hist).filter(n => /^turn-\d{8}-\d{6}\.html$/.test(n)).sort().reverse()
  const items = turns.map(n => `<li><a href="${n}">${n.slice(5, 9)}-${n.slice(9, 11)}-${n.slice(11, 13)} ${n.slice(14, 16)}:${n.slice(16, 18)}</a></li>`).join('\n')
  fs.writeFileSync(path.join(hist, 'index.html'), read(TEMPLATE)
    .replaceAll('{{TITLE}}', 'Earlier turns').replace('{{NAV}}', '<a href="../board.html">live</a>')
    .replace('{{TURN}}', `<section><h2>Earlier turns</h2><ul class="turns">${items}</ul></section>`)
    .replace('{{BOARD}}', '').replace('{{LOG}}', ''))
  return out
}

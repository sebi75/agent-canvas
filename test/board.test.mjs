// Self-check for the board builder: node test/board.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assemble, board } from '../bridge/board.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-canvas-test-'))
fs.mkdirSync(path.join(dir, 'panels'))
const write = (name, text) => fs.writeFileSync(path.join(dir, name), text)
write('panels/10-state.html', '<p>old</p>')
write('panels/open-questions.html', '<p>new</p>')
const old = new Date(Date.now() - 600_000)
fs.utimesSync(path.join(dir, 'panels/10-state.html'), old, old)
write('turn', String(Date.now() - 60_000))
write('turn.html', '<div class="status">costs $& and $1</div>')

const b = board(dir)
assert.ok(b.indexOf('open questions') < b.indexOf('>state<'), 'a panel written this turn comes first')
assert.equal(b.match(/class="panel new"/g).length, 1, 'only that panel is marked updated')
assert.ok(b.includes('since ') && !b.includes('10-'), 'the old panel shows when it changed; the number prefix is hidden')

const html = fs.readFileSync(assemble(dir), 'utf8')
assert.ok(html.includes('costs $& and $1'), 'the agent HTML is inserted as written')
assemble(dir)
const turns = fs.readdirSync(path.join(dir, 'history')).filter(n => n.startsWith('turn-'))
assert.equal(turns.length, 1, 'the same turn overwrites its snapshot')
assert.ok(fs.readFileSync(path.join(dir, 'history/index.html'), 'utf8').includes(turns[0]), 'the index links the snapshot')
console.log('ok')

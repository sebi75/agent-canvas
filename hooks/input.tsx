import type { ClientModule } from 'claude-code'

type Props = { columns: number; rows: number }
type State = { columns: number; rows: number }
type Ev = { t: string; seq: number; [k: string]: unknown }

// Laid over the browser frame. Sends the pointer, keys and its own size to the hooks module.
// A post replaces one not yet delivered in the same frame, so each post carries the last
// 20 events with a sequence number; the hooks module skips the ones it has seen.
const instance = Math.random().toString(36).slice(2)
let seq = 0
let pending: Ev[] = []

function emit(post: (d: never) => void, ev: Omit<Ev, 'seq'>) {
  const next = { ...ev, seq: ++seq } as Ev
  const last = pending[pending.length - 1]
  if (next.t === 'move' && last?.t === 'move') pending[pending.length - 1] = next // keep only the newest hover
  else pending.push(next)
  pending = pending.slice(-20)
  post({ instance, events: pending } as never)
}

const Input: ClientModule<Props, State> = (props, surface) => {
  const post = surface.post as (d: never) => void
  if (surface.state === undefined) {
    surface.onPointer(ev => {
      if (ev.type === 'enter' || ev.type === 'leave') return
      emit(post, { t: ev.type, x: ev.fine?.x ?? ev.x + 0.5, y: ev.fine?.y ?? ev.y + 0.5, button: ev.button ?? null })
    })
    surface.onKey(k => emit(post, { t: 'key', key: k.key, ctrl: !!k.ctrl, shift: !!k.shift, meta: !!k.meta }))
  }
  const s = surface.state
  if (surface.columns > 0 && (s === undefined || s.columns !== surface.columns || s.rows !== surface.rows)) {
    emit(post, { t: 'resize', columns: surface.columns, rows: surface.rows })
    surface.setState({ columns: surface.columns, rows: surface.rows })
  } else if (s === undefined) {
    surface.setState({ columns: 0, rows: 0 })
  }
  const { Box } = surface.elements
  return <Box width={props.columns} height={props.rows} />
}

export default Input

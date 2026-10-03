/** Whether the board is on for this session: kept across a plugin reload. */
export type IsOn = boolean

declare module 'claude-code' {
  interface PluginState {
    'agent-canvas': { isOn: IsOn }
  }
}

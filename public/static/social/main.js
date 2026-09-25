import { initDiscordUI, loadDiscordStyles } from './discord-ui.js'

// Load final row geometry before the existing chat renderer restores scroll positions.
// A failed stylesheet request must not prevent authentication or calls from starting.
await loadDiscordStyles()
const { navigate, parseRoute, openDmWith } = await import('./shell.js')
export { navigate, parseRoute, openDmWith }
initDiscordUI({ navigate, openDmWith })

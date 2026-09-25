import { initDiscordUI, loadDiscordStyles } from './discord-ui.js'

// app.js otherwise starts the classic UI after four seconds. Claim shell startup
// while CSS loads, so slow networks cannot start two independent session UIs.
if (window.VL) window.VL.shellReady = true
await loadDiscordStyles()
const { navigate, parseRoute, openDmWith } = await import('./shell.js').catch(error => {
  // Preserve the existing classic lobby fallback if the shell module cannot load.
  // Keep the startup flag claimed so app.js's original timer cannot mount it twice.
  document.documentElement.removeAttribute('data-vl-shell')
  const code = location.pathname.match(/^\/room\/([a-z0-9]+)/i)?.[1] || ''
  window.VL?.renderLobby(code)
  throw error
})
export { navigate, parseRoute, openDmWith }
initDiscordUI({ navigate, openDmWith })

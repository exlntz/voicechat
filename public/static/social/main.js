import { navigate, openDmWith } from './shell.js'
import { initDiscordUI } from './discord-ui.js'
export { navigate, parseRoute, openDmWith } from './shell.js'
initDiscordUI({ navigate, openDmWith })

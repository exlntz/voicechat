import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const staticRoot = path.join(repoRoot, 'public', 'static')
const socialRoot = path.join(staticRoot, 'social')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function walkFiles(rootDir) {
  const results = []
  const stack = [rootDir]

  while (stack.length) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(fullPath)
      else results.push(fullPath)
    }
  }

  return results
}

function toProjectPath(fullPath) {
  return path.relative(repoRoot, fullPath).split(path.sep).join('/')
}

test('social redesign entry keeps the shell bridge as relative ESM imports and re-exports', () => {
  const main = read('public/static/social/main.js')

  assert.match(main, /import\s*\{\s*navigate\s*,\s*openDmWith\s*\}\s*from\s*['"]\.\/shell\.js['"]/) 
  assert.match(main, /import\s*\{\s*initDiscordUI\s*\}\s*from\s*['"]\.\/discord-ui\.js['"]/) 
  assert.match(main, /export\s*\{\s*navigate\s*,\s*parseRoute\s*,\s*openDmWith\s*\}\s*from\s*['"]\.\/shell\.js['"]/) 
})

test('discord-ui keeps the quick switcher and UI helper contracts', () => {
  const discordUi = read('public/static/social/discord-ui.js')

  assert.match(discordUi, /from\s*['"]\.\/ui\.js['"]/) 
  assert.match(discordUi, /from\s*['"]\.\/quick-switcher\.js['"]/) 
  assert.match(discordUi, /link\[href="\\/static\\/discord\.css"\]/) 
  assert.match(discordUi, /href:\s*['"]\/static\/discord\.css['"]/) 
})

test('all relative imports and re-exports in public/static/social resolve to real files', () => {
  const jsFiles = walkFiles(socialRoot).filter((fullPath) => fullPath.endsWith('.js'))
  const specifierPattern = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g

  for (const filePath of jsFiles) {
    const source = fs.readFileSync(filePath, 'utf8')
    for (const match of source.matchAll(specifierPattern)) {
      const specifier = match[1]
      if (!specifier.startsWith('.')) continue
      const resolved = path.resolve(path.dirname(filePath), specifier)
      assert.ok(
        fs.existsSync(resolved),
        `${toProjectPath(filePath)} points to missing dependency ${specifier}`,
      )
    }
  }
})

test('required redesign static assets are present under public/static', () => {
  const files = new Set(walkFiles(staticRoot).map(toProjectPath))

  for (const required of [
    'public/static/discord-surfaces.css',
    'public/static/social/social.css',
    'public/static/social/main.js',
    'public/static/social/discord-ui.js',
    'public/static/social/quick-switcher.js',
    'public/static/social/shell.js',
    'public/static/social/ui.js',
  ]) {
    assert.ok(files.has(required), `${required} is required by the redesign contract`)
  }

  assert.ok(
    [...files].some((file) => /^public\/static\/discord[^/]*\.css$/.test(file)),
    'expected at least one Discord-themed stylesheet under public/static',
  )
})

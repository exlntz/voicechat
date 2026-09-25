import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const publicRoot = path.join(repoRoot, 'public')
const staticRoot = path.join(publicRoot, 'static')
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

function stripQueryAndHash(specifier) {
  return specifier.split('#', 1)[0].split('?', 1)[0]
}

function resolveAssetPath(fromFilePath, specifier) {
  const clean = stripQueryAndHash(specifier)
  if (!clean || clean.startsWith('data:') || clean.startsWith('http:') ||
    clean.startsWith('https:') || clean.startsWith('#')) {
    return null
  }

  if (clean.startsWith('/')) {
    return path.join(publicRoot, clean.replace(/^\//, ''))
  }

  return path.resolve(path.dirname(fromFilePath), clean)
}

function localCssReferences(source) {
  const references = new Set()
  const importPattern = /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]\s*\)?/g
  const urlPattern = /url\(\s*['"]?([^'"()]+)['"]?\s*\)/g

  for (const match of source.matchAll(importPattern)) references.add(match[1])
  for (const match of source.matchAll(urlPattern)) references.add(match[1])

  return [...references]
}

test('social redesign entry loads styles before the dynamic shell bridge', () => {
  const main = read('public/static/social/main.js')

  assert.match(main,
    /import\s*\{\s*initDiscordUI\s*,\s*loadDiscordStyles\s*\}\s*from\s*['"]\.\/discord-ui\.js['"]/)
  assert.match(main, /await\s+loadDiscordStyles\s*\(\s*\)/)
  assert.match(main,
    /const\s*\{\s*navigate\s*,\s*parseRoute\s*,\s*openDmWith\s*\}\s*=\s*await\s+import\(\s*['"]\.\/shell\.js['"]\s*\)/)
  assert.match(main, /export\s*\{\s*navigate\s*,\s*parseRoute\s*,\s*openDmWith\s*\}/)
  assert.match(main, /initDiscordUI\s*\(\s*\{\s*navigate\s*,\s*openDmWith\s*\}\s*\)/)
})

test('discord-ui keeps the quick switcher, UI helper, and discord.css contract', () => {
  const discordUi = read('public/static/social/discord-ui.js')

  assert.match(discordUi, /from\s*['"]\.\/ui\.js['"]/) 
  assert.match(discordUi, /from\s*['"]\.\/quick-switcher\.js['"]/) 
  assert.ok(discordUi.includes('/static/discord.css'))
  assert.match(discordUi, /loadDiscordStyles/)
})

test('all static, dynamic, and re-exported social module dependencies resolve to real files', () => {
  const jsFiles = walkFiles(socialRoot).filter((fullPath) =>
    fullPath.endsWith('.js'))
  const specifierPattern =
    /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

  for (const filePath of jsFiles) {
    const source = fs.readFileSync(filePath, 'utf8')
    for (const match of source.matchAll(specifierPattern)) {
      const specifier = match[1] || match[2]
      if (!specifier || !specifier.startsWith('.')) continue
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
    'public/static/discord.css',
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
})

test('local CSS imports and asset references under public/static resolve to real files', () => {
  const cssFiles = walkFiles(staticRoot).filter((fullPath) =>
    fullPath.endsWith('.css'))

  for (const filePath of cssFiles) {
    const source = fs.readFileSync(filePath, 'utf8')
    for (const reference of localCssReferences(source)) {
      const resolved = resolveAssetPath(filePath, reference)
      if (!resolved) continue
      assert.ok(
        fs.existsSync(resolved),
        `${toProjectPath(filePath)} points to missing CSS asset ${reference}`,
      )
    }
  }
})

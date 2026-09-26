import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeQuery,
  filterDestinations,
  moveSelection,
} from '../public/static/social/quick-switcher.js'

function titles(items) {
  return items.map((item) => item.title)
}

test('normalizeQuery normalizes Unicode, Russian case, and whitespace', () => {
  assert.equal(normalizeQuery('  Е\u0308лКА  '), 'ёлка')
  assert.equal(normalizeQuery('\nПрИвЕт\t'), 'привет')
  assert.equal(normalizeQuery(null), '')
})

test('filterDestinations requires every query term to match', () => {
  const items = [
    { title: 'Анна', subtitle: 'Команда дизайна', keywords: 'voice friend' },
    { title: 'Дизайн', subtitle: 'Елена', keywords: 'team only' },
    { title: 'Антон', subtitle: 'Команда продукта', keywords: 'friends only' },
  ]

  assert.deepEqual(filterDestinations(items, 'анна дизайн'), [items[0]])
})

test('filterDestinations ranks exact title match before prefix and substring matches', () => {
  const items = [
    { title: 'Core Team', subtitle: 'Ops room' },
    { title: 'team', subtitle: 'Exact match' },
    { title: 'team sync', subtitle: 'Prefix match' },
    { title: 'A Team Space', subtitle: 'Another substring match' },
  ]

  assert.deepEqual(titles(filterDestinations(items, 'team')), [
    'team',
    'team sync',
    'Core Team',
    'A Team Space',
  ])
})

test('filterDestinations keeps default ordering for empty query and enforces limits', () => {
  const items = Array.from({ length: 35 }, (_, index) => ({
    title: `Chat ${index + 1}`,
  }))

  assert.deepEqual(filterDestinations(items, ''), items.slice(0, 30))
  assert.deepEqual(filterDestinations(items, '', 2), items.slice(0, 2))
  assert.deepEqual(filterDestinations(items, '', 0), [])
})

test('filterDestinations returns an empty list when nothing matches', () => {
  const items = [
    { title: 'Alpha' },
    { title: 'Beta' },
  ]

  assert.deepEqual(filterDestinations(items, 'гамма'), [])
})

test('moveSelection handles empty lists, initial selection, and wrap-around movement', () => {
  assert.equal(moveSelection(-1, 1, 0), -1)
  assert.equal(moveSelection(-1, 1, 3), 0)
  assert.equal(moveSelection(-1, -1, 3), 2)
  assert.equal(moveSelection(2, 1, 3), 0)
  assert.equal(moveSelection(0, -1, 3), 2)
})

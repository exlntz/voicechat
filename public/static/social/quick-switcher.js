// Pure search model. No network, DOM, or persistent copy of private chat data.
export function normalizeQuery(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ru-RU').trim()
}

export function filterDestinations(items, query, limit = 30) {
  const terms = normalizeQuery(query).split(/\s+/).filter(Boolean)
  return items.map((item, index) => {
    const title = normalizeQuery(item.title)
    const haystack = normalizeQuery([item.title, item.subtitle, item.keywords].filter(Boolean).join(' '))
    if (!terms.every(term => haystack.includes(term))) return null
    const phrase = terms.join(' ')
    const score = !phrase ? 0 : title === phrase ? 3 : title.startsWith(phrase) ? 2 : 1
    return { item, score, index }
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, limit)).map(result => result.item)
}

export function moveSelection(current, delta, length) {
  if (!length) return -1
  if (current < 0) return delta < 0 ? length - 1 : 0
  return ((current + delta) % length + length) % length
}

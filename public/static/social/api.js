// ===================== HTTP-клиент API друзей и чатов =====================
// Сессия — httpOnly-cookie, поэтому достаточно credentials: 'same-origin'. Ошибки сервера
// приходят как {error, message}; message уже по-русски и годится для показа пользователю.

export class ApiError extends Error {
  constructor(status, data) {
    super((data && data.message) || 'Ошибка сети. Проверьте подключение.')
    this.status = status
    this.code = data && data.error
  }
}

let onUnauthorized = null
export function setUnauthorizedHandler(fn) { onUnauthorized = fn }

async function request(method, path, body) {
  let res
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
  } catch {
    throw new ApiError(0, null)
  }
  const data = await res.json().catch(() => null)
  if (res.status === 401 && onUnauthorized) onUnauthorized()
  if (!res.ok) throw new ApiError(res.status, data)
  return data
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  patch: (p, b = {}) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),

  friends: () => request('GET', '/api/friends'),
  requestFriend: (username) => request('POST', '/api/friends/request', { username }),
  acceptFriend: (id) => request('POST', `/api/friends/${id}/accept`, {}),
  declineFriend: (id) => request('POST', `/api/friends/${id}/decline`, {}),
  removeFriend: (id) => request('DELETE', `/api/friends/${id}`),
  blockUser: (id) => request('POST', `/api/friends/${id}/block`, {}),
  unblockUser: (id) => request('DELETE', `/api/friends/${id}/block`),

  conversations: () => request('GET', '/api/conversations'),
  conversation: (id) => request('GET', `/api/conversations/${id}`),
  openDm: (userId) => request('POST', '/api/conversations/dm', { userId }),
  updateConversation: (id, patch) => request('PATCH', `/api/conversations/${id}`, patch),
  messages: (id, { before, after, limit } = {}) => {
    const qs = new URLSearchParams()
    if (before) qs.set('before', before)
    if (after) qs.set('after', after)
    if (limit) qs.set('limit', limit)
    const s = qs.toString()
    return request('GET', `/api/conversations/${id}/messages${s ? '?' + s : ''}`)
  },
  sendMessage: (id, payload) => request('POST', `/api/conversations/${id}/messages`, payload),
  editMessage: (id, mid, body) => request('PATCH', `/api/conversations/${id}/messages/${mid}`, { body }),
  deleteMessage: (id, mid) => request('DELETE', `/api/conversations/${id}/messages/${mid}`),
  markRead: (id, messageId) => request('POST', `/api/conversations/${id}/read`, messageId ? { messageId } : {}),
  typing: (id) => request('POST', `/api/conversations/${id}/typing`, {}),

  startCall: (id) => request('POST', `/api/conversations/${id}/call`, {}),
  acceptCall: (callId) => request('POST', `/api/calls/${callId}/accept`, {}),
  declineCall: (callId) => request('POST', `/api/calls/${callId}/decline`, {}),
  cancelCall: (callId) => request('POST', `/api/calls/${callId}/cancel`, {}),

  setPresence: (patch) => request('POST', '/api/presence', patch),
  join: (roomCode, hostSecret) => request('POST', '/api/join', { roomCode, hostSecret: hostSecret || null }),
  logout: () => request('POST', '/api/auth/logout', {})
}

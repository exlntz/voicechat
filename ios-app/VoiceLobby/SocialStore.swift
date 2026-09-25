import Foundation
import SwiftUI

// Чаты и друзья для вкладок приложения. Пока без живого канала событий (он будет следующим
// шагом): списки обновляются при открытии вкладки, потягиванием вниз и раз в 15 секунд,
// открытый чат — раз в 3 секунды.
@MainActor
final class SocialStore: ObservableObject {
    @Published private(set) var conversations: [Conversation] = []
    @Published private(set) var friends: [FriendEntry] = []
    @Published private(set) var loaded = false
    @Published var error: String?

    private var pollTask: Task<Void, Never>?

    var unreadTotal: Int { conversations.reduce(0) { $0 + ($1.muted == true ? 0 : $1.unread) } }
    var incomingCount: Int { friends.filter { $0.status == "incoming" }.count }
    var acceptedFriends: [FriendEntry] {
        friends.filter { $0.status == "friend" }
            .sorted { ($0.presence?.isOnline == true ? 0 : 1, $0.user.name.lowercased()) < ($1.presence?.isOnline == true ? 0 : 1, $1.user.name.lowercased()) }
    }
    var incoming: [FriendEntry] { friends.filter { $0.status == "incoming" } }
    var outgoing: [FriendEntry] { friends.filter { $0.status == "outgoing" } }

    func refresh() async {
        do {
            async let convs = API.conversations()
            async let fr = API.friends()
            let (c, f) = try await (convs, fr)
            conversations = c
            friends = f
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(nanoseconds: 15_000_000_000)
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    func reset() {
        stopPolling()
        conversations = []
        friends = []
        loaded = false
    }

    /// Прочитали чат — сразу обнулить счётчик в списке, не дожидаясь сервера
    func markReadLocally(_ id: Int) {
        guard let i = conversations.firstIndex(where: { $0.id == id }), conversations[i].unread > 0 else { return }
        let c = conversations[i]
        conversations[i] = Conversation(id: c.id, type: c.type, peer: c.peer, lastMessage: c.lastMessage,
                                        lastMessageAt: c.lastMessageAt, unread: 0, muted: c.muted, pinned: c.pinned)
    }

    func accept(_ id: Int) async {
        do { try await API.acceptFriend(id); await refresh() } catch { self.error = error.localizedDescription }
    }

    func decline(_ id: Int) async {
        do { try await API.declineFriend(id); await refresh() } catch { self.error = error.localizedDescription }
    }
}

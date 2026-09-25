import Foundation

// Бэкенд тот же, что у сайта и .exe: сессия — httpOnly-cookie (её хранит
// HTTPCookieStorage.shared и переживает перезапуск), /api/join отдаёт токен LiveKit.

struct User: Decodable, Equatable {
    let id: Int
    let username: String
    let displayName: String
    var avatarUrl: String? = nil
}

// ---------- Чаты и друзья (те же ответы, что получает сайт) ----------

struct Person: Decodable, Equatable, Identifiable {
    let id: Int
    let username: String
    let displayName: String?
    let avatarUrl: String?

    var name: String { (displayName?.isEmpty == false ? displayName : nil) ?? username }
}

struct Presence: Decodable, Equatable {
    let status: String
    let inCall: Bool?
    let lastSeen: Double?

    var isOnline: Bool { status != "offline" }
}

struct Message: Decodable, Equatable, Identifiable {
    let id: Int
    let conversationId: Int
    let authorId: Int
    let kind: String
    let body: String
    let createdAt: Double
    let clientId: String?
    let deletedAt: Double?
    let attachments: [Attachment]?

    struct Attachment: Decodable, Equatable {
        let kind: String?
        let name: String?
    }

    var date: Date { Date(timeIntervalSince1970: createdAt / 1000) }

    /// Текст для списка чатов и пузыря, если это не обычное сообщение
    var preview: String {
        if deletedAt != nil { return "Сообщение удалено" }
        if kind == "call" { return "Звонок" }
        if !body.isEmpty { return body }
        switch attachments?.first?.kind {
        case "image": return "Фото"
        case "video": return "Видео"
        case "voice": return "Голосовое сообщение"
        case .some: return "Файл"
        case .none: return ""
        }
    }
}

struct Conversation: Decodable, Equatable, Identifiable {
    let id: Int
    let type: String
    let peer: Person?
    let lastMessage: Message?
    let lastMessageAt: Double?
    let unread: Int
    let muted: Bool?
    let pinned: Bool?

    var isSaved: Bool { type == "saved" }
    var title: String { isSaved ? "Избранное" : (peer?.name ?? "Чат") }
}

struct FriendEntry: Decodable, Equatable, Identifiable {
    let user: Person
    let status: String          // friend | incoming | outgoing | blocked
    let since: Double?
    let presence: Presence?

    var id: Int { user.id }
}

struct CallStart: Decodable {
    let roomCode: String
    let hostSecret: String?
}

struct JoinInfo: Decodable {
    let token: String
    let url: String
    let roomCode: String
    let identity: String
    let displayName: String
    let isHost: Bool
    let hostSecret: String?
    let maxParticipants: Int?
}

struct APIError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

enum API {
    static let baseURL = URL(string: "https://voicelobby.online")!

    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.httpCookieStorage = .shared
        config.httpShouldSetCookies = true
        config.httpCookieAcceptPolicy = .always
        config.timeoutIntervalForRequest = 20
        return URLSession(configuration: config)
    }()

    private struct UserEnvelope: Decodable { let user: User }
    private struct ErrorEnvelope: Decodable { let message: String? }

    /// Текущий пользователь или nil, если сессии нет
    static func me() async throws -> User? {
        let (data, response) = try await send("/api/auth/me")
        if response.statusCode == 401 { return nil }
        return try decode(UserEnvelope.self, data, response).user
    }

    static func login(username: String, password: String) async throws -> User {
        let (data, response) = try await send("/api/auth/login", method: "POST",
                                              body: ["username": username, "password": password])
        return try decode(UserEnvelope.self, data, response).user
    }

    static func register(displayName: String, username: String, password: String) async throws -> User {
        let (data, response) = try await send("/api/auth/register", method: "POST",
                                              body: ["displayName": displayName, "username": username, "password": password])
        return try decode(UserEnvelope.self, data, response).user
    }

    static func logout() async {
        _ = try? await send("/api/auth/logout", method: "POST", body: [:])
    }

    // ---------- Чаты ----------
    private struct ConversationsEnvelope: Decodable { let conversations: [Conversation] }
    private struct ConversationEnvelope: Decodable { let conversation: Conversation }
    private struct MessagesEnvelope: Decodable { let messages: [Message]; let hasMore: Bool? }
    private struct MessageEnvelope: Decodable { let message: Message }
    private struct FriendsEnvelope: Decodable { let friends: [FriendEntry] }
    private struct OK: Decodable {}

    static func conversations() async throws -> [Conversation] {
        let (data, response) = try await send("/api/conversations")
        return try decode(ConversationsEnvelope.self, data, response).conversations
    }

    /// Последние сообщения чата; after — только новее этого id (дозагрузка при открытом чате)
    static func messages(conversation id: Int, after: Int? = nil) async throws -> [Message] {
        var path = "/api/conversations/\(id)/messages"
        if let after { path += "?after=\(after)" }
        let (data, response) = try await send(path)
        return try decode(MessagesEnvelope.self, data, response).messages
    }

    static func send(message text: String, conversation id: Int) async throws -> Message {
        let (data, response) = try await send("/api/conversations/\(id)/messages", method: "POST",
                                              body: ["body": text, "clientId": UUID().uuidString])
        return try decode(MessageEnvelope.self, data, response).message
    }

    static func markRead(conversation id: Int) async {
        _ = try? await send("/api/conversations/\(id)/read", method: "POST", body: [:])
    }

    /// Личка с человеком (создаётся, если её ещё не было)
    static func openDM(with userId: Int) async throws -> Conversation {
        let (data, response) = try await send("/api/conversations/dm", method: "POST", body: ["userId": userId])
        return try decode(ConversationEnvelope.self, data, response).conversation
    }

    /// Позвонить в личку: сервер создаёт комнату и звонит собеседнику
    static func startCall(conversation id: Int) async throws -> CallStart {
        let (data, response) = try await send("/api/conversations/\(id)/call", method: "POST", body: [:])
        return try decode(CallStart.self, data, response)
    }

    // ---------- Друзья ----------
    static func friends() async throws -> [FriendEntry] {
        let (data, response) = try await send("/api/friends")
        return try decode(FriendsEnvelope.self, data, response).friends
    }

    static func requestFriend(username: String) async throws {
        let (data, response) = try await send("/api/friends/request", method: "POST", body: ["username": username])
        _ = try decode(OK.self, data, response)
    }

    static func acceptFriend(_ id: Int) async throws {
        let (data, response) = try await send("/api/friends/\(id)/accept", method: "POST", body: [:])
        _ = try decode(OK.self, data, response)
    }

    static func declineFriend(_ id: Int) async throws {
        let (data, response) = try await send("/api/friends/\(id)/decline", method: "POST", body: [:])
        _ = try decode(OK.self, data, response)
    }

    /// Полный адрес файла сервера (аватарки лежат по /api/files/…)
    static func fileURL(_ path: String?) -> URL? {
        guard let path, !path.isEmpty else { return nil }
        return URL(string: path, relativeTo: baseURL)
    }

    /// Войти в комнату (пустой код — создать новую). hostSecret подтверждает права создателя.
    static func join(roomCode: String, hostSecret: String?) async throws -> JoinInfo {
        var body: [String: Any] = ["roomCode": roomCode]
        if let hostSecret { body["hostSecret"] = hostSecret }
        let (data, response) = try await send("/api/join", method: "POST", body: body)
        return try decode(JoinInfo.self, data, response)
    }

    private static func send(_ path: String, method: String = "GET",
                             body: [String: Any]? = nil) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw APIError(message: "Неверный адрес запроса")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError(message: "Нет связи с сервером. Проверьте интернет-соединение.")
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError(message: "Сервер не ответил")
        }
        return (data, http)
    }

    private static func decode<T: Decodable>(_ type: T.Type, _ data: Data, _ response: HTTPURLResponse) throws -> T {
        guard (200..<300).contains(response.statusCode) else {
            let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
            throw APIError(message: envelope?.message ?? "Ошибка сервера (\(response.statusCode))")
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError(message: "Не удалось прочитать ответ сервера")
        }
    }
}

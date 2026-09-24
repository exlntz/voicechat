import Foundation

// Бэкенд тот же, что у сайта и .exe: сессия — httpOnly-cookie (её хранит
// HTTPCookieStorage.shared и переживает перезапуск), /api/join отдаёт токен LiveKit.

struct User: Decodable, Equatable {
    let id: Int
    let username: String
    let displayName: String
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

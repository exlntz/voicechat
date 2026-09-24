import Foundation
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    enum Screen: Equatable { case loading, auth, lobby, call }

    @Published var screen: Screen = .loading
    @Published var user: User?
    @Published var call: CallModel?
    /// Сообщение для лобби после звонка (например, «Вы отключены от звонка»)
    @Published var notice: String?

    /// «Подключаться с выключенным микрофоном» — как настройка на сайте, по умолчанию выключено
    @Published var joinMicMuted = UserDefaults.standard.bool(forKey: "pref.joinMicMuted") {
        didSet { UserDefaults.standard.set(joinMicMuted, forKey: "pref.joinMicMuted") }
    }

    func start() async {
        do { user = try await API.me() } catch { user = nil }
        screen = user == nil ? .auth : .lobby
    }

    func login(username: String, password: String) async throws {
        user = try await API.login(username: username, password: password)
        notice = nil
        screen = .lobby
    }

    func register(displayName: String, username: String, password: String) async throws {
        user = try await API.register(displayName: displayName, username: username, password: password)
        notice = nil
        screen = .lobby
    }

    func logout() async {
        await API.logout()
        user = nil
        screen = .auth
    }

    func join(roomCode: String, micOn: Bool, camOn: Bool) async throws {
        let code = Self.normalize(roomCode)
        // Создатель комнаты подтверждает права сохранённым секретом (как localStorage на сайте)
        let saved = code.isEmpty ? nil : UserDefaults.standard.string(forKey: "hostSecret:\(code)")
        let info = try await API.join(roomCode: code, hostSecret: saved)
        if info.isHost, let secret = info.hostSecret {
            UserDefaults.standard.set(secret, forKey: "hostSecret:\(info.roomCode)")
        }
        let model = CallModel(info: info, micOn: micOn, camOn: camOn)
        model.onEnded = { [weak self] message in
            self?.finishCall(message: message)
        }
        call = model
        notice = nil
        screen = .call
        await model.connect()
    }

    func leaveCall() async {
        await call?.leave()
        finishCall(message: nil)
    }

    private func finishCall(message: String?) {
        call = nil
        notice = message
        screen = user == nil ? .auth : .lobby
    }

    /// Код комнаты из поля: можно вставить и ссылку вида https://voicelobby.online/room/abc123
    static func normalize(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let range = s.range(of: "/room/") { s = String(s[range.upperBound...]) }
        return s.lowercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
    }
}

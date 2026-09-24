import Foundation
import Combine
import UIKit
import LiveKit

@MainActor
final class CallModel: ObservableObject {
    enum StatusKind { case connecting, live, lost }

    let info: JoinInfo
    let room = Room()

    @Published var micOn: Bool
    @Published var camOn: Bool
    @Published private(set) var statusText = "Подключение…"
    @Published private(set) var statusKind: StatusKind = .connecting
    /// Кто сейчас главный: последний говоривший собеседник (как на сайте)
    @Published private(set) var spotlightIdentity: String?

    /// Звонок закончился не по кнопке «Выйти» (выгнали, обрыв, ошибка) — текст для лобби
    var onEnded: ((String?) -> Void)?

    private var bag = Set<AnyCancellable>()
    private var wasConnected = false
    private var ended = false
    private var pendingSpeaker: String?
    private var speakerTask: Task<Void, Never>?

    init(info: JoinInfo, micOn: Bool, camOn: Bool) {
        self.info = info
        self.micOn = micOn
        self.camOn = camOn
    }

    var inviteURL: URL {
        URL(string: "https://voicelobby.online/room/\(info.roomCode)") ?? API.baseURL
    }

    var localIdentity: String? { room.localParticipant.identity?.stringValue }

    /// Собеседники в порядке имён — стабильный порядок миниатюр
    var remotes: [RemoteParticipant] {
        room.remoteParticipants.values.sorted { $0.displayName.localizedCompare($1.displayName) == .orderedAscending }
    }

    /// Главный: последний говоривший собеседник, иначе первый собеседник; nil — я один
    var mainParticipant: RemoteParticipant? {
        let list = remotes
        if let id = spotlightIdentity, let p = list.first(where: { $0.identity?.stringValue == id }) { return p }
        return list.first
    }

    func connect() async {
        UIApplication.shared.isIdleTimerDisabled = true
        // Room — ObservableObject: любое его изменение (участники, говорящие, статус)
        // пересчитывает статус и главного. objectWillChange приходит ДО изменения,
        // поэтому читаем состояние на следующем шаге главного потока.
        room.objectWillChange
            .sink { [weak self] _ in
                DispatchQueue.main.async { self?.roomDidChange() }
            }
            .store(in: &bag)

        do {
            let options = RoomOptions(
                defaultCameraCaptureOptions: CameraCaptureOptions(position: .front),
                adaptiveStream: true,
                dynacast: true
            )
            try await room.connect(url: info.url, token: info.token, roomOptions: options)
            try await room.localParticipant.setMicrophone(enabled: micOn)
            if camOn {
                try await room.localParticipant.setCamera(enabled: true)
            }
            roomDidChange()
        } catch {
            end("Не удалось подключиться к звонку: \(error.localizedDescription)")
        }
    }

    func toggleMic() async {
        let next = !micOn
        do {
            try await room.localParticipant.setMicrophone(enabled: next)
            micOn = next
        } catch {}
    }

    func toggleCamera() async {
        let next = !camOn
        do {
            try await room.localParticipant.setCamera(enabled: next)
            camOn = next
        } catch {}
    }

    /// Передняя ↔ задняя камера
    func flipCamera() async {
        guard let track = room.localParticipant.firstCameraVideoTrack as? LocalVideoTrack,
              let capturer = track.capturer as? CameraCapturer else { return }
        _ = try? await capturer.switchCameraPosition()
    }

    func leave() async {
        ended = true
        speakerTask?.cancel()
        await room.disconnect()
        UIApplication.shared.isIdleTimerDisabled = false
    }

    private func end(_ message: String?) {
        guard !ended else { return }
        ended = true
        speakerTask?.cancel()
        UIApplication.shared.isIdleTimerDisabled = false
        let room = self.room
        Task { await room.disconnect() }
        onEnded?(message)
    }

    private func roomDidChange() {
        guard !ended else { return }
        switch room.connectionState {
        case .connected:
            wasConnected = true
            setStatus("Подключено", .live)
        case .reconnecting:
            setStatus("Переподключение…", .connecting)
        case .disconnected:
            if wasConnected {
                end("Вы отключены от звонка")
                return
            }
        default:
            setStatus("Подключение…", .connecting)
        }
        updateSpeaker()
    }

    private func setStatus(_ text: String, _ kind: StatusKind) {
        if statusText != text { statusText = text }
        if statusKind != kind { statusKind = kind }
    }

    // Самый громкий собеседник (не я) через ~0,9 с становится главным, если всё ещё
    // говорит — короткие звуки и перебивания не перекидывают сцену туда-сюда
    private func updateSpeaker() {
        let me = localIdentity
        guard let loudest = room.activeSpeakers.first(where: { $0.identity?.stringValue != me }),
              let id = loudest.identity?.stringValue,
              id != spotlightIdentity, id != pendingSpeaker else { return }
        pendingSpeaker = id
        speakerTask?.cancel()
        speakerTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 900_000_000)
            guard let self, !Task.isCancelled else { return }
            if loudest.isSpeaking { self.spotlightIdentity = id }
            self.pendingSpeaker = nil
        }
    }
}

extension Participant {
    /// Стабильный идентификатор для ForEach
    var viewID: ObjectIdentifier { ObjectIdentifier(self) }

    var displayName: String {
        if let name, !name.isEmpty { return name }
        return identity?.stringValue ?? "Участник"
    }

    /// Создатель комнаты — сервер кладёт {"isHost": true} в metadata токена
    var isRoomHost: Bool {
        guard let metadata, let data = metadata.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return object["isHost"] as? Bool ?? false
    }
}

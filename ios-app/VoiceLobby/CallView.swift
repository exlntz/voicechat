import SwiftUI
import UIKit
import LiveKit

// Экран звонка — как мобильная версия сайта:
// один — своя плитка + приглашение; двое и больше — главный на весь экран,
// остальные миниатюрами колонкой в правом верхнем углу; кнопки — плавающая
// «капсула» по центру снизу и овальная «Выйти» рядом.
struct CallView: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var call: CallModel
    @ObservedObject var room: Room
    @State var copied = false

    /// Сколько места снизу занимает плавающая панель (плитки и подписи не прячем под неё)
    private let controlsInset: CGFloat = 84

    var body: some View {
        VStack(spacing: 0) {
            topBar
            stage
                .padding(10)
        }
        .overlay(alignment: .bottom) {
            controls
                .padding(.bottom, 10)
        }
        .background(Theme.bg.ignoresSafeArea())
    }

    // MARK: - Шапка

    private var topBar: some View {
        HStack(spacing: 10) {
            LogoMark(size: 30)
            Spacer(minLength: 8)
            roomCapsule
            Spacer(minLength: 8)
            ShareLink(item: call.inviteURL) {
                Image(systemName: "person.badge.plus")
                    .font(.system(size: 15))
                    .foregroundColor(Theme.text)
                    .frame(width: 40, height: 40)
                    .overlay(Circle().strokeBorder(Theme.borderStrong))
            }
            .accessibilityLabel("Пригласить в звонок")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Theme.surface.ignoresSafeArea(edges: .top))
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.border).frame(height: 1)
        }
    }

    // Статус · код комнаты (копирование) · корона создателя — одна капсула, как на сайте
    private var roomCapsule: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
                .accessibilityLabel(call.statusText)
            separator
            Button(action: copyCode) {
                HStack(spacing: 7) {
                    Text(call.info.roomCode)
                        .font(.system(size: 14, weight: .medium))
                        .monospacedDigit()
                        .foregroundColor(Theme.text)
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 12))
                        .foregroundColor(copied ? Theme.successSoft : Theme.textFaint)
                }
            }
            .accessibilityLabel("Скопировать код комнаты")
            if call.info.isHost {
                separator
                Image(systemName: "crown.fill")
                    .font(.system(size: 12))
                    .foregroundColor(Theme.accentSoft)
                    .accessibilityLabel("Вы создатель комнаты")
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 38)
        .background(Capsule().fill(Color.white.opacity(0.035)))
        .overlay(Capsule().strokeBorder(Theme.border))
    }

    private var separator: some View {
        Rectangle().fill(Theme.border).frame(width: 1, height: 14)
    }

    private var statusColor: Color {
        switch call.statusKind {
        case .live: return Theme.success
        case .connecting: return Theme.accentSoft
        case .lost: return Theme.danger
        }
    }

    private func copyCode() {
        UIPasteboard.general.string = call.info.roomCode
        withAnimation { copied = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) {
            withAnimation { copied = false }
        }
    }

    // MARK: - Сцена

    @ViewBuilder
    private var stage: some View {
        stageContent
            .overlay(alignment: .top) {
                if let banner = call.banner {
                    MessageBox(text: banner)
                        .padding(.horizontal, 8)
                        .padding(.top, 8)
                        .onTapGesture { call.banner = nil }
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.easeOut(duration: 0.25), value: call.banner)
    }

    @ViewBuilder
    private var stageContent: some View {
        if let sharer = call.screenSharer, let track = sharer.firstScreenShareVideoTrack {
            // Кто-то показывает экран — демонстрация на главном месте, все камеры миниатюрами
            ZStack(alignment: .topTrailing) {
                ScreenTileView(track: track, name: sharer.displayName, bottomInset: controlsInset)
                thumbColumn(call.remotes + [room.localParticipant])
            }
        } else if let main = call.mainParticipant {
            ZStack(alignment: .topTrailing) {
                TileView(participant: main, isLocal: false, style: .main, bottomInset: controlsInset)
                thumbColumn(thumbnails(main: main))
            }
        } else {
            VStack(spacing: 10) {
                TileView(participant: room.localParticipant, isLocal: true, style: .regular)
                InviteCard(code: call.info.roomCode, url: call.inviteURL)
            }
            .padding(.bottom, controlsInset)
        }
    }

    /// Колонка миниатюр в правом верхнем углу
    private func thumbColumn(_ list: [Participant]) -> some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 10) {
                ForEach(list, id: \.viewID) { p in
                    TileView(participant: p, isLocal: p === room.localParticipant, style: .thumb)
                        .frame(width: 96, height: 128)
                }
            }
            .padding(10)
        }
        .frame(width: 116)
    }

    /// Все, кроме главного; своя миниатюра — последней
    private func thumbnails(main: Participant) -> [Participant] {
        let others: [Participant] = call.remotes.filter { $0 !== main }
        return others + [room.localParticipant]
    }

    // MARK: - Панель кнопок

    private var controls: some View {
        HStack(spacing: 10) {
            HStack(spacing: 6) {
                CtrlButton(icon: call.micOn ? "mic.fill" : "mic.slash.fill",
                           kind: call.micOn ? .active : .off,
                           label: call.micOn ? "Выключить микрофон" : "Включить микрофон") {
                    Task { await call.toggleMic() }
                }
                CtrlButton(icon: call.camOn ? "video.fill" : "video.slash.fill",
                           kind: call.camOn ? .active : .off,
                           label: call.camOn ? "Выключить камеру" : "Включить камеру") {
                    Task { await call.toggleCamera() }
                }
                CtrlButton(icon: "arrow.triangle.2.circlepath.camera", kind: .neutral, label: "Сменить камеру") {
                    Task { await call.flipCamera() }
                }
                .disabled(!call.camOn)
                .opacity(call.camOn ? 1 : 0.4)
                CtrlButton(icon: call.screenOn ? "rectangle.on.rectangle.slash" : "rectangle.on.rectangle",
                           kind: call.screenOn ? .active : .neutral,
                           label: call.screenOn ? "Остановить демонстрацию экрана" : "Демонстрация экрана") {
                    Task { await call.toggleScreenShare() }
                }
            }
            .padding(6)
            .background(.ultraThinMaterial, in: Capsule())
            .background(Capsule().fill(Color(hex: 0x0f1115, alpha: 0.72)))
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.10)))
            .shadow(color: .black.opacity(0.45), radius: 16, y: 10)

            Button {
                Task { await app.leaveCall() }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "phone.down.fill")
                    Text("Выйти")
                }
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(Theme.dangerSoft)
                .padding(.horizontal, 18)
                .frame(height: 50)
                .background(Capsule().fill(Theme.dangerWash))
                .background(.ultraThinMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(Theme.danger))
            }
            .buttonStyle(PressScale())
        }
    }
}

// MARK: - Плитка участника

struct TileView: View {
    enum Style { case regular, main, thumb }

    @ObservedObject var participant: Participant
    let isLocal: Bool
    var style: Style = .regular
    var bottomInset: CGFloat = 0

    var body: some View {
        ZStack {
            (style == .thumb ? Theme.thumbBg : Theme.tileBg)
            if let track = participant.firstCameraVideoTrack, participant.isCameraEnabled() {
                SwiftUIVideoView(track, layoutMode: .fill, mirrorMode: .auto)
            } else {
                AvatarView(name: participant.displayName, size: avatarSize)
            }
        }
        .overlay(alignment: .bottomLeading) {
            label
                .padding(.leading, style == .thumb ? 8 : 14)
                .padding(.bottom, (style == .thumb ? 8 : 14) + bottomInset)
        }
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(participant.isSpeaking ? Theme.accentSoft : Theme.border,
                              lineWidth: participant.isSpeaking ? 2 : 1)
        )
        .shadow(color: .black.opacity(style == .thumb ? 0.5 : 0), radius: 14, y: 8)
        .animation(.easeOut(duration: 0.2), value: participant.isSpeaking)
    }

    private var nameText: String {
        guard isLocal else { return participant.displayName }
        return style == .thumb ? "Вы" : "\(participant.displayName) (Вы)"
    }

    private var avatarSize: CGFloat {
        switch style {
        case .thumb: return 36
        case .main: return 112
        case .regular: return 72
        }
    }

    @ViewBuilder
    private var label: some View {
        let content = HStack(spacing: style == .thumb ? 5 : 8) {
            if !participant.isCameraEnabled() {
                Image(systemName: "video.slash.fill").foregroundColor(Theme.dangerSoft)
            }
            if !participant.isMicrophoneEnabled() {
                Image(systemName: "mic.slash.fill").foregroundColor(Theme.dangerSoft)
            }
            Text(nameText)
                .foregroundColor(Theme.text)
                .lineLimit(1)
            if participant.isRoomHost {
                Image(systemName: "crown.fill").foregroundColor(Theme.accentSoft)
            }
        }
        .font(.system(size: style == .thumb ? 11 : (style == .main ? 16 : 13),
                      weight: style == .main ? .semibold : .medium))

        if style == .thumb {
            // В миниатюре — без плашки, прямо на картинке
            content.shadow(color: .black.opacity(0.8), radius: 2, y: 1)
        } else {
            content
                .padding(.horizontal, style == .main ? 14 : 11)
                .padding(.vertical, style == .main ? 9 : 6)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color(hex: 0x06080c, alpha: 0.78)))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
        }
    }
}

// MARK: - Демонстрация экрана собеседника

struct ScreenTileView: View {
    let track: VideoTrack
    let name: String
    var bottomInset: CGFloat = 0

    var body: some View {
        ZStack {
            Color.black
            SwiftUIVideoView(track, layoutMode: .fit, mirrorMode: .off)
        }
        .overlay(alignment: .topLeading) {
            HStack(spacing: 6) {
                Circle().fill(Color.white).frame(width: 6, height: 6)
                Text("LIVE")
            }
            .font(.system(size: 11, weight: .semibold))
            .foregroundColor(.white)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(Capsule().fill(Theme.danger))
            .padding(12)
        }
        .overlay(alignment: .bottomLeading) {
            HStack(spacing: 8) {
                Image(systemName: "display")
                Text("Демонстрация — \(name)").lineLimit(1)
            }
            .font(.system(size: 13, weight: .medium))
            .foregroundColor(Theme.text)
            .padding(.horizontal, 11)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color(hex: 0x06080c, alpha: 0.78)))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
            .padding(.leading, 14)
            .padding(.bottom, 14 + bottomInset)
        }
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.border))
    }
}

// MARK: - Кнопка панели

struct CtrlButton: View {
    enum Kind { case active, off, neutral }

    let icon: String
    let kind: Kind
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(foreground)
                .frame(width: 46, height: 46)
                .background(Circle().fill(fill))
                .overlay(Circle().strokeBorder(stroke))
        }
        .buttonStyle(PressScale())
        .accessibilityLabel(label)
    }

    private var foreground: Color {
        switch kind {
        case .active: return .white
        case .off: return Theme.dangerSoft
        case .neutral: return Theme.text
        }
    }

    private var fill: Color {
        switch kind {
        case .active: return Theme.accent
        case .off: return Theme.dangerWash
        case .neutral: return Color.white.opacity(0.07)
        }
    }

    private var stroke: Color {
        switch kind {
        case .active: return Theme.accent
        case .off: return Color(hex: 0xd94a3d, alpha: 0.55)
        case .neutral: return .clear
        }
    }
}

// MARK: - Приглашение, пока в звонке никого нет

struct InviteCard: View {
    let code: String
    let url: URL
    @State var copied = false

    var body: some View {
        VStack(spacing: 14) {
            Text("Чтобы пригласить других участников, отправьте им ссылку на звонок")
                .font(.system(size: 18, weight: .bold))
                .multilineTextAlignment(.center)
                .foregroundColor(Theme.text)
                .fixedSize(horizontal: false, vertical: true)

            ShareLink(item: url) {
                Label("Отправить ссылку", systemImage: "link")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(.white)
                    .padding(.horizontal, 24)
                    .frame(height: 48)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.accent))
            }

            Button {
                UIPasteboard.general.string = url.absoluteString
                withAnimation { copied = true }
            } label: {
                Text(copied ? "Ссылка скопирована" : "Скопировать ссылку")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(copied ? Theme.successSoft : Theme.accentSoft)
            }

            HStack(spacing: 6) {
                Text("Код комнаты:").foregroundColor(Theme.textDim)
                Text(code).fontWeight(.semibold).foregroundColor(Theme.text)
            }
            .font(.system(size: 14))
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.border))
    }
}

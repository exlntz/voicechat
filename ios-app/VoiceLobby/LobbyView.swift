import SwiftUI

// Лобби перед звонком: с чем входить, код комнаты, вход
struct LobbyView: View {
    @EnvironmentObject var app: AppModel
    @State var roomCode = ""
    @State var camOn = false
    @State var micOn = true
    @State var busy = false
    @State var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                BrandHeader(logo: 44, font: 30)
                    .padding(.bottom, 2)

                userBar

                if let notice = app.notice { MessageBox(text: notice) }
                if let error { MessageBox(text: error) }

                HStack(spacing: 8) {
                    JoinToggle(title: "Камера", icon: camOn ? "video.fill" : "video.slash.fill", on: camOn) { camOn.toggle() }
                    JoinToggle(title: "Микрофон", icon: micOn ? "mic.fill" : "mic.slash.fill", on: micOn) { micOn.toggle() }
                }

                Toggle(isOn: $app.joinMicMuted) {
                    Text("Подключаться с выключенным микрофоном")
                        .font(.system(size: 14))
                        .foregroundColor(Theme.text)
                }
                .tint(Theme.accent)
                .padding(.vertical, 2)

                UnderlineField(title: "Код комнаты", text: $roomCode,
                               hint: "оставьте пустым — создать новую", onSubmit: join)
                    .padding(.top, 4)

                PrimaryButton(title: roomCode.isEmpty ? "Создать / войти" : "Войти в комнату",
                              loading: busy, action: join)
                    .padding(.top, 8)

                Text("Поделитесь кодом комнаты с теми, кого хотите позвать в звонок.")
                    .font(.system(size: 13))
                    .foregroundColor(Theme.textFaint)
            }
            .padding(24)
            .cardStyle()
            .padding(16)
        }
        .scrollDismissesKeyboard(.interactively)
        .onAppear { micOn = !app.joinMicMuted }
        .onChange(of: app.joinMicMuted) { muted in micOn = !muted }
    }

    private var userBar: some View {
        HStack(spacing: 9) {
            Image(systemName: "person.fill")
                .font(.system(size: 13))
                .foregroundColor(Theme.accentSoft)
            Text(app.user?.displayName ?? "")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(Theme.text)
                .lineLimit(1)
            Spacer()
            Button {
                Task { await app.logout() }
            } label: {
                Text("Выйти")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(Theme.dangerSoft)
                    .padding(.horizontal, 14)
                    .frame(height: 36)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.dangerWash))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.danger))
            }
            .buttonStyle(PressScale())
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.border))
    }

    private func join() {
        guard !busy else { return }
        busy = true
        error = nil
        Task {
            do {
                try await app.join(roomCode: roomCode, micOn: micOn, camOn: camOn)
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

// Переключатель «с чем входить» (как .join-toggle-btn)
struct JoinToggle: View {
    let title: String
    let icon: String
    let on: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                Image(systemName: icon)
                    .font(.system(size: 14))
                    .foregroundColor(on ? Theme.accentSoft : Theme.dangerSoft)
                Text(title)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(on ? .white : Theme.textDim)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 48)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(on ? Theme.accentWash : Color.clear))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(on ? Theme.accent : Theme.border))
        }
        .buttonStyle(PressScale())
        .accessibilityLabel(title)
        .accessibilityValue(on ? "включено" : "выключено")
    }
}

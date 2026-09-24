import SwiftUI

// Вход и регистрация — тот же аккаунт, что на сайте
struct AuthView: View {
    enum Mode { case login, register }

    @EnvironmentObject var app: AppModel
    @State var mode: Mode = .login
    @State var displayName = ""
    @State var username = ""
    @State var password = ""
    @State var error: String?
    @State var busy = false

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                BrandHeader(logo: 44, font: 28)
                    .padding(.top, 32)

                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(mode == .login ? "Вход" : "Регистрация")
                            .font(.system(size: 32, weight: .bold))
                            .foregroundColor(Theme.text)
                        Text(mode == .login
                             ? "Используйте юзернейм и пароль от аккаунта"
                             : "Создайте аккаунт, чтобы заходить в звонки с любого устройства")
                            .font(.system(size: 15))
                            .foregroundColor(Theme.textDim)
                    }

                    if let error { MessageBox(text: error) }

                    if mode == .register {
                        UnderlineField(title: "Отображаемое имя", text: $displayName,
                                       hint: "его видят другие участники звонка", contentType: .name)
                    }
                    UnderlineField(title: mode == .login ? "Юзернейм" : "Юзернейм (для входа)", text: $username,
                                   hint: mode == .login ? "тот, с которым регистрировались" : "латиница, цифры, _ и -",
                                   contentType: .username)
                    UnderlineField(title: mode == .login ? "Пароль" : "Пароль (мин. 6 символов)", text: $password,
                                   secure: true, contentType: mode == .login ? .password : .newPassword,
                                   onSubmit: submit)

                    PrimaryButton(title: mode == .login ? "Войти" : "Зарегистрироваться", loading: busy, action: submit)
                        .padding(.top, 6)

                    HStack(spacing: 6) {
                        Text(mode == .login ? "Нет аккаунта?" : "Уже есть аккаунт?")
                            .foregroundColor(Theme.textDim)
                        Button(mode == .login ? "Зарегистрироваться" : "Войти") {
                            withAnimation(.easeInOut(duration: 0.25)) {
                                mode = mode == .login ? .register : .login
                                error = nil
                            }
                        }
                        .foregroundColor(Theme.accentSoft)
                        .font(.system(size: 15, weight: .semibold))
                    }
                    .font(.system(size: 15))
                    .frame(maxWidth: .infinity)
                }
                .padding(24)
                .cardStyle()
            }
            .padding(16)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private func submit() {
        guard !busy else { return }
        let name = username.trimmingCharacters(in: .whitespaces)
        if name.isEmpty || password.isEmpty {
            error = "Введите логин и пароль"
            return
        }
        busy = true
        error = nil
        Task {
            do {
                if mode == .login {
                    try await app.login(username: name, password: password)
                } else {
                    try await app.register(displayName: displayName.trimmingCharacters(in: .whitespaces),
                                           username: name, password: password)
                }
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

import SwiftUI

// Главный экран после входа: нижнее меню как в Telegram — «Чаты», «Звонки», «Друзья».
// На iOS 26 системный TabView сам рисует его «жидким стеклом» (плавающая стеклянная
// капсула, сворачивается при прокрутке); на старых iOS — обычная полупрозрачная панель.
struct MainTabView: View {
    @EnvironmentObject var app: AppModel
    @EnvironmentObject var social: SocialStore

    var body: some View {
        TabView(selection: $app.tab) {
            ChatsView()
                .tabItem { Label("Чаты", systemImage: "bubble.left.and.bubble.right.fill") }
                .badge(social.unreadTotal)
                .tag(AppModel.Tab.chats)

            CallsView()
                .tabItem { Label("Звонки", systemImage: "phone.fill") }
                .tag(AppModel.Tab.calls)

            FriendsView()
                .tabItem { Label("Друзья", systemImage: "person.2.fill") }
                .badge(social.incomingCount)
                .tag(AppModel.Tab.friends)
        }
        .tint(Theme.accentSoft)
        .minimizingTabBar()
        .onAppear { social.startPolling() }
    }
}

// Кнопка профиля в шапке вкладок: аватар → лист с именем и выходом
struct ProfileButton: View {
    @EnvironmentObject var app: AppModel
    @State private var showProfile = false

    var body: some View {
        Button { showProfile = true } label: {
            PersonAvatar(name: app.user?.displayName ?? "", url: app.user?.avatarUrl, size: 32)
        }
        .accessibilityLabel("Профиль")
        .sheet(isPresented: $showProfile) { ProfileSheet() }
    }
}

struct ProfileSheet: View {
    @EnvironmentObject var app: AppModel
    @EnvironmentObject var social: SocialStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 14) {
                        PersonAvatar(name: app.user?.displayName ?? "", url: app.user?.avatarUrl, size: 60)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(app.user?.displayName ?? "")
                                .font(.system(size: 20, weight: .bold))
                            Text("@" + (app.user?.username ?? ""))
                                .font(.system(size: 15))
                                .foregroundColor(Theme.textFaint)
                        }
                    }
                    .padding(.vertical, 6)
                }
                Section {
                    Toggle("Подключаться с выключенным микрофоном", isOn: $app.joinMicMuted)
                        .tint(Theme.accent)
                }
                Section {
                    Button(role: .destructive) {
                        dismiss()
                        social.reset()
                        Task { await app.logout() }
                    } label: {
                        Text("Выйти из аккаунта")
                    }
                }
            }
            .navigationTitle("Профиль")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Готово") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

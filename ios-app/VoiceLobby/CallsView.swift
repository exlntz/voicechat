import SwiftUI

// Вкладка «Звонки»: быстрый звонок другу (кто в сети — сверху) и вход в комнату по коду
struct CallsView: View {
    @EnvironmentObject var app: AppModel
    @EnvironmentObject var social: SocialStore
    @State private var busyUser: Int?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if !social.acceptedFriends.isEmpty {
                        Text("Позвонить другу")
                            .font(.system(size: 22, weight: .bold))
                            .foregroundColor(Theme.text)
                            .padding(.horizontal, 20)
                            .padding(.top, 8)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 14) {
                                ForEach(social.acceptedFriends) { entry in
                                    Button { callFriend(entry.user.id) } label: {
                                        VStack(spacing: 8) {
                                            ZStack {
                                                PersonAvatar(name: entry.user.name, url: entry.user.avatarUrl, size: 64,
                                                             online: entry.presence?.isOnline == true)
                                                if busyUser == entry.user.id {
                                                    Circle().fill(Color.black.opacity(0.45)).frame(width: 64, height: 64)
                                                    ProgressView().tint(.white)
                                                }
                                            }
                                            Text(entry.user.name)
                                                .font(.system(size: 13, weight: .semibold))
                                                .foregroundColor(Theme.text)
                                                .lineLimit(1)
                                                .frame(width: 76)
                                        }
                                    }
                                    .buttonStyle(PressScale())
                                    .accessibilityLabel("Позвонить: \(entry.user.name)")
                                }
                            }
                            .padding(.horizontal, 20)
                            .padding(.vertical, 12)
                        }
                    }
                    if let error { MessageBox(text: error).padding(.horizontal, 16) }
                    LobbyView(embedded: true)
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Звонки")
            .toolbar { ToolbarItem(placement: .navigationBarLeading) { ProfileButton() } }
        }
    }

    private func callFriend(_ userId: Int) {
        guard busyUser == nil else { return }
        busyUser = userId
        error = nil
        Task {
            do {
                let conv = try await API.openDM(with: userId)
                try await app.call(conversation: conv.id)
            } catch {
                self.error = error.localizedDescription
            }
            busyUser = nil
        }
    }
}

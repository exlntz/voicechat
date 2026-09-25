import SwiftUI

// Вкладка «Друзья»: добавить по юзернейму, заявки (принять/отклонить), список друзей —
// сначала те, кто в сети; у каждого «Написать» и «Позвонить»
struct FriendsView: View {
    @EnvironmentObject var app: AppModel
    @EnvironmentObject var social: SocialStore
    @State private var username = ""
    @State private var adding = false
    @State private var notice: String?
    @State private var noticeOK = false
    @State private var path: [Int] = []
    @State private var busyUser: Int?

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    HStack(spacing: 10) {
                        Image(systemName: "at").foregroundColor(Theme.textFaint)
                        TextField("Юзернейм друга", text: $username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.send)
                            .onSubmit(add)
                        Button(action: add) {
                            if adding { ProgressView() } else { Image(systemName: "person.badge.plus").font(.system(size: 17, weight: .semibold)) }
                        }
                        .disabled(adding || username.trimmingCharacters(in: .whitespaces).isEmpty)
                        .accessibilityLabel("Отправить заявку")
                    }
                    if let notice {
                        Text(notice)
                            .font(.system(size: 14))
                            .foregroundColor(noticeOK ? Theme.successSoft : Theme.dangerSoft)
                    }
                }

                if !social.incoming.isEmpty {
                    Section("Заявки") {
                        ForEach(social.incoming) { entry in
                            HStack(spacing: 12) {
                                PersonAvatar(name: entry.user.name, url: entry.user.avatarUrl, size: 44)
                                NameStack(person: entry.user, subtitle: "Хочет добавить вас в друзья")
                                Spacer()
                                Button { Task { await social.decline(entry.user.id) } } label: {
                                    Image(systemName: "xmark").font(.system(size: 14, weight: .bold))
                                        .frame(width: 36, height: 36).glassBackground(in: Circle(), interactive: true)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Отклонить")
                                Button { Task { await social.accept(entry.user.id) } } label: {
                                    Image(systemName: "checkmark").font(.system(size: 14, weight: .bold)).foregroundColor(.white)
                                        .frame(width: 36, height: 36).background(Circle().fill(Theme.accent))
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Принять")
                            }
                        }
                    }
                }

                Section {
                    if social.loaded && social.acceptedFriends.isEmpty {
                        Text("Пока нет друзей — добавьте кого-нибудь по юзернейму")
                            .font(.system(size: 14))
                            .foregroundColor(Theme.textFaint)
                    }
                    ForEach(social.acceptedFriends) { entry in
                        HStack(spacing: 12) {
                            PersonAvatar(name: entry.user.name, url: entry.user.avatarUrl, size: 44,
                                         online: entry.presence?.isOnline == true)
                            NameStack(person: entry.user, subtitle: presenceText(entry.presence))
                            Spacer()
                            Button { message(entry.user.id) } label: {
                                Image(systemName: "bubble.left.fill").font(.system(size: 14))
                                    .frame(width: 36, height: 36).glassBackground(in: Circle(), interactive: true)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Написать")
                            Button { callFriend(entry.user.id) } label: {
                                Group {
                                    if busyUser == entry.user.id { ProgressView() } else { Image(systemName: "phone.fill").font(.system(size: 14)) }
                                }
                                .frame(width: 36, height: 36).glassBackground(in: Circle(), interactive: true)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Позвонить")
                        }
                    }
                } header: {
                    if !social.acceptedFriends.isEmpty { Text("Друзья · \(social.acceptedFriends.count)") }
                }

                if !social.outgoing.isEmpty {
                    Section("Отправленные заявки") {
                        ForEach(social.outgoing) { entry in
                            HStack(spacing: 12) {
                                PersonAvatar(name: entry.user.name, url: entry.user.avatarUrl, size: 40)
                                NameStack(person: entry.user, subtitle: "Ждёт ответа")
                            }
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg.ignoresSafeArea())
            .refreshable { await social.refresh() }
            .navigationTitle("Друзья")
            .toolbar { ToolbarItem(placement: .navigationBarLeading) { ProfileButton() } }
            .navigationDestination(for: Int.self) { id in ChatView(conversationId: id) }
        }
    }

    private func add() {
        let name = username.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "@", with: "")
        guard !name.isEmpty, !adding else { return }
        adding = true
        Task {
            do {
                try await API.requestFriend(username: name)
                notice = "Заявка отправлена"
                noticeOK = true
                username = ""
                await social.refresh()
            } catch {
                notice = error.localizedDescription
                noticeOK = false
            }
            adding = false
        }
    }

    private func message(_ userId: Int) {
        Task {
            do {
                let conv = try await API.openDM(with: userId)
                await social.refresh()
                path.append(conv.id)
            } catch {
                notice = error.localizedDescription
                noticeOK = false
            }
        }
    }

    private func callFriend(_ userId: Int) {
        guard busyUser == nil else { return }
        busyUser = userId
        Task {
            do {
                let conv = try await API.openDM(with: userId)
                try await app.call(conversation: conv.id)
            } catch {
                notice = error.localizedDescription
                noticeOK = false
            }
            busyUser = nil
        }
    }
}

private struct NameStack: View {
    let person: Person
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(person.name).font(.system(size: 16, weight: .bold)).lineLimit(1)
                Text("@" + person.username).font(.system(size: 13)).foregroundColor(Theme.textFaint).lineLimit(1)
            }
            Text(subtitle).font(.system(size: 13)).foregroundColor(Theme.textFaint).lineLimit(1)
        }
    }
}

func presenceText(_ p: Presence?) -> String {
    guard let p else { return "Не в сети" }
    if p.inCall == true { return "В звонке" }
    switch p.status {
    case "online": return "В сети"
    case "idle": return "Отошёл"
    case "dnd": return "Не беспокоить"
    default: return "Не в сети"
    }
}

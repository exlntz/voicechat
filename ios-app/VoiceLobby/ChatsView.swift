import SwiftUI

// Вкладка «Чаты»: список личек как на сайте — аватар, имя, последнее сообщение, время, счётчик
struct ChatsView: View {
    @EnvironmentObject var social: SocialStore
    @State private var query = ""

    private var filtered: [Conversation] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return social.conversations }
        return social.conversations.filter {
            $0.title.lowercased().contains(q) || ($0.peer?.username.lowercased().contains(q) ?? false)
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if !social.loaded {
                    ProgressView().tint(Theme.textDim)
                } else if social.conversations.isEmpty {
                    EmptyState(icon: "bubble.left.and.bubble.right", title: "Здесь появятся ваши переписки",
                               text: "Напишите другу во вкладке «Друзья»")
                } else {
                    List {
                        ForEach(filtered) { conv in
                            NavigationLink(value: conv.id) { ChatRow(conv: conv) }
                                .listRowBackground(Color.clear)
                                .listRowSeparator(.hidden)
                                .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .refreshable { await social.refresh() }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Чаты")
            .searchable(text: $query, prompt: "Найти чат")
            .toolbar { ToolbarItem(placement: .navigationBarLeading) { ProfileButton() } }
            .navigationDestination(for: Int.self) { id in
                ChatView(conversationId: id)
            }
        }
    }
}

struct ChatRow: View {
    @EnvironmentObject var app: AppModel
    let conv: Conversation

    var body: some View {
        HStack(spacing: 12) {
            PersonAvatar(name: conv.title, url: conv.peer?.avatarUrl, size: 54, saved: conv.isSaved)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(conv.title)
                        .font(.system(size: 16, weight: .bold))
                        .foregroundColor(Theme.text)
                        .lineLimit(1)
                    if conv.muted == true {
                        Image(systemName: "bell.slash.fill").font(.system(size: 11)).foregroundColor(Theme.textFaint)
                    }
                    Spacer(minLength: 6)
                    Text(shortTime(conv.lastMessageAt ?? conv.lastMessage?.createdAt))
                        .font(.system(size: 13))
                        .foregroundColor(conv.unread > 0 ? Theme.accentSoft : Theme.textFaint)
                }
                HStack(alignment: .center) {
                    Text(subtitle)
                        .font(.system(size: 15))
                        .foregroundColor(Theme.textDim)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    if conv.unread > 0 {
                        Text(conv.unread > 99 ? "99+" : "\(conv.unread)")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundColor(.white)
                            .padding(.horizontal, 7)
                            .frame(minWidth: 22, minHeight: 22)
                            .background(Capsule().fill(conv.muted == true ? Color(hex: 0x5b6270) : Theme.accent))
                    } else if conv.pinned == true {
                        Image(systemName: "pin.fill").font(.system(size: 12)).foregroundColor(Theme.textFaint)
                    }
                }
            }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }

    private var subtitle: String {
        guard let m = conv.lastMessage else { return conv.isSaved ? "Сохранённые сообщения" : "Нет сообщений" }
        let mine = m.authorId == app.user?.id && !conv.isSaved
        return (mine ? "Вы: " : "") + m.preview
    }
}

struct EmptyState: View {
    let icon: String
    let title: String
    var text: String? = nil

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 30))
                .foregroundColor(Theme.textFaint)
                .frame(width: 72, height: 72)
                .glassBackground(in: Circle())
            Text(title)
                .font(.system(size: 17, weight: .semibold))
                .foregroundColor(Theme.text)
                .multilineTextAlignment(.center)
            if let text {
                Text(text)
                    .font(.system(size: 14))
                    .foregroundColor(Theme.textFaint)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(32)
    }
}

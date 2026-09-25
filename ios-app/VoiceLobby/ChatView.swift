import SwiftUI

// Переписка: пузыри как на сайте (свои — синие справа), поле ввода в стеклянной капсуле,
// звонок из шапки. Новые сообщения подтягиваются раз в 3 секунды, пока чат открыт.
struct ChatView: View {
    @EnvironmentObject var app: AppModel
    @EnvironmentObject var social: SocialStore
    let conversationId: Int

    @State private var messages: [Message] = []
    @State private var loading = true
    @State private var text = ""
    @State private var sending = false
    @State private var error: String?
    @State private var calling = false
    @FocusState private var inputFocused: Bool

    private var conv: Conversation? { social.conversations.first { $0.id == conversationId } }
    private var myId: Int { app.user?.id ?? -1 }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 4) {
                    if loading {
                        ProgressView().tint(Theme.textDim).padding(.top, 40)
                    } else if messages.isEmpty {
                        EmptyState(icon: "hand.wave", title: "Начало переписки", text: "Напишите первое сообщение")
                            .padding(.top, 40)
                    }
                    ForEach(Array(messages.enumerated()), id: \.element.id) { index, m in
                        if index == 0 || !Calendar.current.isDate(messages[index - 1].date, inSameDayAs: m.date) {
                            DayChip(date: m.date).padding(.vertical, 8)
                        }
                        Bubble(message: m, mine: m.authorId == myId,
                               tail: index == messages.count - 1 || messages[index + 1].authorId != m.authorId)
                            .id(m.id)
                    }
                    Color.clear.frame(height: 4).id("bottom")
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg.ignoresSafeArea())
            .safeAreaInset(edge: .bottom) { composer }
            .onChange(of: messages.count) { _ in
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .navigationTitle(conv?.title ?? "Чат")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                if conv?.isSaved != true {
                    Button { call() } label: {
                        if calling { ProgressView() } else { Image(systemName: "phone.fill") }
                    }
                    .disabled(calling)
                    .accessibilityLabel("Позвонить")
                }
            }
        }
        .toolbar(.hidden, for: .tabBar)
        .task { await poll() }
        .alert("Не получилось", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(error ?? "") }
    }

    // Поле ввода — стеклянная капсула поверх ленты, справа круглая кнопка отправки
    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Сообщение", text: $text, axis: .vertical)
                .lineLimit(1...6)
                .focused($inputFocused)
                .font(.system(size: 17))
                .foregroundColor(Theme.text)
                .tint(Theme.accentSoft)
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .glassBackground(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            Button(action: sendMessage) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundColor(.white)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(canSend ? Theme.accent : Color(hex: 0x2a303b)))
            }
            .disabled(!canSend)
            .accessibilityLabel("Отправить")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var canSend: Bool { !sending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private func sendMessage() {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, !sending else { return }
        sending = true
        text = ""
        Task {
            do {
                let m = try await API.send(message: body, conversation: conversationId)
                if !messages.contains(where: { $0.id == m.id }) { messages.append(m) }
            } catch {
                text = body
                self.error = error.localizedDescription
            }
            sending = false
        }
    }

    private func poll() async {
        do {
            messages = try await API.messages(conversation: conversationId)
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
        await API.markRead(conversation: conversationId)
        social.markReadLocally(conversationId)
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard !Task.isCancelled else { break }
            let lastId = messages.last?.id
            if let fresh = try? await API.messages(conversation: conversationId, after: lastId), !fresh.isEmpty {
                let known = Set(messages.map(\.id))
                messages.append(contentsOf: fresh.filter { !known.contains($0.id) })
                await API.markRead(conversation: conversationId)
            }
        }
    }

    private func call() {
        guard !calling else { return }
        calling = true
        Task {
            do { try await app.call(conversation: conversationId) } catch { self.error = error.localizedDescription }
            calling = false
        }
    }
}

private struct Bubble: View {
    let message: Message
    let mine: Bool
    let tail: Bool

    var body: some View {
        HStack {
            if mine { Spacer(minLength: 48) }
            HStack(alignment: .lastTextBaseline, spacing: 8) {
                if message.kind == "call" {
                    Image(systemName: "phone.fill").font(.system(size: 13))
                }
                Text(message.preview)
                    .font(.system(size: 16))
                    .italic(message.deletedAt != nil)
                    .fixedSize(horizontal: false, vertical: true)
                Text(message.date, style: .time)
                    .font(.system(size: 11))
                    .foregroundColor(mine ? Color.white.opacity(0.7) : Theme.textFaint)
            }
            .foregroundColor(mine ? .white : Theme.text)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(
                UnevenBubbleShape(mine: mine, tail: tail)
                    .fill(mine ? Theme.accent : Color(hex: 0x1f242d))
            )
            if !mine { Spacer(minLength: 48) }
        }
    }
}

// Пузырь со скруглением 20 и «хвостиком» — уголок 6 у последнего сообщения подряд
private struct UnevenBubbleShape: Shape {
    let mine: Bool
    let tail: Bool

    func path(in rect: CGRect) -> Path {
        let r: CGFloat = 20
        let small: CGFloat = tail ? 6 : 20
        let tl = r, tr = r
        let bl = mine ? r : small
        let br = mine ? small : r
        var p = Path()
        p.move(to: CGPoint(x: rect.minX + tl, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX - tr, y: rect.minY))
        p.addArc(center: CGPoint(x: rect.maxX - tr, y: rect.minY + tr), radius: tr, startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false)
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - br))
        p.addArc(center: CGPoint(x: rect.maxX - br, y: rect.maxY - br), radius: br, startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
        p.addLine(to: CGPoint(x: rect.minX + bl, y: rect.maxY))
        p.addArc(center: CGPoint(x: rect.minX + bl, y: rect.maxY - bl), radius: bl, startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
        p.addLine(to: CGPoint(x: rect.minX, y: rect.minY + tl))
        p.addArc(center: CGPoint(x: rect.minX + tl, y: rect.minY + tl), radius: tl, startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        p.closeSubpath()
        return p
    }
}

private struct DayChip: View {
    let date: Date

    var body: some View {
        Text(label)
            .font(.system(size: 13, weight: .medium))
            .foregroundColor(Theme.textDim)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .glassBackground(in: Capsule())
    }

    private var label: String {
        let cal = Calendar.current
        if cal.isDateInToday(date) { return "Сегодня" }
        if cal.isDateInYesterday(date) { return "Вчера" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "ru_RU")
        f.dateFormat = cal.isDate(date, equalTo: Date(), toGranularity: .year) ? "d MMMM" : "d MMMM yyyy"
        return f.string(from: date)
    }
}

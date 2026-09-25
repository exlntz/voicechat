import SwiftUI

// «Жидкое стекло» (Liquid Glass, iOS 26): на iOS 26 — настоящее стекло Apple, на старых
// версиях — матовая подложка того же вида. Сборка старым Xcode (без SDK iOS 26) тоже проходит:
// ветка со стеклом компилируется только новым компилятором.
extension View {
    /// Стеклянная капсула/форма под элементом (кнопки, плашки поверх контента)
    @ViewBuilder
    func glassBackground<S: Shape>(in shape: S, interactive: Bool = false) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            if interactive {
                self.glassEffect(.regular.interactive(), in: shape)
            } else {
                self.glassEffect(.regular, in: shape)
            }
        } else {
            self.background(.ultraThinMaterial, in: shape)
        }
        #else
        self.background(.ultraThinMaterial, in: shape)
        #endif
    }

    /// Нижнее меню: на iOS 26 при прокрутке вниз оно сворачивается, как в Telegram
    @ViewBuilder
    func minimizingTabBar() -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            self.tabBarMinimizeBehavior(.onScrollDown)
        } else {
            self
        }
        #else
        self
        #endif
    }
}

// Аватар: фото с сервера, пока грузится или если его нет — кружок с инициалами
struct PersonAvatar: View {
    let name: String
    let url: String?
    var size: CGFloat = 52
    var online = false
    var saved = false

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Group {
                if saved {
                    Image(systemName: "bookmark.fill")
                        .font(.system(size: size * 0.38, weight: .semibold))
                        .foregroundColor(.white)
                        .frame(width: size, height: size)
                        .background(Circle().fill(Theme.accent))
                } else if let link = API.fileURL(url) {
                    AsyncImage(url: link) { phase in
                        if let image = phase.image {
                            image.resizable().scaledToFill()
                        } else {
                            initialsCircle
                        }
                    }
                    .frame(width: size, height: size)
                    .clipShape(Circle())
                } else {
                    initialsCircle
                }
            }
            if online {
                Circle()
                    .fill(Theme.success)
                    .frame(width: size * 0.26, height: size * 0.26)
                    .overlay(Circle().strokeBorder(Theme.bg, lineWidth: 2.5))
                    .offset(x: 1, y: 1)
            }
        }
        .accessibilityHidden(true)
    }

    private var initialsCircle: some View {
        Text(initials(name))
            .font(.system(size: size * 0.36, weight: .bold))
            .foregroundColor(Theme.text)
            .frame(width: size, height: size)
            .background(Circle().fill(Color(hex: 0x2a303b)))
    }
}

// Короткое время для списка: сегодня — часы, на неделе — день, раньше — дата
func shortTime(_ ms: Double?) -> String {
    guard let ms else { return "" }
    let date = Date(timeIntervalSince1970: ms / 1000)
    let cal = Calendar.current
    let f = DateFormatter()
    f.locale = Locale(identifier: "ru_RU")
    if cal.isDateInToday(date) { f.dateFormat = "HH:mm" }
    else if cal.isDateInYesterday(date) { return "вчера" }
    else if let days = cal.dateComponents([.day], from: date, to: Date()).day, days < 7 { f.dateFormat = "EE" }
    else { f.dateFormat = "d MMM" }
    return f.string(from: date)
}

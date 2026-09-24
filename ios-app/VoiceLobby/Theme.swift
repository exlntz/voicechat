import SwiftUI
import UIKit

// Цвета и общие элементы — те же, что в public/static/style.css сайта.

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255,
            opacity: alpha
        )
    }
}

enum Theme {
    static let bg = Color(hex: 0x0f1115)
    static let surface = Color(hex: 0x15181e)
    static let surface2 = Color(hex: 0x1b1f27)
    static let text = Color(hex: 0xf2f5f9)
    static let textDim = Color(hex: 0xf2f5f9, alpha: 0.70)
    static let textFaint = Color(hex: 0xf2f5f9, alpha: 0.48)
    static let border = Color(hex: 0xf2f5f9, alpha: 0.12)
    static let borderStrong = Color(hex: 0xf2f5f9, alpha: 0.26)
    static let accent = Color(hex: 0x0458cf)
    static let accentSoft = Color(hex: 0x6ea8f5)
    static let accentWash = Color(hex: 0x0458cf, alpha: 0.18)
    static let danger = Color(hex: 0xd94a3d)
    static let dangerSoft = Color(hex: 0xff9c92)
    static let dangerWash = Color(hex: 0xd94a3d, alpha: 0.14)
    static let success = Color(hex: 0x3aa86e)
    static let successSoft = Color(hex: 0x7fd8a6)
    static let tileBg = Color(hex: 0x05070a)
    static let thumbBg = Color(hex: 0x1a1d24)
}

// Фон экранов входа и лобби: тёмная база и мягкие синие пятна по углам
struct ScreenBackground: View {
    var body: some View {
        ZStack {
            Theme.bg
            RadialGradient(colors: [Color(hex: 0x0458cf, alpha: 0.20), .clear],
                           center: UnitPoint(x: 0.86, y: 0.02), startRadius: 0, endRadius: 520)
            RadialGradient(colors: [Color(hex: 0x0458cf, alpha: 0.10), .clear],
                           center: UnitPoint(x: 0.02, y: 0.98), startRadius: 0, endRadius: 460)
        }
        .ignoresSafeArea()
    }
}

// Логотип «Живой голос»: облачко речи с эквалайзером (как public/static/favicon.svg)
struct LogoMark: View {
    var size: CGFloat = 32

    var body: some View {
        Canvas { ctx, sz in
            let s = sz.width / 120
            let blue = Color(hex: 0x0458cf)
            ctx.fill(Path(roundedRect: CGRect(x: 8 * s, y: 12 * s, width: 104 * s, height: 80 * s),
                          cornerRadius: 28 * s), with: .color(blue))
            var tail = Path()
            tail.move(to: CGPoint(x: 26 * s, y: 86 * s))
            tail.addLine(to: CGPoint(x: 22 * s, y: 108 * s))
            tail.addLine(to: CGPoint(x: 48 * s, y: 90 * s))
            tail.closeSubpath()
            ctx.fill(tail, with: .color(blue))
            let bars: [(CGFloat, CGFloat, CGFloat)] = [(34, 42, 20), (49, 32, 40), (64, 38, 28), (79, 44.4, 15.2)]
            for bar in bars {
                ctx.fill(Path(roundedRect: CGRect(x: bar.0 * s, y: bar.1 * s, width: 9 * s, height: bar.2 * s),
                              cornerRadius: 4.5 * s), with: .color(.white))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

struct BrandHeader: View {
    var logo: CGFloat = 44
    var font: CGFloat = 30

    var body: some View {
        HStack(spacing: 8) {
            LogoMark(size: logo)
            Text("Voice Lobby")
                .font(.system(size: font, weight: .bold))
                .tracking(-0.3)
                .foregroundColor(Theme.text)
        }
    }
}

extension View {
    // Карточка как .lobby-card на сайте
    func cardStyle() -> some View {
        self
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Theme.border))
            .shadow(color: .black.opacity(0.35), radius: 20, y: 12)
    }
}

struct PressScale: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

// Главная синяя кнопка формы
struct PrimaryButton: View {
    let title: String
    var loading = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                if loading {
                    ProgressView().tint(.white)
                } else {
                    Text(title).font(.system(size: 16, weight: .semibold))
                }
            }
            .foregroundColor(.white)
            .frame(maxWidth: .infinity)
            .frame(height: 54)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.accent))
        }
        .buttonStyle(PressScale())
        .disabled(loading)
    }
}

// Плашка ошибки/успеха как .error-box / .auth-error.success
struct MessageBox: View {
    let text: String
    var success = false

    var body: some View {
        Text(text)
            .font(.system(size: 14))
            .foregroundColor(success ? Theme.successSoft : Theme.dangerSoft)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(success ? Color(hex: 0x3aa86e, alpha: 0.14) : Theme.dangerWash))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(success ? Color(hex: 0x3aa86e, alpha: 0.35) : Color(hex: 0xd94a3d, alpha: 0.35)))
    }
}

// Поле-строка с подчёркиванием, подписью сверху и подсказкой снизу (.fld на сайте)
struct UnderlineField: View {
    let title: String
    @Binding var text: String
    var secure = false
    var hint: String? = nil
    var contentType: UITextContentType? = nil
    var onSubmit: () -> Void = {}

    @State var reveal = false
    @FocusState var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(focused ? Theme.accentSoft : Theme.textFaint)
            HStack(spacing: 10) {
                Group {
                    if secure && !reveal {
                        SecureField("", text: $text)
                    } else {
                        TextField("", text: $text)
                    }
                }
                .focused($focused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textContentType(contentType)
                .submitLabel(.go)
                .onSubmit(onSubmit)
                .font(.system(size: 16))
                .foregroundColor(Theme.text)
                .tint(Theme.accentSoft)

                if secure {
                    Button { reveal.toggle() } label: {
                        Image(systemName: reveal ? "eye.slash" : "eye")
                            .font(.system(size: 15))
                            .foregroundColor(Theme.textFaint)
                    }
                    .accessibilityLabel(reveal ? "Скрыть пароль" : "Показать пароль")
                }
            }
            .padding(.vertical, 6)
            Rectangle()
                .fill(focused ? Theme.accentSoft : Theme.border)
                .frame(height: focused ? 2 : 1)
                .animation(.easeOut(duration: 0.2), value: focused)
            if let hint {
                Text(hint)
                    .font(.system(size: 12))
                    .foregroundColor(Theme.textFaint)
            }
        }
    }
}

// Круг с инициалами (как .avatar-circle)
struct AvatarView: View {
    let name: String
    var size: CGFloat = 64

    var body: some View {
        Text(initials(name))
            .font(.system(size: size * 0.36, weight: .semibold))
            .foregroundColor(.white)
            .frame(width: size, height: size)
            .background(
                Circle().fill(LinearGradient(
                    colors: [Color(hex: 0x2a7ff0), Color(hex: 0x0458cf), Color(hex: 0x0341a0)],
                    startPoint: .topLeading, endPoint: .bottomTrailing))
            )
            .shadow(color: Color(hex: 0x0458cf, alpha: 0.28), radius: 14, y: 8)
    }
}

// Инициалы: первые буквы двух слов, иначе две первые буквы имени
func initials(_ name: String) -> String {
    let parts = name.split(whereSeparator: { $0 == " " || $0 == "_" || $0 == "-" })
    if parts.count >= 2 {
        return (String(parts[0].prefix(1)) + String(parts[1].prefix(1))).uppercased()
    }
    return String(name.prefix(2)).uppercased()
}

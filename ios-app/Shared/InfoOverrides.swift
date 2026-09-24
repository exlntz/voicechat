import Foundation
import ObjectiveC

/// Общий для приложения и расширения демонстрации.
///
/// SideStore/AltStore при подписи бесплатным Apple ID:
///  - переименовывают App Group: group.X → group.X.<TeamID> (реальное имя — в Info.plist, ключ ALTAppGroups);
///  - дописывают Team ID к bundle id приложения и расширения.
/// LiveKit же берёт App Group и id расширения демонстрации из ключей
/// RTCAppGroupIdentifier / RTCScreenSharingExtension в Bundle.main.infoDictionary.
/// Здесь эти два ключа подменяются на актуальные значения — до того, как их прочитает LiveKit.
enum InfoOverrides {
    static let groupKey = "RTCAppGroupIdentifier"
    static let extensionKey = "RTCScreenSharingExtension"

    private(set) static var values: [String: Any] = [:]
    private static var installed = false

    static func install() {
        guard !installed else { return }
        installed = true
        values = computeValues()
        guard let original = class_getInstanceMethod(Bundle.self, #selector(getter: Bundle.infoDictionary)),
              let replacement = class_getInstanceMethod(Bundle.self, #selector(Bundle.vl_infoDictionary))
        else { return }
        method_exchangeImplementations(original, replacement)
    }

    /// App Group, через который приложение и расширение передают кадры
    static var appGroup: String? {
        (values[groupKey] as? String) ?? (Bundle.main.infoDictionary?[groupKey] as? String)
    }

    /// Bundle id расширения демонстрации
    static var screenSharingExtension: String? {
        (values[extensionKey] as? String) ?? (Bundle.main.infoDictionary?[extensionKey] as? String)
    }

    private static func computeValues() -> [String: Any] {
        var result: [String: Any] = [:]
        let main = Bundle.main
        // Расширение лежит в <App>.app/PlugIns/<Ext>.appex — Info.plist приложения двумя уровнями выше
        let isExtension = main.bundleURL.pathExtension == "appex"
        let appBundle = isExtension
            ? Bundle(url: main.bundleURL.deletingLastPathComponent().deletingLastPathComponent())
            : main

        let groups = (main.object(forInfoDictionaryKey: "ALTAppGroups") as? [String])
            ?? (appBundle?.object(forInfoDictionaryKey: "ALTAppGroups") as? [String])
        if let group = groups?.first(where: { $0.hasPrefix("group.online.voicelobby") }) ?? groups?.first {
            result[groupKey] = group
        }

        if !isExtension,
           let plugins = main.builtInPlugInsURL,
           let items = try? FileManager.default.contentsOfDirectory(at: plugins, includingPropertiesForKeys: nil),
           let appex = items.first(where: { $0.pathExtension == "appex" }),
           let identifier = Bundle(url: appex)?.bundleIdentifier {
            result[extensionKey] = identifier
        }
        return result
    }
}

extension Bundle {
    /// После method_exchangeImplementations вызов vl_infoDictionary() внутри — это оригинал
    @objc func vl_infoDictionary() -> [String: Any]? {
        let original = vl_infoDictionary()
        guard self === Bundle.main, !InfoOverrides.values.isEmpty, var dict = original else { return original }
        for (key, value) in InfoOverrides.values { dict[key] = value }
        return dict
    }
}

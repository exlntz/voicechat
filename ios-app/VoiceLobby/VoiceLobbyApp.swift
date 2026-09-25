import SwiftUI

@main
struct VoiceLobbyApp: App {
    @StateObject private var app = AppModel()
    @StateObject private var social = SocialStore()

    init() {
        // До первого обращения LiveKit к Info.plist: реальные App Group и id расширения под SideStore
        InfoOverrides.install()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
                .environmentObject(social)
                .preferredColorScheme(.dark)
                .task { await app.start() }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var app: AppModel

    var body: some View {
        ZStack {
            ScreenBackground()
            switch app.screen {
            case .loading:
                LogoMark(size: 72)
            case .auth:
                AuthView().transition(.opacity)
            case .main:
                MainTabView().transition(.opacity)
            case .call:
                if let call = app.call {
                    CallView(call: call, room: call.room).transition(.opacity)
                }
            }
        }
        .animation(.easeInOut(duration: 0.25), value: app.screen)
    }
}

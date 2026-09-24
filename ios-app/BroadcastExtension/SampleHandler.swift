import LiveKit
import ReplayKit

// Расширение ReplayKit: iOS отдаёт ему кадры экрана, LiveKit передаёт их в приложение
// через общий App Group, а приложение публикует их в звонок как демонстрацию.
final class SampleHandler: LKSampleHandler {
    override init() {
        // До super.init(): LiveKit сразу читает App Group из Info.plist
        InfoOverrides.install()
        super.init()
    }
}

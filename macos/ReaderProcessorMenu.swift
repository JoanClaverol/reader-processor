// Reader Processor macOS launcher.
//
// Owns the local Node server and a dedicated Chrome app-mode process. Quitting
// either app stops the other, so no server is left holding the port or SQLite.

import AppKit

let repoPath = Bundle.main.object(forInfoDictionaryKey: "ReaderProcessorRepoRoot") as? String
    ?? "\(NSHomeDirectory())/Developer/reader-processor"

// GUI apps don't inherit your shell PATH, so node has to be found by hand.
let nodeCandidates = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
]

let childPath = (nodeCandidates.map { ($0 as NSString).deletingLastPathComponent } + ["/bin"])
    .joined(separator: ":")

final class LauncherApp: NSObject, NSApplicationDelegate {
    private enum State {
        case stopped
        case starting(Process)
        case running(Process, Int)

        var process: Process? {
            switch self {
            case .stopped: return nil
            case .starting(let process): return process
            case .running(let process, _): return process
            }
        }
    }

    private var state: State = .stopped { didSet { refreshMenu() } }
    private var serverPipe: Pipe?
    private var serverLog = ""
    private var authProcess: Process?
    private var chromeProcess: Process?
    private var isTerminating = false

    private var loadingWindow: NSWindow!
    private var loadingLabel: NSTextField!
    private let statusLine = NSMenuItem(title: "Server: stopped", action: nil, keyEquivalent: "")
    private let authItem = NSMenuItem(
        title: "Re-authenticate Gmail...", action: #selector(reauthenticate), keyEquivalent: "")

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildLoadingWindow()
        refreshMenu()
        showLoadingWindow()
        startServer()
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication, hasVisibleWindows: Bool
    ) -> Bool {
        if let chromeProcess, chromeProcess.isRunning {
            chromeApplication()?.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        } else if state.process == nil {
            showLoadingWindow()
            startServer()
        } else {
            showLoadingWindow()
        }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        chromeProcess == nil
    }

    func applicationWillTerminate(_ notification: Notification) {
        isTerminating = true
        if let chromeProcess, chromeProcess.isRunning { chromeProcess.terminate() }
        killServer()
        if let authProcess, authProcess.isRunning { authProcess.terminate() }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard urls.contains(where: {
            $0.scheme == "reader-processor" && $0.host == "authenticate"
        }) else { return }
        if authProcess?.isRunning != true { reauthenticate() }
    }

    // MARK: - Server lifecycle

    private func resolveTooling() -> (node: String, script: String)? {
        let script = "\(repoPath)/bin/reader-process.js"
        guard FileManager.default.isReadableFile(atPath: script) else {
            alert("Can't find the app", "Expected the checkout at \(repoPath).")
            return nil
        }
        guard let node = nodeCandidates.first(where: {
            FileManager.default.isExecutableFile(atPath: $0)
        }) else {
            alert("Can't find node", "Looked in:\n" + nodeCandidates.joined(separator: "\n"))
            return nil
        }
        return (node, script)
    }

    private func childProcess(_ tooling: (node: String, script: String), _ args: [String]) -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tooling.node)
        process.arguments = [tooling.script] + args
        process.currentDirectoryURL = URL(fileURLWithPath: repoPath)
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = childPath
        process.environment = environment
        return process
    }

    private func startServer() {
        guard state.process == nil, let tooling = resolveTooling() else { return }
        let process = childProcess(tooling, [])
        process.environment?["NO_OPEN"] = "1"

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        serverLog = ""
        var buffer = Data()
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            buffer.append(chunk)
            guard let text = String(data: buffer, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.serverLogged(text) }
        }
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async { self?.serverExited(process) }
        }

        do {
            try process.run()
        } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            alert("Couldn't start the server", error.localizedDescription)
            return
        }
        serverPipe = pipe
        state = .starting(process)
    }

    private func serverLogged(_ text: String) {
        serverLog = text
        guard case .starting(let process) = state, let port = Self.parsePort(text) else { return }
        state = .running(process, port)
        pollUntilReady(port: port, attempts: 40)
    }

    private func serverExited(_ process: Process) {
        guard process === state.process else { return }
        let log = serverLog
        let status = process.terminationStatus
        teardownServerPipe()
        state = .stopped
        guard !isTerminating else { return }
        chromeProcess?.terminate()
        chromeProcess = nil
        if status != 0 {
            alert(
                "Server stopped unexpectedly",
                log.isEmpty ? "Exit code \(status)." : log.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        NSApp.terminate(nil)
    }

    private func pollUntilReady(port: Int, attempts: Int) {
        guard attempts > 0 else {
            alert("Server didn't come up", "Nothing answered on port \(port).")
            NSApp.terminate(nil)
            return
        }
        guard case .running = state,
            let url = URL(string: "http://127.0.0.1:\(port)/")
        else { return }

        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self, case .running = self.state else { return }
                if response != nil {
                    self.openChrome(port: port)
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        self.pollUntilReady(port: port, attempts: attempts - 1)
                    }
                }
            }
        }.resume()
    }

    private func teardownServerPipe() {
        serverPipe?.fileHandleForReading.readabilityHandler = nil
        serverPipe = nil
    }

    private func killServer() {
        guard let process = state.process, process.isRunning else {
            state = .stopped
            return
        }
        state = .stopped
        teardownServerPipe()
        process.terminate()
        let deadline = Date().addingTimeInterval(5)
        while process.isRunning && Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
        }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    }

    // MARK: - Chrome lifecycle

    private func openChrome(port: Int) {
        guard let chrome = NSWorkspace.shared.urlForApplication(
            withBundleIdentifier: "com.google.Chrome")
        else {
            alert("Can't find Google Chrome", "Install Google Chrome and try again.")
            NSApp.terminate(nil)
            return
        }

        let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let profile = appSupport.appendingPathComponent("Reader Processor/Chrome", isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: profile, withIntermediateDirectories: true)
        } catch {
            alert("Couldn't prepare Chrome", error.localizedDescription)
            NSApp.terminate(nil)
            return
        }

        // A force-quit can leave this dedicated profile's Chrome alive. Chrome
        // would hand it the new URL and make our new child exit immediately.
        if let staleChrome = lockedChromeApplication(profile: profile) {
            loadingLabel.stringValue = "Closing the previous Chrome window..."
            staleChrome.terminate()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                if !staleChrome.isTerminated { staleChrome.forceTerminate() }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    self?.launchChrome(at: chrome, profile: profile, port: port)
                }
            }
            return
        }

        launchChrome(at: chrome, profile: profile, port: port)
    }

    private func launchChrome(at chrome: URL, profile: URL, port: Int) {
        loadingLabel.stringValue = "Opening Reader Processor in Chrome..."
        let process = Process()
        process.executableURL = chrome.appendingPathComponent("Contents/MacOS/Google Chrome")
        process.arguments = [
            "--app=http://localhost:\(port)/",
            "--user-data-dir=\(profile.path)",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-mode",
        ]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] terminated in
            DispatchQueue.main.async { self?.chromeExited(terminated) }
        }
        do {
            try process.run()
        } catch {
            alert("Couldn't open Chrome", error.localizedDescription)
            NSApp.terminate(nil)
            return
        }
        chromeProcess = process
        loadingWindow.orderOut(nil)
        chromeApplication()?.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    }

    private func lockedChromeApplication(profile: URL) -> NSRunningApplication? {
        let lock = profile.appendingPathComponent("SingletonLock")
        guard let target = try? FileManager.default.destinationOfSymbolicLink(atPath: lock.path),
            let pidText = target.split(separator: "-").last,
            let pid = Int32(pidText),
            let application = NSRunningApplication(processIdentifier: pid),
            application.bundleIdentifier == "com.google.Chrome"
        else { return nil }
        return application
    }

    private func chromeApplication() -> NSRunningApplication? {
        guard let chromeProcess else { return nil }
        return NSRunningApplication(processIdentifier: chromeProcess.processIdentifier)
    }

    private func chromeExited(_ process: Process) {
        guard process === chromeProcess else { return }
        chromeProcess = nil
        if !isTerminating { NSApp.terminate(nil) }
    }

    // MARK: - Gmail authentication

    @objc private func reauthenticate() {
        if let running = authProcess, running.isRunning {
            running.terminate()
            authProcess = nil
            refreshMenu()
            return
        }
        guard let tooling = resolveTooling() else { return }
        let process = childProcess(tooling, ["auth"])
        let pipe = Pipe()
        let collected = Collector()
        process.standardOutput = pipe
        process.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            collected.append(chunk)
        }
        process.terminationHandler = { [weak self] process in
            let status = process.terminationStatus
            let output = collected.text()
            DispatchQueue.main.async {
                guard let self else { return }
                pipe.fileHandleForReading.readabilityHandler = nil
                let cancelled = self.authProcess !== process
                self.authProcess = nil
                self.refreshMenu()
                if !cancelled { self.authFinished(status: status, output: output) }
            }
        }
        do {
            try process.run()
        } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            alert("Couldn't start authentication", error.localizedDescription)
            return
        }
        authProcess = process
        refreshMenu()
    }

    private func authFinished(status: Int32, output: String) {
        guard status == 0 else {
            alert("Authentication failed", output.isEmpty ? "Exit code \(status)." : output)
            return
        }
        var note = ""
        if let path = Self.parseTokenPath(output) {
            do {
                try FileManager.default.setAttributes(
                    [.posixPermissions: 0o600], ofItemAtPath: path)
            } catch {
                note = "\n\nCouldn't restrict permissions on \(path): \(error.localizedDescription)"
            }
        }
        alert("Gmail connected", "Reader Processor can now access your newsletters.\(note)")
        chromeApplication()?.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    }

    // MARK: - Window and menu

    private func buildMenu() {
        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu(title: "Reader Processor")
        appItem.submenu = appMenu

        let about = NSMenuItem(
            title: "About Reader Processor",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: "")
        about.target = NSApp
        appMenu.addItem(about)
        appMenu.addItem(.separator())
        statusLine.isEnabled = false
        appMenu.addItem(statusLine)
        authItem.target = self
        appMenu.addItem(authItem)
        appMenu.addItem(.separator())
        let quit = NSMenuItem(
            title: "Quit Reader Processor", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        appMenu.addItem(quit)
        NSApp.mainMenu = mainMenu
    }

    private func buildLoadingWindow() {
        loadingLabel = NSTextField(labelWithString: "Starting Reader Processor...")
        loadingLabel.font = .systemFont(ofSize: 17, weight: .medium)
        loadingLabel.textColor = .secondaryLabelColor
        loadingLabel.alignment = .center
        loadingLabel.frame = NSRect(x: 30, y: 55, width: 360, height: 24)

        let content = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 140))
        content.addSubview(loadingLabel)
        loadingWindow = NSWindow(
            contentRect: content.bounds,
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false)
        loadingWindow.title = "Reader Processor"
        loadingWindow.contentView = content
        loadingWindow.center()
    }

    private func showLoadingWindow() {
        loadingLabel.stringValue = "Starting Reader Processor..."
        loadingWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func refreshMenu() {
        switch state {
        case .stopped: statusLine.title = "Server: stopped"
        case .starting: statusLine.title = "Server: starting..."
        case .running(_, let port): statusLine.title = "Server: running :\(port)"
        }
        let authenticating = authProcess?.isRunning == true
        authItem.title = authenticating ? "Cancel authentication" : "Re-authenticate Gmail..."
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    // MARK: - Helpers

    private final class Collector {
        private let lock = NSLock()
        private var data = Data()

        func append(_ chunk: Data) {
            lock.lock()
            data.append(chunk)
            lock.unlock()
        }

        func text() -> String {
            lock.lock()
            defer { lock.unlock() }
            return String(data: data, encoding: .utf8) ?? ""
        }
    }

    private static func parsePort(_ text: String) -> Int? {
        let pattern = "localhost:([0-9]+)"
        guard let regex = try? NSRegularExpression(pattern: pattern),
            let match = regex.firstMatch(
                in: text, range: NSRange(text.startIndex..., in: text)),
            let range = Range(match.range(at: 1), in: text)
        else { return nil }
        return Int(text[range])
    }

    private static func parseTokenPath(_ text: String) -> String? {
        guard let range = text.range(of: "Token saved to ") else { return nil }
        let rest = text[range.upperBound...]
        let path = rest.prefix(while: { !$0.isNewline }).trimmingCharacters(in: .whitespaces)
        return path.isEmpty ? nil : path
    }

    private func alert(_ title: String, _ detail: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.alertStyle = .warning
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}

let app = NSApplication.shared
let delegate = LauncherApp()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()

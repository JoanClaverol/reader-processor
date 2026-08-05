// ReaderProcessor menu bar app.
//
// Lives in the menu bar with no Dock icon. "Open dashboard" spawns the Node
// server on demand (NO_OPEN=1 so the CLI doesn't race us to the browser),
// reads the port off its stdout, waits for it to answer, then opens the
// dashboard in a chromeless Chrome window. Quitting stops the server.

import AppKit

// Where the checkout lives. Change if you move the repo.
let repoPath = "\(NSHomeDirectory())/Developer/reader-processor"

// GUI apps don't inherit your shell PATH, so node has to be found by hand.
let nodeCandidates = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
]

/// PATH for children, derived from the same list so there's one place to edit.
let childPath = (nodeCandidates.map { ($0 as NSString).deletingLastPathComponent } + ["/bin"])
    .joined(separator: ":")

final class MenuApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    /// One lifecycle, one variable: a port can't exist without a process, and
    /// "starting" can't disagree with whether something is running.
    private enum State {
        case stopped
        case starting(Process)
        case running(Process, Int)

        var process: Process? {
            switch self {
            case .stopped: return nil
            case .starting(let p): return p
            case .running(let p, _): return p
            }
        }
    }

    private var statusItem: NSStatusItem!
    private let statusLine = NSMenuItem(title: "Server: stopped", action: nil, keyEquivalent: "")
    private let stopItem = NSMenuItem(
        title: "Stop server", action: #selector(stopServer), keyEquivalent: "")
    private let authItem = NSMenuItem(
        title: "Re-authenticate Gmail…", action: #selector(reauthenticate), keyEquivalent: "")

    private var state: State = .stopped { didSet { refreshMenu() } }
    private var serverPipe: Pipe?
    private var serverLog = ""  // kept so a failed start can explain itself
    private var authProcess: Process?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = NSImage(
                systemSymbolName: "book.closed", accessibilityDescription: "reader-processor")
            button.image?.isTemplate = true
        }

        let menu = NSMenu()
        menu.delegate = self

        let open = NSMenuItem(
            title: "Open dashboard", action: #selector(openDashboard), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)

        statusLine.isEnabled = false
        menu.addItem(statusLine)

        menu.addItem(.separator())

        authItem.target = self
        menu.addItem(authItem)

        stopItem.target = self
        menu.addItem(stopItem)

        let quit = NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
        refreshMenu()
    }

    /// The app launches at login and never quits, so picking it in Spotlight is
    /// a reopen of the running instance rather than a launch. Without this the
    /// keystroke lands on a process that has nothing to show and does nothing.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        openDashboard()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Children outlive us otherwise: they'd be reparented to launchd and
        // keep holding the port and the SQLite file.
        killServer()
        if let auth = authProcess, auth.isRunning {
            auth.terminate()
            authProcess = nil
        }
    }

    // MARK: - Menu state

    func menuWillOpen(_ menu: NSMenu) {
        refreshMenu()
    }

    private func refreshMenu() {
        switch state {
        case .stopped: statusLine.title = "Server: stopped"
        case .starting: statusLine.title = "Server: starting…"
        case .running(_, let port): statusLine.title = "Server: running :\(port)"
        }
        stopItem.isEnabled = state.process != nil

        // The OAuth flow blocks on a human who may never come back, so the
        // item stays live as a cancel rather than latching disabled forever.
        let authing = authProcess?.isRunning == true
        authItem.title = authing ? "Cancel authentication" : "Re-authenticate Gmail…"
    }

    // MARK: - Actions

    @objc private func openDashboard() {
        switch state {
        case .running(_, let port):
            openWindow(port: port)
        case .starting:
            break  // a window is already queued behind the readiness poll
        case .stopped:
            startServer()
        }
    }

    @objc private func stopServer() {
        killServer()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    // MARK: - Server lifecycle

    /// node and the CLI entry point, or nil (having explained why) if either is missing.
    private func resolveTooling() -> (node: String, script: String)? {
        let script = "\(repoPath)/bin/reader-process.js"
        guard FileManager.default.isReadableFile(atPath: script) else {
            alert("Can't find the app", "Expected the checkout at \(repoPath).")
            return nil
        }
        guard
            let node = nodeCandidates.first(where: {
                FileManager.default.isExecutableFile(atPath: $0)
            })
        else {
            alert("Can't find node", "Looked in:\n" + nodeCandidates.joined(separator: "\n"))
            return nil
        }
        return (node, script)
    }

    /// GUI apps get a bare environment, so node and its PATH are spelled out.
    private func childProcess(_ tooling: (node: String, script: String), _ args: [String]) -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tooling.node)
        process.arguments = [tooling.script] + args
        process.currentDirectoryURL = URL(fileURLWithPath: repoPath)

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = childPath
        process.environment = env
        return process
    }

    private func startServer() {
        guard let tooling = resolveTooling() else { return }

        let process = childProcess(tooling, [])
        // We open the window ourselves in app mode, so stop the CLI racing us.
        process.environment?["NO_OPEN"] = "1"

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        serverLog = ""

        // stdout and stderr share this pipe and node writes to it for as long
        // as it lives, so it has to keep being drained: a full pipe buffer
        // would block the server mid-request.
        var buffer = Data()
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else {
                // EOF. The handler would otherwise re-fire forever on a
                // readable-at-EOF descriptor — measured at ~1M spins/second.
                handle.readabilityHandler = nil
                return
            }
            // Match on accumulated text, not the raw chunk: a read boundary
            // inside "8377" would otherwise latch a truncated port.
            buffer.append(chunk)
            guard let text = String(data: buffer, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.serverLogged(text) }
        }

        process.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.serverExited(proc) }
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

    /// Called with everything the server has printed so far.
    private func serverLogged(_ text: String) {
        serverLog = text
        guard case .starting(let process) = state, let port = Self.parsePort(text) else { return }
        state = .running(process, port)
        pollUntilReady(port: port, attempts: 40)
    }

    private func serverExited(_ proc: Process) {
        // A late-dying predecessor must not clear the state of its successor.
        guard proc === state.process else { return }
        let log = serverLog
        let status = proc.terminationStatus
        teardownServerPipe()
        state = .stopped
        // Without this, a startup failure — "Build output missing", a bad
        // token, a crash in dist-server — is a menu that blinks and does nothing.
        if status != 0 {
            alert(
                "Server stopped unexpectedly",
                log.isEmpty ? "Exit code \(status)." : log.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    /// The port is printed before the socket is actually listening, so knock
    /// until it answers rather than opening a window onto a connection error.
    private func pollUntilReady(port: Int, attempts: Int) {
        guard attempts > 0 else {
            alert("Server didn't come up", "Nothing answered on port \(port).")
            return
        }
        guard case .running = state, let url = URL(string: "http://127.0.0.1:\(port)/") else { return }

        var request = URLRequest(url: url)
        request.timeoutInterval = 2

        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                guard case .running = self.state else { return }  // stopped while polling
                if response != nil {
                    self.openWindow(port: port)
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
        state = .stopped  // ignore this process's termination callback from here on
        teardownServerPipe()
        process.terminate()
    }

    // MARK: - Gmail re-authentication

    /// Runs `reader-process auth`, which opens a browser and rewrites token.json.
    /// Google expires refresh tokens weekly while the OAuth consent screen is in
    /// Testing mode, so this is a routine chore rather than a one-time setup step.
    @objc private func reauthenticate() {
        // Second click cancels: auth.ts waits on a browser redirect with no
        // timeout, so an abandoned flow would otherwise hang around forever.
        if let running = authProcess, running.isRunning {
            running.terminate()
            authProcess = nil
            refreshMenu()
            return
        }
        guard let tooling = resolveTooling() else { return }

        let process = childProcess(tooling, ["auth"])
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        // Drain incrementally rather than blocking a thread on
        // readDataToEndOfFile, which never returns if run() throws.
        let collected = Collector()
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            collected.append(chunk)
        }

        process.terminationHandler = { [weak self] proc in
            let status = proc.terminationStatus
            let text = collected.text()
            DispatchQueue.main.async {
                guard let self else { return }
                pipe.fileHandleForReading.readabilityHandler = nil
                let cancelled = self.authProcess !== proc
                self.authProcess = nil
                self.refreshMenu()
                if !cancelled { self.authFinished(status: status, output: text) }
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
        // auth.ts writes with mode 0600, but Node ignores `mode` when the file
        // already exists — so an existing token keeps whatever permissions it had.
        // It grants read and send access to the account, so pin it down here.
        var note = ""
        if let path = Self.parseTokenPath(output) {
            do {
                try FileManager.default.setAttributes(
                    [.posixPermissions: 0o600], ofItemAtPath: path)
            } catch {
                note = "\n\nCouldn't restrict permissions on \(path): \(error.localizedDescription)"
            }
        }
        alert("Gmail re-authenticated", "Reload the dashboard to pick it up.\(note)")
    }

    // MARK: - Window

    private func openWindow(port: Int) {
        let url = URL(string: "http://localhost:\(port)/")!

        // --app gives a window with no tab strip or address bar. Ask the
        // workspace where Chrome is rather than assuming /Applications: a
        // per-user install lives under ~/Applications.
        let chrome = NSWorkspace.shared.urlForApplication(
            withBundleIdentifier: "com.google.Chrome")
        guard let chrome else {
            NSWorkspace.shared.open(url)
            return
        }
        let config = NSWorkspace.OpenConfiguration()
        config.arguments = ["--app=\(url.absoluteString)"]
        config.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: chrome, configuration: config) { _, error in
            if error != nil { DispatchQueue.main.async { NSWorkspace.shared.open(url) } }
        }
    }

    // MARK: - Helpers

    /// Accumulates child output across reads; the handler fires on a dispatch
    /// queue, so the buffer needs its own lock.
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
let delegate = MenuApp()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()

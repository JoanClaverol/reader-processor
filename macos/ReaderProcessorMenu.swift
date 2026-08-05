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

final class MenuApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private let statusLine = NSMenuItem(title: "Server: stopped", action: nil, keyEquivalent: "")
    private let stopItem = NSMenuItem(
        title: "Stop server", action: #selector(stopServer), keyEquivalent: "")
    private let authItem = NSMenuItem(
        title: "Re-authenticate Gmail…", action: #selector(reauthenticate), keyEquivalent: "")

    private var server: Process?
    private var port: Int?
    private var starting = false
    private var authenticating = false

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

    func applicationWillTerminate(_ notification: Notification) {
        killServer()
    }

    // MARK: - Menu state

    func menuWillOpen(_ menu: NSMenu) {
        refreshMenu()
    }

    private func refreshMenu() {
        let running = server?.isRunning == true
        if starting {
            statusLine.title = "Server: starting…"
        } else if running, let port {
            statusLine.title = "Server: running :\(port)"
        } else {
            statusLine.title = "Server: stopped"
        }
        stopItem.isEnabled = running
        authItem.title = authenticating ? "Authenticating in browser…" : "Re-authenticate Gmail…"
        authItem.isEnabled = !authenticating
    }

    // MARK: - Actions

    @objc private func openDashboard() {
        if let port, server?.isRunning == true {
            openWindow(port: port)
            return
        }
        guard !starting else { return }
        startServer()
    }

    @objc private func stopServer() {
        killServer()
        refreshMenu()
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
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        process.environment = env
        return process
    }

    private func startServer() {
        guard let tooling = resolveTooling() else { return }

        let process = childProcess(tooling, [])
        // We open the window ourselves in app mode, so stop the CLI racing us.
        process.environment?["NO_OPEN"] = "1"

        // The CLI announces its port on stdout; that's how we learn which one
        // it settled on after probing upward from 8377.
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty, let text = String(data: chunk, encoding: .utf8) else { return }
            guard let found = Self.parsePort(text) else { return }
            DispatchQueue.main.async { self?.serverAnnounced(port: found) }
        }

        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                self?.server = nil
                self?.port = nil
                self?.starting = false
                self?.refreshMenu()
            }
        }

        do {
            try process.run()
        } catch {
            alert("Couldn't start the server", error.localizedDescription)
            return
        }

        server = process
        starting = true
        refreshMenu()
    }

    private func serverAnnounced(port: Int) {
        guard self.port == nil else { return }  // only act on the first announcement
        self.port = port
        pollUntilReady(port: port, attempts: 40)
    }

    /// The port is printed before the socket is actually listening, so knock
    /// until it answers rather than opening a window onto a connection error.
    private func pollUntilReady(port: Int, attempts: Int) {
        guard attempts > 0 else {
            starting = false
            refreshMenu()
            alert("Server didn't come up", "Nothing answered on port \(port).")
            return
        }
        guard let url = URL(string: "http://127.0.0.1:\(port)/") else { return }

        var request = URLRequest(url: url)
        request.timeoutInterval = 2

        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if response != nil {
                    self.starting = false
                    self.refreshMenu()
                    self.openWindow(port: port)
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        self.pollUntilReady(port: port, attempts: attempts - 1)
                    }
                }
            }
        }.resume()
    }

    private func killServer() {
        guard let server, server.isRunning else { return }
        server.terminate()
        self.server = nil
        self.port = nil
        self.starting = false
    }

    // MARK: - Gmail re-authentication

    /// Runs `reader-process auth`, which opens a browser and rewrites token.json.
    /// Google expires refresh tokens weekly while the OAuth consent screen is in
    /// Testing mode, so this is a routine chore rather than a one-time setup step.
    @objc private func reauthenticate() {
        guard !authenticating, let tooling = resolveTooling() else { return }

        let process = childProcess(tooling, ["auth"])
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        // Read to EOF on a background queue; the flow blocks on a human in a browser.
        var output = Data()
        let collected = DispatchGroup()
        collected.enter()
        DispatchQueue.global(qos: .utility).async {
            output = pipe.fileHandleForReading.readDataToEndOfFile()
            collected.leave()
        }

        process.terminationHandler = { proc in
            collected.wait()
            let text = String(data: output, encoding: .utf8) ?? ""
            DispatchQueue.main.async { [weak self] in
                self?.authenticating = false
                self?.refreshMenu()
                self?.authFinished(status: proc.terminationStatus, output: text)
            }
        }

        do {
            try process.run()
        } catch {
            alert("Couldn't start authentication", error.localizedDescription)
            return
        }

        authenticating = true
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

    private static func parseTokenPath(_ text: String) -> String? {
        guard let range = text.range(of: "Token saved to ") else { return nil }
        let rest = text[range.upperBound...]
        let path = rest.prefix(while: { !$0.isNewline }).trimmingCharacters(in: .whitespaces)
        return path.isEmpty ? nil : path
    }

    // MARK: - Window

    private func openWindow(port: Int) {
        let url = "http://localhost:\(port)/"
        let chrome = "/Applications/Google Chrome.app"

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        if FileManager.default.fileExists(atPath: chrome) {
            // --app gives a window with no tab strip or address bar.
            task.arguments = ["-na", "Google Chrome", "--args", "--app=\(url)"]
        } else {
            task.arguments = [url]
        }
        try? task.run()
    }

    // MARK: - Helpers

    private static func parsePort(_ text: String) -> Int? {
        let pattern = "localhost:([0-9]+)"
        guard let regex = try? NSRegularExpression(pattern: pattern),
            let match = regex.firstMatch(
                in: text, range: NSRange(text.startIndex..., in: text)),
            let range = Range(match.range(at: 1), in: text)
        else { return nil }
        return Int(text[range])
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

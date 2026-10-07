// Carafe menu bar — Caffeine-pattern thin shell.
// The app owns NO business logic: it polls `carafe service status` and
// `carafe reflex status`, draws one status item, and shells out to carafe for
// every action. ~300 lines, no dependencies.
import AppKit
import ServiceManagement

// MARK: - Release channel

/// The channel this app was built for (make-app.sh writes CarafeChannel into
/// Info.plist): "stable", or a non-stable channel the menu names itself after.
/// A `swift run` build has no Info.plist and counts as stable.
enum AppChannel {
  static let current: String = (Bundle.main.object(forInfoDictionaryKey: "CarafeChannel") as? String) ?? "stable"
  static var isStable: Bool { current == "stable" }
  /// "Carafe", or "Carafe (channel)".
  static var name: String { isStable ? "Carafe" : "Carafe (\(current))" }
  /// Stable updates come from the latest release; a non-stable channel's
  /// releases are prereleases, never "latest", so its page is the list.
  static var releasesURL: String {
    isStable ? "https://github.com/Carafehq/carafe/releases/latest" : "https://github.com/Carafehq/carafe/releases"
  }
}

// MARK: - carafe CLI bridge

struct CLI {
  /// The carafe this machine's capture service runs, so the menu and the
  /// watcher never disagree about versions: the launchd plist's
  /// ProgramArguments up to `watch` (a compiled binary, or `bun <entry>` in
  /// source mode). "Pause Capture" removes that plist, so the command is
  /// remembered in carafe's state dir and reused while the service is absent;
  /// an installed binary is only ever a last resort for a machine that has
  /// never had a service (on this one it would be a stale alpha).
  static var command: [String] {
    // The app's own carafe (make-app.sh compiles it into the bundle). Nothing
    // it runs lives under ~/Documents, which macOS privacy protection closes
    // to an app until the user grants access; the repo source does.
    if let bundled = bundledCarafe { return [bundled] }
    if let fromService = serviceCommand() {
      if fromService != cached { remember(fromService) }
      cached = fromService
      return fromService
    }
    if let cached { return cached }
    if let remembered = rememberedCommand() { cached = remembered; return remembered }
    let candidates = [
      "\(NSHomeDirectory())/.bun/bin/carafe",
      "\(NSHomeDirectory())/.local/bin/carafe",
      "/opt/homebrew/bin/carafe",
      "/usr/local/bin/carafe",
    ]
    let found = [candidates.first { FileManager.default.isExecutableFile(atPath: $0) } ?? "carafe"]
    cached = found
    return found
  }
  private static var cached: [String]?
  /// The app's carafe for this machine's architecture (make-app.sh compiles one
  /// per architecture; a universal app carries both).
  static let bundledCarafe: String? = {
    #if arch(arm64)
    let names = ["carafe-arm64", "carafe"]
    #else
    let names = ["carafe-x64", "carafe"]
    #endif
    for name in names {
      let path = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/\(name)").path
      if FileManager.default.isExecutableFile(atPath: path) { return path }
    }
    return nil
  }()
  /// `carafe --version` of whatever the menu drives, read once.
  static let version: String = {
    let r = run(["--version"])
    return r.code == 0 ? r.out.trimmingCharacters(in: .whitespacesAndNewlines) : "carafe (version unknown)"
  }()
  static let stateDir = "\(NSHomeDirectory())/.carafe/state"
  static let memoryPath = "\(stateDir)/menubar-carafe.json"
  static let logPath = "\(stateDir)/menubar.log"
  /// The last `service status` output, for the alert when a toggle does not settle.
  static var lastStatus = ""

  /// A one-line description for the menu: bundled, dev source, or an installed binary, with its version.
  static var describe: String {
    let c = command
    let what = bundledCarafe != nil ? "bundled" : c.count > 1 ? "dev source (\(c.last.map { ($0 as NSString).lastPathComponent } ?? "?"))" : c[0]
    return "\(what) · \(version)"
  }

  /// The capture service's command as written in its launchd plist, whether or
  /// not that binary still exists (healService needs the stale case).
  static func servicePlistCommand() -> [String]? {
    let plist = "\(NSHomeDirectory())/Library/LaunchAgents/com.carafe.watch.plist"
    guard let data = FileManager.default.contents(atPath: plist),
          let object = try? PropertyListSerialization.propertyList(from: data, format: nil),
          let dict = object as? [String: Any],
          let args = dict["ProgramArguments"] as? [String],
          let watch = args.firstIndex(of: "watch"), watch > 0 else { return nil }
    return Array(args[0..<watch])
  }

  static func serviceCommand() -> [String]? {
    guard let head = servicePlistCommand(), FileManager.default.isExecutableFile(atPath: head[0]) else { return nil }
    return head
  }

  private static func remember(_ command: [String]) {
    try? FileManager.default.createDirectory(atPath: stateDir, withIntermediateDirectories: true)
    if let data = try? JSONSerialization.data(withJSONObject: command) {
      try? data.write(to: URL(fileURLWithPath: memoryPath), options: .atomic)
    }
  }

  private static func rememberedCommand() -> [String]? {
    guard let data = FileManager.default.contents(atPath: memoryPath),
          let list = try? JSONSerialization.jsonObject(with: data) as? [String],
          let first = list.first, FileManager.default.isExecutableFile(atPath: first) else { return nil }
    return list
  }

  /// Every command the app runs, with its exit code and output: the record
  /// for "I clicked it and nothing happened". Kept small.
  static func log(_ line: String) {
    try? FileManager.default.createDirectory(atPath: stateDir, withIntermediateDirectories: true)
    let stamp = ISO8601DateFormatter().string(from: Date())
    var text = (try? String(contentsOfFile: logPath, encoding: .utf8)) ?? ""
    if text.count > 200_000 { text = String(text.suffix(100_000)) }
    text += "\(stamp) \(line)\n"
    try? text.write(toFile: logPath, atomically: true, encoding: .utf8)
  }

  @discardableResult
  static func run(_ args: [String]) -> (code: Int32, out: String) {
    let c = command
    let started = Date()
    let p = Process()
    p.executableURL = URL(fileURLWithPath: c[0])
    p.arguments = Array(c.dropFirst()) + args
    var env = ProcessInfo.processInfo.environment
    env["CARAFE_NO_UPDATE_CHECK"] = "1"
    p.environment = env
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    do { try p.run() } catch {
      log("\(args.joined(separator: " ")) → could not launch \(c[0]): \(error)")
      return (127, "\(error)")
    }
    // Read before waiting: a child that fills the pipe would otherwise never exit.
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    let out = String(data: data, encoding: .utf8) ?? ""
    let ms = Int(Date().timeIntervalSince(started) * 1000)
    // Routine polls (health, reflex state, the session list) are logged only
    // when they fail; everything else is logged always.
    let routine = (args == ["service", "status"]) || (args == ["reflex", "status"]) || args.first == "list"
      || (args.starts(with: ["service", "watchdog"]) && !out.contains("auto restart: done") && !out.contains("auto restart: failed"))
    if !routine || p.terminationStatus != 0 {
      log("\(args.joined(separator: " ")) → exit \(p.terminationStatus) in \(ms)ms: \(out.replacingOccurrences(of: "\n", with: " | ").prefix(400))")
    }
    return (p.terminationStatus, out)
  }

  /// Fire-and-forget for slow commands (update, handoff) so the menu never blocks.
  static func runDetached(_ args: [String], done: @escaping (Int32, String) -> Void) {
    DispatchQueue.global(qos: .userInitiated).async {
      let r = run(args)
      DispatchQueue.main.async { done(r.code, r.out) }
    }
  }
}

/// `key: value` lines are the contract with the CLI; everything else is prose.
func value(of key: String, in out: String) -> String? {
  for line in out.split(separator: "\n") where line.hasPrefix(key + ":") {
    return line.dropFirst(key.count + 1).trimmingCharacters(in: .whitespaces)
  }
  return nil
}

func leadingInt(_ s: String?) -> Int? {
  guard let s else { return nil }
  let digits = s.prefix { $0.isNumber }
  return Int(digits)
}

// MARK: - Capture health

enum CaptureHealth {
  case capturing(indexing: Int?) // service running, lock held; indexing = sessions still queued (nil = unknown)
  case building(String, Int?)    // one big index build in progress (title, queued after it)
  case catchingUp(String)        // started recently: capturing first, then the backlog a restart owes (detail line)
  case degraded(String)          // service present but not running / lock dead / watcher stalled
  case stopped                   // no service installed
  case pending(starting: Bool)   // Start/Pause clicked; waiting for the service to confirm

  /// A watcher that has not ticked for this long is stalled even if its pid lives;
  /// a build in progress is allowed much longer (a 50K-event session takes minutes).
  static let stallSeconds = 300
  static let buildStallSeconds = 900

  static func probe() -> CaptureHealth {
    let r = CLI.run(["service", "status"])
    CLI.lastStatus = r.out
    guard r.code == 0 else { return .stopped }
    let out = r.out
    let running = value(of: "service running", in: out) == "yes"
    let lockAlive = value(of: "watch lock", in: out)?.contains("alive") ?? false
    if running && lockAlive {
      // Right after a restart "last tick" can be old (the first import on a
      // loaded Mac) and the backlog large: the watcher says so itself, and its
      // heartbeat — judged by `service watchdog` — is what tells stuck apart.
      if let startup = value(of: "startup", in: out) {
        return .catchingUp(startup.replacingOccurrences(of: "starting up — ", with: ""))
      }
      let backlog = value(of: "index backlog", in: out)
      let queued: Int? = backlog == "none" ? 0 : leadingInt(backlog)
      let age = leadingInt(value(of: "last tick", in: out))
      if let busy = value(of: "indexing now", in: out) {
        if let age, age > buildStallSeconds { return .degraded("watcher stalled — last tick \(age)s ago") }
        let title = busy.components(separatedBy: " (").first ?? busy
        return .building(title, queued)
      }
      if let age, age > stallSeconds {
        return .degraded("watcher stalled — last tick \(age)s ago")
      }
      return .capturing(indexing: queued)
    }
    if value(of: "service file", in: out)?.hasPrefix("present") ?? false {
      return .degraded(running ? "watcher has no live lock" : "service not running")
    }
    return .stopped
  }

  var symbolName: String {
    switch self {
    case .capturing, .building, .catchingUp: return "cup.and.saucer.fill"
    case .degraded: return "cup.and.saucer"
    case .stopped: return "exclamationmark.circle"
    case .pending(let starting): return starting ? "cup.and.saucer.fill" : "cup.and.saucer"
    }
  }

  var statusLine: String {
    switch self {
    case .capturing(let indexing):
      if let n = indexing, n > 0 { return "Capturing · indexing \(n) session\(n == 1 ? "" : "s") left" }
      if indexing == 0 { return "Capturing · indexes current" }
      return "Capturing — store is live"
    case .building(let title, let queued):
      let rest = queued.map { $0 > 0 ? " · \($0) more queued" : "" } ?? ""
      return "Capturing · indexing “\(title)”\(rest)"
    case .catchingUp: return "Catching up after restart…"
    case .degraded(let why): return "Capture degraded — \(why)"
    case .stopped: return "Capture is OFF"
    case .pending(let starting): return starting ? "Starting capture…" : "Pausing capture…"
    }
  }
}

// MARK: - Watchdog outside the watcher (FIX 2) and protected folders (FIX 1)

/// What `carafe service watchdog --auto-restart` judged from the watcher's
/// heartbeat file. The decision (stale? restart? at most once per 30 min, never
/// while a permission prompt is pending) is the CLI's, tested there; the app
/// only runs it every 60 s and shows the lines it printed.
struct WatcherCheck {
  var stuck = false
  var stuckLine: String?
  var causeLine: String?
  var permissionPrompt = false
  var deniedFolders: [String] = []

  static func probe() -> WatcherCheck {
    let r = CLI.run(["service", "watchdog", "--auto-restart"])
    guard r.code == 0 else { return WatcherCheck() }
    let cause = value(of: "likely cause", in: r.out)
    let denied = value(of: "denied folders", in: r.out) ?? "none"
    return WatcherCheck(
      stuck: value(of: "watcher", in: r.out) == "stuck",
      stuckLine: value(of: "stuck", in: r.out),
      causeLine: cause.map { "Likely: \($0)" },
      permissionPrompt: cause?.hasPrefix("waiting for a macOS permission prompt") ?? false,
      deniedFolders: denied == "none" ? [] : denied.components(separatedBy: ", "))
  }
}

enum ProtectedFolders {
  /// System Settings → Privacy & Security → Files and Folders.
  static let privacyURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")!

  /// `~/Documents` → "Documents", for the menu.
  static func name(_ folder: String) -> String { (folder as NSString).lastPathComponent }

  /// The protected folders holding session directories, as the bundled carafe
  /// lists them from its store (read-only; it opens nothing under them).
  static func needed() -> [String] {
    let r = CLI.run(["doctor", "--protected-folders"])
    guard r.code == 0 else { return [] }
    return r.out.split(separator: "\n").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { $0.hasPrefix("/") }
  }

  /// Opens (lists) each folder from THIS process. The first time, macOS shows
  /// its permission prompt and this call waits for the answer, which is why it
  /// runs right after the app's own explanation and off the main thread.
  /// Returns the folders that were refused.
  static func touch(_ folders: [String]) -> [String] {
    folders.filter { folder in
      do { _ = try FileManager.default.contentsOfDirectory(atPath: folder); return false } catch {
        let code = (error as NSError).code
        CLI.log("touch \(folder) → \(error.localizedDescription)")
        // NSFileReadNoPermissionError (257): the user said Don't Allow, or did so earlier.
        return code == NSFileReadNoPermissionError
      }
    }
  }
}

// MARK: - Prompt reflex (the UserPromptSubmit hooks for Claude Code and Codex)

struct ReflexState {
  var claude = false
  var codex = false
  var known = false

  static func probe() -> ReflexState {
    let r = CLI.run(["reflex", "status"])
    guard r.code == 0 else { return ReflexState() }
    return ReflexState(
      claude: value(of: "Claude Code hook", in: r.out) == "installed",
      codex: value(of: "Codex hook", in: r.out) == "installed",
      known: true)
  }

  var both: Bool { claude && codex }
  var any: Bool { claude || codex }
  var line: String {
    if !known { return "Prompt reflex: unknown" }
    if both { return "Prompt reflex: on (Claude Code + Codex)" }
    if claude { return "Prompt reflex: Claude Code only" }
    if codex { return "Prompt reflex: Codex only" }
    return "Prompt reflex: off"
  }
}

// MARK: - The Carafe mark (design 2a, "Coffee fill · bare": the server, filling with coffee)

enum CarafeMark {
  /// The server silhouette from the design project's CarafeMark component
  /// (viewBox 0 0 128 128): the body and the handle's hole, even-odd. Drawn
  /// natively so the status item is crisp at any scale and the coffee level can
  /// say whether capture is running.
  static let serverPathData = "M35.19 16.71 L85.27 16.83 L85.89 17.2 L85.89 18.19 L85.39 19.18 L84.4 26.1 L84.4 27.34 L85.02 27.96 L107.03 27.96 L110.24 28.7 L111.6 30.06 L120.01 61.71 L121 68.14 L120.75 71.36 L120.01 73.58 L118.77 75.56 L115.44 78.65 L109.5 82.36 L100.85 86.57 L99.98 87.43 L99.98 89.41 L100.72 91.88 L100.48 96.33 L95.78 105.73 L93.18 108.82 L89.22 110.55 L83.78 111.29 L23.2 111.29 L19.24 110.8 L15.28 109.32 L12.69 106.97 L11.7 105.48 L7.74 97.82 L7 95.34 L7 91.39 L21.84 40.45 L22.58 36.74 L22.33 32.53 L21.1 29.32 L17.63 24.87 L14.67 21.9 L14.67 21.4 L16.03 20.29 L23.2 17.08 L35.19 16.71 Z M101.71 32.53 L104.8 32.41 L106.78 32.9 L108.64 35.5 L115.81 62.7 L116.55 66.16 L116.55 69.38 L115.31 72.1 L112.72 74.7 L106.04 78.4 L99.11 81.62 L98.37 81.62 L97.01 79.02 L89.59 53.3 L85.64 38.47 L84.9 34.02 L85.51 33.4 L101.71 32.53 Z"
  static let top: CGFloat = 16.71
  static let bottom: CGFloat = 111.29
  /// The design's static fill (its rect starts at y = 38 of 128).
  static let idleLevel: CGFloat = 0.78
  static let strokeWidth: CGFloat = 4.8

  /// The subpaths of `serverPathData`: [0] the body, [1] the handle's hole.
  static let subpaths: [NSBezierPath] = {
    var paths: [NSBezierPath] = []
    var current = NSBezierPath()
    var command: Character = "M"
    var pending: [CGFloat] = []
    for raw in serverPathData.split(separator: " ") {
      var token = Substring(raw)
      if let first = token.first, first.isLetter {
        command = first
        token = token.dropFirst()
        if command == "Z" { current.close(); paths.append(current); current = NSBezierPath(); continue }
      }
      guard let value = Double(token) else { continue }
      pending.append(CGFloat(value))
      if pending.count == 2 {
        let point = NSPoint(x: pending[0], y: pending[1])
        if command == "M" { current.move(to: point) } else { current.line(to: point) }
        pending.removeAll()
      }
    }
    if !current.isEmpty { paths.append(current) }
    return paths
  }()

  /// Body and hole together, even-odd: the shape the coffee is clipped to.
  static let serverPath: NSBezierPath = {
    let path = NSBezierPath()
    for sub in subpaths { path.append(sub) }
    path.windingRule = .evenOdd
    return path
  }()

  /// The lines the mark is drawn with. The design strokes both edges of the
  /// handle's 4.4-unit wall; at menu bar sizes those two strokes merge into one
  /// band and its diagonal curve antialiases lighter than the body's vertical
  /// lines, so the handle read thinner than the rest. Instead: the body's
  /// outline follows its own right wall (the hole's left edge), and the handle
  /// is one open line down the centre of its wall, so every line on the mark
  /// has exactly the same width. The coffee still fills the design's silhouette.
  static let bodyOutline: [NSPoint] = [
    (35.19, 16.71), (85.27, 16.83), (85.89, 17.2), (85.89, 18.19), (85.39, 19.18), (84.4, 26.1), (84.4, 27.34), (85.02, 27.96),
    (85.51, 33.4), (84.9, 34.02), (85.64, 38.47), (89.59, 53.3), (97.01, 79.02), (98.37, 81.62), (99.11, 81.62),
    (99.98, 87.43), (99.98, 89.41), (100.72, 91.88), (100.48, 96.33), (95.78, 105.73), (93.18, 108.82), (89.22, 110.55),
    (83.78, 111.29), (23.2, 111.29), (19.24, 110.8), (15.28, 109.32), (12.69, 106.97), (11.7, 105.48), (7.74, 97.82),
    (7, 95.34), (7, 91.39), (21.84, 40.45), (22.58, 36.74), (22.33, 32.53), (21.1, 29.32), (17.63, 24.87), (14.67, 21.9),
    (14.67, 21.4), (16.03, 20.29), (23.2, 17.08),
  ].map { NSPoint(x: $0.0, y: $0.1) }
  static let handleCentre: [NSPoint] = [
    (86.5, 30.2), (107.5, 30.4), (110.0, 31.8), (117.9, 62.2), (118.8, 67.2), (118.5, 70.4), (117.7, 72.8),
    (115.7, 75.1), (110.7, 78.5), (104.3, 80.4), (100.5, 83.5),
  ].map { NSPoint(x: $0.0, y: $0.1) }

  static func polyline(_ points: [NSPoint], closed: Bool) -> NSBezierPath {
    let path = NSBezierPath()
    for (index, point) in points.enumerated() { if index == 0 { path.move(to: point) } else { path.line(to: point) } }
    if closed { path.close() }
    return path
  }

  /// A template image of the server at `size` points with coffee up to `level` (0…1).
  static func image(level: CGFloat, size: CGFloat = 18) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size), flipped: true) { _ in
      guard let context = NSGraphicsContext.current?.cgContext else { return false }
      let scale = size / 128
      context.scaleBy(x: scale, y: scale)
      NSColor.black.set()
      // Coffee: the design's silhouette (body and handle wall, hole cut out), even-odd.
      NSGraphicsContext.saveGraphicsState()
      (serverPath.copy() as! NSBezierPath).addClip()
      let surface = bottom - max(0, min(1, level)) * (bottom - top)
      NSBezierPath(rect: NSRect(x: 0, y: surface, width: 128, height: 128)).fill()
      NSGraphicsContext.restoreGraphicsState()
      // Lines: the design's 4.8 units, or 1 pt when that would be thinner (a
      // 1x display then gets a whole pixel). The handle is mostly diagonal and a
      // diagonal line spreads its ink over more pixels than a vertical one, so
      // it is drawn 12% heavier to read as the same weight as the body.
      let width = max(strokeWidth, 1.0 / scale)
      for (path, lineWidth) in [(polyline(bodyOutline, closed: true), width), (polyline(handleCentre, closed: false), width * 1.12)] {
        path.lineWidth = lineWidth
        path.lineJoinStyle = .round
        path.lineCapStyle = .round
        path.stroke()
      }
      return true
    }
    image.isTemplate = true
    return image
  }

  /// The carafe brewing, for the handoff window: a dripper above the opening and coffee
  /// dripping into the carafe, which holds coffee up to `level`. `time` (seconds) moves the
  /// drops; `dripping: false` draws the dripper with no drops (the coffee is ready).
  /// Drawn on a 128 x 174 canvas: the dripper in the top 46 units, the carafe below.
  static let brewHeadroom: CGFloat = 46
  static func brewingImage(level: CGFloat, time: TimeInterval, dripping: Bool, width: CGFloat) -> NSImage {
    let scale = width / 128
    let size = NSSize(width: width, height: (128 + brewHeadroom) * scale)
    let mark = image(level: level, size: width)
    let picture = NSImage(size: size, flipped: true) { _ in
      guard let context = NSGraphicsContext.current?.cgContext else { return false }
      mark.draw(in: NSRect(x: 0, y: brewHeadroom * scale, width: width, height: width))
      context.scaleBy(x: scale, y: scale)
      NSColor.black.set()
      // The dripper, sized like a real pour-over on its carafe: a cone as wide as most of the
      // body, on a base plate that rests on the rim. Centred on the body, not on the whole mark:
      // the rim spans x 14.7…85.9 and the base 7…100.7, so the body's centre line is x ≈ 52
      // (the handle, out to x 120, is not part of it).
      let cx: CGFloat = 52
      let line = max(strokeWidth, 1.0 / scale)
      let cone = NSBezierPath()
      cone.move(to: NSPoint(x: cx - 38, y: 6)); cone.line(to: NSPoint(x: cx + 38, y: 6))
      cone.line(to: NSPoint(x: cx + 10, y: 52)); cone.line(to: NSPoint(x: cx - 10, y: 52)); cone.close()
      let plate = NSBezierPath()
      plate.move(to: NSPoint(x: cx - 30, y: 60)); plate.line(to: NSPoint(x: cx + 30, y: 60))
      let neck = NSBezierPath()
      neck.move(to: NSPoint(x: cx - 6, y: 52)); neck.line(to: NSPoint(x: cx - 6, y: 60))
      neck.move(to: NSPoint(x: cx + 6, y: 52)); neck.line(to: NSPoint(x: cx + 6, y: 60))
      for path in [cone, plate, neck] {
        path.lineWidth = line
        path.lineJoinStyle = .round
        path.lineCapStyle = .round
        path.stroke()
      }
      guard dripping else { return true }
      // Three drops, a third of a cycle apart, falling from the dripper's tip to the surface.
      let surface = brewHeadroom + bottom - max(0, min(1, level)) * (bottom - top)
      let start: CGFloat = 58, fall = max(8, surface - start)
      for k in 0..<3 {
        let phase = (time / 0.9 + Double(k) / 3).truncatingRemainder(dividingBy: 1)
        let y = start + CGFloat(phase * phase) * fall   // accelerating, like a falling drop
        let r: CGFloat = 4.2
        NSBezierPath(ovalIn: NSRect(x: cx - r, y: y - r * 1.4, width: r * 2, height: r * 2.8)).fill()
      }
      return true
    }
    picture.isTemplate = true
    return picture
  }

  /// PNG bytes of the mark, for `--render-icons DIR` (a way to look at the icon
  /// without a screen) and for the icon script.
  static func png(level: CGFloat, size: CGFloat) -> Data? {
    let image = self.image(level: level, size: size)
    guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
    return rep.representation(using: .png, properties: [:])
  }
}

// MARK: - Recent sessions, for the hand-off picker

extension HandoffSource {
  static func probe(limit: Int = 12) -> [HandoffSource] {
    let result = CLI.run(["list", "--sources", "--json", "--interactive", "--limit", "\(limit)"])
    guard result.code == 0, let data = result.out.data(using: .utf8) else { return [] }
    return decode(data) ?? []
  }
}

// MARK: - App delegate (the Caffeine pattern: status item, no windows, no dock)

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private var statusItem: NSStatusItem!
  private var health: CaptureHealth = .stopped
  private var reflex = ReflexState()
  private var sources: [HandoffSource] = []
  /// Session rows live in the menu for as long as it exists; an age label
  /// computed at build time is stale by the time the menu is opened.
  private var handoffEntries: [(item: NSMenuItem, row: SessionRow)] = []
  private var timer: Timer?
  private var watchdogTimer: Timer?
  private var watcher = WatcherCheck()
  /// Protected folders the app itself was refused when it asked (FIX 1).
  private var appDenied: [String] = []

  func applicationDidFinishLaunching(_: Notification) {
    NSApp.setActivationPolicy(.accessory) // menu-bar only: no dock icon, no cmd-tab

    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    setIcon(CaptureHealth.stopped)

    refreshHealth()
    firstLaunchFlow()
    // Common modes: the poll keeps firing while the menu is open (menu tracking
    // leaves the default run-loop mode).
    let poll = Timer(timeInterval: 15, repeats: true) { [weak self] _ in self?.refreshHealth() }
    RunLoop.main.add(poll, forMode: .common)
    timer = poll
    // The watcher's own watchdog cannot fire while its thread is blocked in the
    // kernel (a pending permission prompt); this one runs in another process.
    let dog = Timer(timeInterval: 60, repeats: true) { [weak self] _ in self?.checkWatcher() }
    RunLoop.main.add(dog, forMode: .common)
    watchdogTimer = dog
    rebuildMenu()
  }

  private var settling = false

  private func refreshHealth() {
    DispatchQueue.global(qos: .utility).async { [weak self] in
      let h = CaptureHealth.probe()
      let r = ReflexState.probe()
      let list = HandoffSource.probe()
      DispatchQueue.main.async {
        guard let self, !self.settling else { return } // a Start/Pause in flight owns the display
        self.sources = list
        self.apply(h, r)
      }
    }
  }

  private func checkWatcher() {
    DispatchQueue.global(qos: .utility).async { [weak self] in
      let check = WatcherCheck.probe()
      DispatchQueue.main.async {
        guard let self else { return }
        self.watcher = check
        self.rebuildMenu()
      }
    }
  }

  private func apply(_ h: CaptureHealth, _ r: ReflexState) {
    health = h
    reflex = r
    setIcon(h)
    rebuildMenu()
  }

  /// Two states, decided with the owner on the rendered preview: the mark mostly
  /// full (the design's static level) while capture is running, and the empty
  /// outline whenever it is not: no service, service not running, no live
  /// watcher lock, or a watcher that stopped ticking. The tooltip and the menu
  /// status line say which. The moment capture becomes running the carafe
  /// fills up from empty (the design's brewing motion, once), whether Start
  /// was clicked or the app found capture already running at launch.
  private var displayedLevel: CGFloat = 0
  private var fillTimer: Timer?
  /// The session whose handoff is being prepared (a handoff takes seconds on a big session).
  private var preparing: String?
  private var pourTimer: Timer?

  private func setIcon(_ h: CaptureHealth) {
    guard let button = statusItem.button else { return }
    if let preparing { button.toolTip = "Preparing handoff — \(preparing)…"; return }
    button.title = ""
    button.toolTip = AppChannel.isStable ? h.statusLine : "\(AppChannel.name) — \(h.statusLine)"
    button.appearsDisabled = false
    let target: CGFloat
    switch h {
    case .capturing, .building, .catchingUp: target = CarafeMark.idleLevel
    case .degraded, .stopped: target = 0
    case .pending(let starting): target = starting ? 0 : 0 // empty while starting: it fills when confirmed
    }
    if target > displayedLevel && displayedLevel == 0 {
      animateFill(to: target)
    } else {
      cancelFill()
      displayedLevel = target
      button.image = CarafeMark.image(level: target)
    }
  }

  /// One fill from empty to `target`, 1.4 s, eased in and out, ~30 fps. A new
  /// state arriving mid-fill snaps to that state.
  private func animateFill(to target: CGFloat) {
    cancelFill()
    let started = Date()
    let duration: TimeInterval = 1.4
    let timer = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] timer in
      guard let self else { timer.invalidate(); return }
      let t = min(1, Date().timeIntervalSince(started) / duration)
      let eased = t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2
      self.displayedLevel = target * CGFloat(eased)
      self.statusItem.button?.image = CarafeMark.image(level: self.displayedLevel)
      if t >= 1 { timer.invalidate(); self.fillTimer = nil }
    }
    RunLoop.main.add(timer, forMode: .common)
    fillTimer = timer
    timer.fire()
  }

  private func cancelFill() {
    fillTimer?.invalidate()
    fillTimer = nil
  }

  /// While a handoff is prepared the carafe fills and empties, ~1.6 s a cycle, until it is ready.
  private func startPouring(_ title: String) {
    cancelFill()
    pourTimer?.invalidate()
    preparing = title
    statusItem.button?.toolTip = "Preparing handoff — \(title)…"
    let started = Date()
    let timer = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
      guard let self else { return }
      let phase = Date().timeIntervalSince(started).truncatingRemainder(dividingBy: 1.6) / 1.6
      let level = CGFloat(0.5 - 0.5 * cos(phase * 2 * .pi))
      self.statusItem.button?.image = CarafeMark.image(level: level)
    }
    RunLoop.main.add(timer, forMode: .common)
    pourTimer = timer
    rebuildMenu()
  }

  private func stopPouring() {
    pourTimer?.invalidate()
    pourTimer = nil
    preparing = nil
    displayedLevel = 0
    setIcon(health)
    rebuildMenu()
  }

  private func rebuildMenu() {
    let menu = NSMenu()
    menu.delegate = self
    handoffEntries = []

    if !AppChannel.isStable {
      let channel = NSMenuItem(title: AppChannel.name, action: nil, keyEquivalent: "")
      channel.isEnabled = false
      menu.addItem(channel)
    }
    let status = NSMenuItem(title: health.statusLine, action: nil, keyEquivalent: "")
    status.isEnabled = false
    menu.addItem(status)
    if case .catchingUp(let detail) = health, !detail.isEmpty {
      let line = NSMenuItem(title: detail.prefix(1).uppercased() + detail.dropFirst(), action: nil, keyEquivalent: "")
      line.isEnabled = false
      menu.addItem(line)
    }
    let reflexLine = NSMenuItem(title: reflex.line, action: nil, keyEquivalent: "")
    reflexLine.isEnabled = false
    menu.addItem(reflexLine)
    let which = NSMenuItem(title: "carafe: \(CLI.describe)", action: nil, keyEquivalent: "")
    which.isEnabled = false
    menu.addItem(which)
    addAttentionItems(to: menu)
    menu.addItem(.separator())

    menu.addItem(item("Open Carafe", #selector(openUI), key: "o"))
    if let preparing {
      let line = NSMenuItem(title: "Preparing handoff — \(preparing)…", action: nil, keyEquivalent: "")
      line.isEnabled = false
      menu.addItem(line)
      let busy = NSMenuItem(title: "Hand Off", action: nil, keyEquivalent: "")
      busy.isEnabled = false
      menu.addItem(busy)
    } else {
      let handoff = HandoffMenu.build(sources: sources, target: self, action: #selector(handoffPicked(_:)))
      handoffEntries = handoff.entries
      menu.addItem(handoff.item)
    }
    menu.addItem(.separator())

    switch health {
    case .capturing, .building, .catchingUp, .degraded:
      menu.addItem(item("Pause Capture", #selector(disableCapture)))
    case .stopped:
      menu.addItem(item("Start Capture", #selector(enableCapture)))
    case .pending(let starting):
      let waiting = item(starting ? "Starting…" : "Pausing…", #selector(noop))
      waiting.isEnabled = false
      menu.addItem(waiting)
    }
    if reflex.both {
      menu.addItem(item("Disable Prompt Reflex", #selector(disableReflex)))
    } else {
      menu.addItem(item("Enable Prompt Reflex (Claude Code + Codex)", #selector(enableReflex)))
    }
    // Login Items only accept a bundled .app (make-app.sh); under `swift run`
    // the item is shown disabled so the reason is visible.
    let login = item("Launch at Login", #selector(toggleLaunchAtLogin))
    login.state = launchAtLogin ? .on : .off
    login.isEnabled = bundled
    menu.addItem(login)
    menu.addItem(item("Check for Updates", #selector(update)))
    menu.addItem(.separator())
    menu.addItem(item("Quit \(AppChannel.name) Menu Bar", #selector(quit), key: "q"))

    statusItem.menu = menu
  }

  /// A stuck watcher and refused folders, each with the one action that helps.
  private func addAttentionItems(to menu: NSMenu) {
    var privacy = false
    if watcher.stuck {
      menu.addItem(.separator())
      let line = NSMenuItem(title: watcher.stuckLine ?? "Carafe's watcher is stuck", action: nil, keyEquivalent: "")
      line.isEnabled = false
      menu.addItem(line)
      if let cause = watcher.causeLine {
        let why = NSMenuItem(title: cause, action: nil, keyEquivalent: "")
        why.isEnabled = false
        menu.addItem(why)
      }
      menu.addItem(item("Restart Watcher", #selector(restartWatcher)))
      privacy = watcher.permissionPrompt
    }
    let denied = Array(Set((watcher.deniedFolders + appDenied).map(ProtectedFolders.name))).sorted()
    if !denied.isEmpty {
      if !watcher.stuck { menu.addItem(.separator()) }
      for name in denied {
        let line = NSMenuItem(title: "No access to \(name) — sessions there are skipped", action: nil, keyEquivalent: "")
        line.isEnabled = false
        menu.addItem(line)
      }
      privacy = true
    }
    if privacy { menu.addItem(item("Open Privacy Settings…", #selector(openPrivacySettings))) }
  }

  @objc private func openPrivacySettings() { NSWorkspace.shared.open(ProtectedFolders.privacyURL) }

  /// `carafe service restart` (kickstart -k, or bootstrap when launchd dropped
  /// the service). A click is the user's decision,
  /// so it is not rate-limited the way the automatic restart is.
  @objc private func restartWatcher() {
    CLI.runDetached(["service", "restart"]) { code, out in
      if code != 0 { self.notify("Watcher not restarted", body: out.trimmingCharacters(in: .whitespacesAndNewlines)) }
      self.watcher = WatcherCheck()
      self.refreshHealth()
      self.rebuildMenu()
    }
  }

  private func item(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
    let it = NSMenuItem(title: title, action: action, keyEquivalent: key)
    it.target = self
    return it
  }

  // MARK: actions — every one is a carafe CLI call

  @objc private func openUI() {
    // If the UI server answers, open it; otherwise start it detached first.
    let url = URL(string: "http://localhost:4319")!
    var request = URLRequest(url: url)
    request.timeoutInterval = 1
    URLSession.shared.dataTask(with: request) { _, response, _ in
      DispatchQueue.main.async {
        if (response as? HTTPURLResponse) != nil {
          NSWorkspace.shared.open(url)
        } else {
          let p = Process()
          p.executableURL = URL(fileURLWithPath: CLI.command[0])
          p.arguments = Array(CLI.command.dropFirst()) + ["ui", "--port", "4319"]
          try? p.run() // carafe ui opens the browser itself once serving
        }
      }
    }.resume()
  }

  /// The menu is built on a 15s poll but may sit unopened for an hour. Recompute
  /// every age label the moment it opens, so "just now" is never a lie.
  func menuWillOpen(_ menu: NSMenu) {
    let now = Date()
    for entry in handoffEntries {
      entry.item.title = (entry.row.isActive(now: now) ? "● " : "") + entry.row.label(now: now)
    }
  }

  @objc private func handoffPicked(_ sender: NSMenuItem) {
    guard let pick = sender.representedObject as? [String: String], let id = pick["id"] else { return }
    handoff(id: id, title: pick["title"] ?? id)
  }

  private var handoffPanel: HandoffPanel?

  /// One window from click to result: it opens at once with a spinner and becomes the
  /// ready (or failed) message. Closing it while it is still preparing only hides it:
  /// the handoff finishes and the result window comes back.
  private func handoff(id: String, title: String) {
    guard preparing == nil else { return }
    let name = title.isEmpty ? id : title
    startPouring(name)
    let panel = HandoffPanel(session: name)
    handoffPanel = panel
    panel.show()
    CLI.runDetached(["handoff", id]) { code, out in
      self.stopPouring()
      let release: () -> Void = { [weak self] in self?.handoffPanel = nil }
      if code == 0, let path = HandoffMenu.filePath(output: out) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(HandoffMenu.statement(path: path), forType: .string)
        panel.finish(title: "Handoff ready — continue-statement copied",
                     body: HandoffMenu.notification(title: name), onClose: release)
      } else {
        let said = out.trimmingCharacters(in: .whitespacesAndNewlines)
        panel.finish(title: "Handoff failed",
                     body: said.isEmpty ? "Run `carafe handoff \(id)` in a terminal to see why." : String(said.suffix(600)), onClose: release)
      }
    }
  }

  @objc private func noop() {}
  @objc private func enableCapture() { toggleCapture(starting: true) }
  @objc private func disableCapture() { toggleCapture(starting: false) }

  /// `carafe service enable|disable`, shown as it happens: the icon takes the
  /// target state at once with "Starting capture…" / "Pausing capture…", the
  /// service is polled every second until it confirms (the watcher takes its
  /// lock a few seconds after launchd starts it), and if it never does within
  /// 15 s the alert says what carafe reported. A failed command is shown in
  /// carafe's own words.
  private func toggleCapture(starting: Bool) {
    settling = true
    apply(.pending(starting: starting), reflex)
    CLI.runDetached(["service", starting ? "enable" : "disable"]) { code, out in
      if code != 0 {
        self.settling = false
        self.notify(starting ? "Capture not started" : "Capture not paused", body: out.trimmingCharacters(in: .whitespacesAndNewlines))
        self.refreshHealth()
        return
      }
      self.settle(starting: starting, attempts: 15)
    }
  }

  private func settle(starting: Bool, attempts: Int) {
    DispatchQueue.global(qos: .utility).async { [weak self] in
      let h = CaptureHealth.probe()
      let r = ReflexState.probe()
      DispatchQueue.main.async {
        guard let self else { return }
        let arrived: Bool
        switch h {
        case .capturing, .building, .catchingUp: arrived = starting
        case .stopped: arrived = !starting
        case .degraded, .pending: arrived = false
        }
        if arrived || attempts <= 1 {
          self.settling = false
          self.apply(h, r)
          if !arrived {
            CLI.log("toggle \(starting ? "enable" : "disable") did not settle: \(h.statusLine)")
            self.notify(starting ? "Capture did not start" : "Capture did not pause",
                        body: "\(h.statusLine)\n\ncarafe service status said:\n\(CLI.lastStatus.trimmingCharacters(in: .whitespacesAndNewlines))")
          }
        } else {
          DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.settle(starting: starting, attempts: attempts - 1) }
        }
      }
    }
  }

  /// Installs the UserPromptSubmit hook for both tools. carafe prints where it
  /// wrote and, for Codex, that the hook must be trusted via /hooks before it
  /// runs; that text is shown as-is, because carafe cannot do that step.
  @objc private func enableReflex() {
    CLI.runDetached(["reflex", "install"]) { code, out in
      self.notify(code == 0 ? "Prompt reflex enabled" : "Prompt reflex not enabled", body: out.trimmingCharacters(in: .whitespacesAndNewlines))
      self.refreshHealth()
    }
  }
  @objc private func disableReflex() {
    CLI.runDetached(["reflex", "uninstall"]) { code, out in
      self.notify(code == 0 ? "Prompt reflex disabled" : "Prompt reflex not disabled", body: out.trimmingCharacters(in: .whitespacesAndNewlines))
      self.refreshHealth()
    }
  }

  private var bundled: Bool { Bundle.main.bundleURL.pathExtension == "app" }
  private var launchAtLogin: Bool { bundled && SMAppService.mainApp.status == .enabled }
  private var inApplications: Bool {
    let path = Bundle.main.bundleURL.path
    return path.hasPrefix("/Applications/") || path.hasPrefix("\(NSHomeDirectory())/Applications/")
  }

  // MARK: a normal app: lives in Applications, offers to start at login, keeps the service pointed at itself

  private var prefsPath: String { "\(CLI.stateDir)/menubar.json" }
  private func prefs() -> [String: Any] {
    guard let data = FileManager.default.contents(atPath: prefsPath),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return object
  }
  private func savePrefs(_ values: [String: Any]) {
    try? FileManager.default.createDirectory(atPath: CLI.stateDir, withIntermediateDirectories: true)
    if let data = try? JSONSerialization.data(withJSONObject: values) { try? data.write(to: URL(fileURLWithPath: prefsPath), options: .atomic) }
  }

  private func firstLaunchFlow() {
    guard bundled else { return }
    if !inApplications { offerMoveToApplications(); return } // relaunches from there when accepted
    // Ask for folder access in the foreground BEFORE the service is (re)started:
    // every new build is a new client to macOS privacy, and a watcher meeting
    // the prompt in the background blocks until someone happens to notice it.
    // One dialog at a time: the login-item question waits for this one.
    askForFolderAccessIfNew { restart in
      self.healService(restart: restart)
      self.checkWatcher()
      var values = self.prefs()
      if values["askedLoginItem"] == nil {
        values["askedLoginItem"] = true
        self.savePrefs(values)
        self.offerLaunchAtLogin()
      }
    }
  }

  /// Opened from a zip in Downloads or from the repo: offer to move into
  /// Applications, where Login Items are allowed and the capture service can
  /// keep pointing at one place. /Applications when writable, else ~/Applications.
  private func offerMoveToApplications() {
    let alert = NSAlert()
    alert.messageText = "Move Carafe to your Applications folder?"
    alert.informativeText = "Carafe runs from the menu bar. Keeping it in Applications lets it start at login and keeps capture pointed at one copy."
    alert.addButton(withTitle: "Move to Applications")
    alert.addButton(withTitle: "Not Now")
    NSApp.activate(ignoringOtherApps: true)
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    let fm = FileManager.default
    let system = "/Applications"
    let user = "\(NSHomeDirectory())/Applications"
    let folder = fm.isWritableFile(atPath: system) ? system : user
    try? fm.createDirectory(atPath: folder, withIntermediateDirectories: true)
    let destination = URL(fileURLWithPath: "\(folder)/Carafe.app")
    do {
      if fm.fileExists(atPath: destination.path) { try fm.removeItem(at: destination) }
      try fm.copyItem(at: Bundle.main.bundleURL, to: destination)
    } catch {
      notify("Could not move Carafe", body: "\(error.localizedDescription)\n\nDrag Carafe.app to \(folder) yourself, then open it from there.")
      return
    }
    CLI.log("moved to \(destination.path)")
    let source = Bundle.main.bundleURL
    NSWorkspace.shared.openApplication(at: destination, configuration: NSWorkspace.OpenConfiguration()) { _, _ in
      DispatchQueue.main.async {
        try? fm.trashItem(at: source, resultingItemURL: nil) // the copy we launched from goes to the Trash, never deleted
        NSApp.terminate(nil)
      }
    }
  }

  private func offerLaunchAtLogin() {
    let alert = NSAlert()
    alert.messageText = "Start Carafe at login?"
    alert.informativeText = "Capture keeps running either way (it is a background service); this only puts the menu bar icon back after a restart. You can change it later from the menu."
    alert.addButton(withTitle: "Start at Login")
    alert.addButton(withTitle: "Not Now")
    NSApp.activate(ignoringOtherApps: true)
    if alert.runModal() == .alertFirstButtonReturn {
      do { try SMAppService.mainApp.register() } catch { notify("Launch at Login", body: error.localizedDescription) }
      rebuildMenu()
    }
  }

  /// First launch, and every launch after the bundled carafe's version changed:
  /// explain in one line, then touch the protected folders the watcher will need
  /// from this foreground app, so macOS asks while the user is looking. `done`
  /// learns whether the version changed (the watcher is then restarted, after
  /// the answer, so it runs this build and sees the grant).
  private func askForFolderAccessIfNew(done: @escaping (Bool) -> Void) {
    var values = prefs()
    let version = CLI.version
    guard values["folderAccessVersion"] as? String != version else { done(false); return }
    DispatchQueue.global(qos: .userInitiated).async {
      let folders = ProtectedFolders.needed()
      DispatchQueue.main.async {
        let finish = { (denied: [String]) in
          self.appDenied = denied
          values = self.prefs()
          values["folderAccessVersion"] = version
          self.savePrefs(values)
          self.rebuildMenu()
          done(true)
        }
        guard !folders.isEmpty else { finish([]); return }
        let names = folders.map(ProtectedFolders.name).joined(separator: ", ")
        let alert = NSAlert()
        alert.messageText = "Carafe needs to read your project folders"
        alert.informativeText = "Carafe reads your coding sessions' project folders to check git state. macOS will ask for access to \(names) — click Allow."
        alert.addButton(withTitle: "Continue")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
        CLI.log("asking for folder access: \(folders.joined(separator: ", "))")
        DispatchQueue.global(qos: .userInitiated).async {
          let denied = ProtectedFolders.touch(folders)
          DispatchQueue.main.async { finish(denied) }
        }
      }
    }
  }

  /// After a move or an update the capture service may point at a carafe that
  /// no longer exists (the old bundle). Re-point it at this app's carafe. With
  /// `restart` (a new build), a service that is fine is restarted instead, once
  /// folder access has been answered. An installed plist means capture is on
  /// (Pause removes it), so a service launchd no longer has loaded (booted out
  /// around an app swap) is started too: `carafe service restart` bootstraps it
  /// when it is not loaded, so this path always ends with a running watcher.
  private func healService(restart: Bool = false) {
    guard let service = CLI.servicePlistCommand() else { return } // no service: nothing to heal
    if FileManager.default.isExecutableFile(atPath: service[0]) {
      DispatchQueue.global(qos: .userInitiated).async {
        let loaded = CarafeMenuBar.value(of: "service loaded", in: CLI.run(["service", "status"]).out) == "yes"
        guard restart || !loaded else { return }
        if !loaded { CLI.log("service installed but not loaded; starting it") }
        let r = CLI.run(["service", "restart"])
        DispatchQueue.main.async {
          if r.code != 0 { self.notify("Capture service needs attention", body: r.out.trimmingCharacters(in: .whitespacesAndNewlines)) }
          self.refreshHealth()
        }
      }
      return
    }
    CLI.log("service points at a missing carafe (\(service[0])); re-enabling from this app")
    CLI.runDetached(["service", "enable"]) { code, out in
      if code != 0 { self.notify("Capture service needs attention", body: out.trimmingCharacters(in: .whitespacesAndNewlines)) }
      self.refreshHealth()
    }
  }

  @objc private func toggleLaunchAtLogin() {
    do {
      if launchAtLogin { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() }
    } catch {
      notify("Launch at Login", body: error.localizedDescription)
    }
    rebuildMenu()
  }

  /// A bundled carafe never self-updates; the app is the unit of update. Ask the
  /// CLI what the latest release is (exit 2 = newer available) and offer the page.
  @objc private func update() {
    CLI.runDetached(["update", "--check"]) { code, out in
      let line = out.split(separator: "\n").last.map(String.init) ?? "no answer from the release feed"
      guard code == 2 else { self.notify("Carafe update", body: line); return }
      let alert = NSAlert()
      alert.messageText = "A newer \(AppChannel.name) is available"
      alert.informativeText = AppChannel.isStable
        ? "\(line)\n\nDownload the latest Carafe zip, open it, and it will replace this copy."
        : "\(line)\n\nDownload the newest \(AppChannel.name) zip (Carafe-\(AppChannel.current)-…zip), open it, and it will replace this copy."
      alert.addButton(withTitle: "Open Releases Page")
      alert.addButton(withTitle: "Later")
      NSApp.activate(ignoringOtherApps: true)
      if alert.runModal() == .alertFirstButtonReturn {
        NSWorkspace.shared.open(URL(string: AppChannel.releasesURL)!)
      }
    }
  }
  @objc private func quit() { NSApp.terminate(nil) }

  /// Lightweight notice without UserNotifications entitlements: a floating alert.
  private func notify(_ title: String, body: String) {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = body
    alert.alertStyle = .informational
    NSApp.activate(ignoringOtherApps: true)
    alert.runModal()
  }
}

// MARK: - main

// `CarafeMenuBar --render-icons DIR` writes the mark as PNGs (levels and sizes)
// and exits: a way to look at the icon without a screen, and the source of the
// app icon's mark in Design/make-icons.py.
if let flag = CommandLine.arguments.firstIndex(of: "--render-icons"), CommandLine.arguments.count > flag + 1 {
  let dir = CommandLine.arguments[flag + 1]
  try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
  for (name, level) in [("full", CarafeMark.idleLevel), ("empty", CGFloat(0))] {
    for size in [18, 36, 72, 640] as [CGFloat] {
      if let data = CarafeMark.png(level: level, size: size) {
        FileManager.default.createFile(atPath: "\(dir)/mark-\(name)-\(Int(size)).png", contents: data)
      }
    }
  }
  // Eight frames of the fill, as the animation draws them (eased).
  for frame in 0...7 {
    let t = Double(frame) / 7
    let eased = t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2
    if let data = CarafeMark.png(level: CarafeMark.idleLevel * CGFloat(eased), size: 72) {
      FileManager.default.createFile(atPath: "\(dir)/fill-\(frame)-72.png", contents: data)
    }
  }
  exit(0)
}

// `CarafeMenuBar --probe-read PATH` logs whether this process may read PATH
// (macOS privacy protection decides per app for ~/Documents, ~/Desktop, …).
if let flag = CommandLine.arguments.firstIndex(of: "--probe-read"), CommandLine.arguments.count > flag + 1 {
  let path = CommandLine.arguments[flag + 1]
  let fd = open(path, O_RDONLY)
  let err = fd < 0 ? String(cString: strerror(errno)) : "ok"
  if fd >= 0 { close(fd) }
  CLI.log("--probe-read \(path) → \(err)")
  print(err)
  exit(fd < 0 ? 1 : 0)
}

// `CarafeMenuBar --capture-toggle enable|disable` runs the exact command the
// menu's Start/Pause runs (same carafe resolution, same environment when
// launched through `open`), logs it, and exits with its code.
if let flag = CommandLine.arguments.firstIndex(of: "--capture-toggle"), CommandLine.arguments.count > flag + 1 {
  let verb = CommandLine.arguments[flag + 1]
  let r = CLI.run(["service", verb])
  CLI.log("--capture-toggle \(verb) via \(CLI.command.joined(separator: " ")) → exit \(r.code)")
  print(r.out)
  exit(r.code)
}

// `CarafeMenuBar --preview-handoff-panel DIR` writes the handoff window's two states
// (preparing, ready) as PNGs and exits.
if let flag = CommandLine.arguments.firstIndex(of: "--preview-handoff-panel"), CommandLine.arguments.count > flag + 1 {
  let dir = CommandLine.arguments[flag + 1]
  try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
  _ = NSApplication.shared
  let panel = HandoffPanel(session: "Example session")
  panel.show()
  // Three moments of a slow fill: just started, a few seconds, a while.
  for (n, wait) in [(1, 0.7), (2, 4.0), (3, 8.0)] {
    RunLoop.main.run(until: Date().addingTimeInterval(wait))
    if let data = panel.png() { FileManager.default.createFile(atPath: "\(dir)/handoff-preparing-\(n).png", contents: data) }
  }
  panel.finish(title: "Handoff ready — continue-statement copied", body: HandoffMenu.notification(title: "Example session"), onClose: {})
  RunLoop.main.run(until: Date().addingTimeInterval(0.8))
  if let data = panel.png() { FileManager.default.createFile(atPath: "\(dir)/handoff-ready.png", contents: data) }
  exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()

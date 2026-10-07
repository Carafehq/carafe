import AppKit

struct SessionRow {
  let id: String
  let tool: String
  let title: String
  /// When someone last SPOKE in this session. `endTs` is the last record of any
  /// kind — Codex appends token counts to sessions nobody is using, so endTs
  /// makes a week-old session look live. This is the honest clock.
  let lastActivityTs: Date?
  let cwd: String
  let startTs: Date?

  static let toolTag = ["claude-code": "Claude Code", "codex": "Codex"]

  static let startStamp: DateFormatter = {
    let f = DateFormatter(); f.dateFormat = "d MMM HH:mm"; return f
  }()

  /// "3 min ago · Claude Code · Acme 1.0". Untitled sessions fall back to
  /// where and when they started, which a human can recognise; a bare id is not.
  func label(now: Date = Date()) -> String {
    let age: String
    if let lastActivityTs {
      let s = now.timeIntervalSince(lastActivityTs)
      age = s < 60 ? "just now" : s < 3600 ? "\(Int(s / 60)) min ago" : s < 86_400 ? "\(Int(s / 3600)) h ago" : "\(Int(s / 86_400)) d ago"
    } else { age = "?" }
    let tag = SessionRow.toolTag[tool] ?? tool
    return "\(age) · \(tag) · \(title.isEmpty ? fallbackName : String(title.prefix(56)))"
  }

  /// "<cwd basename> · 19 Sep 16:11", or the id if we know neither.
  var fallbackName: String {
    let base = cwd.isEmpty ? "" : (cwd as NSString).lastPathComponent
    let when = startTs.map { SessionRow.startStamp.string(from: $0) } ?? ""
    if base.isEmpty && when.isEmpty { return id }
    if when.isEmpty { return base }
    if base.isEmpty { return when }
    return "\(base) · \(when)"
  }

  /// A marker only — never an ordering key. Ordering is strictly by recency.
  func isActive(now: Date = Date()) -> Bool { lastActivityTs.map { now.timeIntervalSince($0) < 600 } ?? false }
}

enum SessionList {
  static let formatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
  }()
  static let plain: ISO8601DateFormatter = ISO8601DateFormatter()

  /// The newest top-level sessions. "Current session" was never knowable from a
  /// menu bar app (its working directory is /), so the user picks.
  static func parse(_ ts: String?) -> Date? {
    ts.flatMap { formatter.date(from: $0) ?? plain.date(from: $0) }
  }

  static func rows(_ rows: [[String: Any]]) -> [SessionRow] {
    let parsed: [SessionRow] = rows.compactMap { row in
      guard let id = row["id"] as? String, let tool = row["tool"] as? String else { return nil }
      // lastActivityTs is absent on distillates the backfill has not reached yet.
      let activity = parse(row["lastActivityTs"] as? String) ?? parse(row["endTs"] as? String)
      return SessionRow(
        id: id, tool: tool,
        title: (row["title"] as? String ?? "").replacingOccurrences(of: "\n", with: " "),
        lastActivityTs: activity,
        cwd: row["cwd"] as? String ?? "",
        startTs: parse(row["startTs"] as? String))
    }
    // Strictly newest-spoken-in first; undated rows sink to the bottom.
    return parsed.sorted { ($0.lastActivityTs ?? .distantPast) > ($1.lastActivityTs ?? .distantPast) }
  }
}

/// This payload comes from the capture registry, never a target-agent list.
struct HandoffSource {
  let tool: String
  let name: String
  let sessions: [SessionRow]

  static func decode(_ data: Data) -> [HandoffSource]? {
    guard let groups = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return nil }
    return groups.compactMap { group in
      guard let tool = group["tool"] as? String, let name = group["name"] as? String,
            let rows = group["sessions"] as? [[String: Any]] else { return nil }
      return HandoffSource(tool: tool, name: name, sessions: SessionList.rows(rows).filter { $0.tool == tool })
    }
  }
}

enum HandoffMenu {
  static let pasteMessage = "Paste into any agent (Claude Code, Codex, Cursor, Devin, …)"
  /// Strip only the CLI's trailing size metadata; parentheses may be in the path.
  static func filePath(output: String) -> String? {
    guard let line = output.split(separator: "\n").first(where: { $0.hasPrefix("  file: ") }) else { return nil }
    let value = String(line.dropFirst("  file: ".count))
    // The path ends at the handoff file's extension; the size note after it may itself
    // contain parentheses ("(20KB ≈ 8K tokens (estimate))"), and the path may too.
    for ext in [".md", ".carafe"] {
      if let r = value.range(of: ext + " (", options: .backwards) {
        let path = String(value[..<r.lowerBound]) + ext
        return path.hasPrefix("/") ? path : nil
      }
    }
    let path = value.hasSuffix(".md") || value.hasSuffix(".carafe") ? value : ""
    return path.hasPrefix("/") ? path : nil
  }
  static func statement(path: String) -> String { "Read \(path) and continue the work" }
  static func notification(title: String) -> String { "\(title)\n\n\(pasteMessage)" }

  static func build(sources: [HandoffSource], target: AnyObject?, action: Selector,
                    now: Date = Date()) -> (item: NSMenuItem, entries: [(item: NSMenuItem, row: SessionRow)]) {
    let parent = NSMenuItem(title: "Hand Off", action: nil, keyEquivalent: "")
    let menu = NSMenu(title: "Hand Off")
    var entries: [(item: NSMenuItem, row: SessionRow)] = []
    for source in sources {
      let title = "From \(source.name)"
      let sourceItem = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      let sub = NSMenu(title: title)
      if source.sessions.isEmpty {
        let empty = NSMenuItem(title: "No sessions captured yet", action: nil, keyEquivalent: "")
        empty.isEnabled = false
        sub.addItem(empty)
      }
      for row in source.sessions.sorted(by: { ($0.lastActivityTs ?? .distantPast) > ($1.lastActivityTs ?? .distantPast) }) {
        let entry = NSMenuItem(title: (row.isActive(now: now) ? "● " : "") + row.label(now: now), action: action, keyEquivalent: "")
        entry.target = target
        entry.representedObject = ["id": row.id, "title": row.title]
        sub.addItem(entry)
        entries.append((entry, row))
      }
      sourceItem.submenu = sub
      menu.addItem(sourceItem)
    }
    parent.submenu = menu
    return (parent, entries)
  }
}

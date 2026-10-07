import AppKit
import XCTest
@testable import CarafeMenuBar

final class HandoffMenuTests: XCTestCase {
  func testBuildsSourcesFromCaptureDataIncludingFutureAdaptersAndEmptySources() throws {
    let data = Data("""
      [{"tool":"claude-code","name":"Claude Code","sessions":[]},
       {"tool":"codex","name":"Codex","sessions":[
         {"id":"older","tool":"codex","title":"Older work","lastActivityTs":"2026-09-29T10:00:00Z"},
         {"id":"active","tool":"codex","title":"Current work","lastActivityTs":"2026-09-29T11:59:00Z"}]},
       {"tool":"future-tool","name":"Future Tool","sessions":[
         {"id":"future","tool":"future-tool","title":"Future work"}]}]
      """.utf8)
    let sources = try XCTUnwrap(HandoffSource.decode(data))
    let menu = HandoffMenu.build(sources: sources, target: nil, action: NSSelectorFromString("picked:"),
                                now: try XCTUnwrap(SessionList.parse("2026-09-29T12:00:00Z")))
    XCTAssertEqual(menu.item.title, "Hand Off")
    let sub = try XCTUnwrap(menu.item.submenu)
    XCTAssertEqual(sub.items.map(\.title), ["From Claude Code", "From Codex", "From Future Tool"])
    let empty = try XCTUnwrap(sub.items[0].submenu?.items.first)
    XCTAssertEqual(empty.title, "No sessions captured yet")
    XCTAssertFalse(empty.isEnabled)
    XCTAssertEqual(menu.entries.map { $0.row.id }, ["active", "older", "future"])
    XCTAssertTrue(menu.entries[0].item.title.hasPrefix("● "))
    XCTAssertFalse(menu.entries[1].item.title.hasPrefix("● "))
    let pick = try XCTUnwrap(menu.entries[0].item.representedObject as? [String: String])
    XCTAssertEqual(pick, ["id": "active", "title": "Current work"])
    XCTAssertEqual(sub.items[2].submenu?.items.count, 1)
  }

  func testContinueStatementAndNotificationAreToolNeutral() {
    XCTAssertEqual(HandoffMenu.filePath(output: "handoff ready → any agent\n  file: /tmp/work (copy)/session.md (1KB ≈ 1K tokens)\n"),
                   "/tmp/work (copy)/session.md")
    // The real CLI line: the size note carries its own "(estimate)".
    XCTAssertEqual(HandoffMenu.filePath(output: "note: capture is running elsewhere\n\nhandoff ready → any agent\n  file: /var/tmp/store/handoffs/abc.md (28KB ≈ 11K tokens (estimate))\n\nRead /var/tmp/store/handoffs/abc.md and continue the work\n"),
                   "/var/tmp/store/handoffs/abc.md")
    XCTAssertNil(HandoffMenu.filePath(output: "handoff failed"))
    XCTAssertNil(HandoffMenu.filePath(output: "  file: relative.md (1KB)"))
    XCTAssertEqual(HandoffMenu.statement(path: "/tmp/synthetic handoffs/session.md"),
                   "Read /tmp/synthetic handoffs/session.md and continue the work")
    XCTAssertEqual(HandoffMenu.notification(title: "Parser work"),
                   "Parser work\n\nPaste into any agent (Claude Code, Codex, Cursor, Devin, …)")
  }
}

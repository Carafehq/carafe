import AppKit

/// One window for a handoff, from the click to the result: it opens at once with a
/// filling carafe ("Preparing handoff…"), then becomes the ready (or failed) message in place.
final class HandoffPanel: NSObject, NSWindowDelegate {
  private let window: NSPanel
  /// The carafe itself is the progress: it fills while the handoff is prepared, and
  /// stands full when it is ready.
  private let carafe = NSImageView()
  private var fillTimer: Timer?
  private static let markSize: CGFloat = 44
  private static var markHeight: CGFloat { markSize * (128 + CarafeMark.brewHeadroom) / 128 }
  private var shownLevel: CGFloat = 0
  private let heading = NSTextField(labelWithString: "")
  private let detail = NSTextField(wrappingLabelWithString: "")
  private let button = NSButton(title: "OK", target: nil, action: nil)
  private var onClose: (() -> Void)?

  init(session: String) {
    window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 150),
                     styleMask: [.titled, .closable], backing: .buffered, defer: false)
    super.init()
    window.title = "Carafe"
    window.isReleasedWhenClosed = false
    window.level = .floating
    window.delegate = self

    carafe.image = CarafeMark.brewingImage(level: 0, time: 0, dripping: true, width: HandoffPanel.markSize)
    carafe.contentTintColor = .labelColor
    carafe.imageScaling = .scaleNone
    heading.font = .boldSystemFont(ofSize: 13)
    heading.lineBreakMode = .byTruncatingTail
    detail.font = .systemFont(ofSize: 12)
    detail.textColor = .secondaryLabelColor
    detail.maximumNumberOfLines = 6
    button.target = self
    button.action = #selector(close)
    button.keyEquivalent = "\r"
    button.bezelStyle = .rounded
    button.isHidden = true

    let content = NSView()
    for view in [carafe, heading, detail, button] as [NSView] {
      view.translatesAutoresizingMaskIntoConstraints = false
      content.addSubview(view)
    }
    NSLayoutConstraint.activate([
      carafe.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 22),
      carafe.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
      carafe.widthAnchor.constraint(equalToConstant: HandoffPanel.markSize),
      carafe.heightAnchor.constraint(equalToConstant: HandoffPanel.markHeight),
      heading.leadingAnchor.constraint(equalTo: carafe.trailingAnchor, constant: 16),
      heading.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
      heading.topAnchor.constraint(equalTo: content.topAnchor, constant: 22),
      detail.leadingAnchor.constraint(equalTo: heading.leadingAnchor),
      detail.trailingAnchor.constraint(equalTo: heading.trailingAnchor),
      detail.topAnchor.constraint(equalTo: heading.bottomAnchor, constant: 6),
      button.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
      button.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
      button.widthAnchor.constraint(greaterThanOrEqualToConstant: 80),
      button.topAnchor.constraint(greaterThanOrEqualTo: detail.bottomAnchor, constant: 14),
      content.widthAnchor.constraint(equalToConstant: 420),
      content.heightAnchor.constraint(greaterThanOrEqualToConstant: 120),
    ])
    window.contentView = content
    heading.stringValue = HandoffPanel.preparingTitle
    detail.stringValue = HandoffPanel.preparingBody(session: session)
  }

  static let preparingTitle = "Preparing handoff…"
  static func preparingBody(session: String) -> String {
    "\(session)\n\nReading the session and checking its facts. This takes a few seconds on a large session."
  }

  /// The coffee level `elapsed` seconds into preparing: it rises steadily and slows as it
  /// nears the top (half in ~7 s, ~90% of the way in ~23 s) and never fills before the
  /// handoff is actually ready; then it tops up.
  static func level(at elapsed: TimeInterval) -> CGFloat {
    CarafeMark.idleLevel * 0.95 * CGFloat(1 - exp(-elapsed / 10))
  }

  func show() {
    let started = Date()
    let timer = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
      guard let self else { return }
      let elapsed = Date().timeIntervalSince(started)
      self.shownLevel = HandoffPanel.level(at: elapsed)
      self.carafe.image = CarafeMark.brewingImage(level: self.shownLevel, time: elapsed, dripping: true, width: HandoffPanel.markSize)
    }
    RunLoop.main.add(timer, forMode: .common)
    fillTimer = timer
    window.center()
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
  }

  /// The same window becomes the result.
  func finish(title: String, body: String, onClose: @escaping () -> Void) {
    self.onClose = onClose
    fillTimer?.invalidate()
    fillTimer = nil
    // Top up to full in 0.5 s, the last drops falling, then stop dripping.
    let from = shownLevel, began = Date()
    let topUp = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] timer in
      guard let self else { timer.invalidate(); return }
      let t = min(1, Date().timeIntervalSince(began) / 0.5)
      let level = from + (CarafeMark.idleLevel - from) * CGFloat(1 - pow(1 - t, 3))
      self.carafe.image = CarafeMark.brewingImage(level: level, time: Date().timeIntervalSince(began), dripping: t < 1, width: HandoffPanel.markSize)
      if t >= 1 { timer.invalidate() }
    }
    RunLoop.main.add(topUp, forMode: .common)
    fillTimer = topUp
    heading.stringValue = title
    detail.stringValue = body
    button.isHidden = false
    window.layoutIfNeeded()
    window.setContentSize(window.contentView?.fittingSize ?? window.frame.size)
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
    window.makeFirstResponder(button)
  }

  /// The window's content as a PNG (for `--preview-handoff-panel`: look at it without clicking).
  func png() -> Data? {
    guard let view = window.contentView else { return nil }
    view.layoutSubtreeIfNeeded()
    guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return nil }
    view.cacheDisplay(in: view.bounds, to: rep)
    return rep.representation(using: .png, properties: [:])
  }

  @objc private func close() { window.close() }

  func windowWillClose(_: Notification) {
    let done = onClose
    onClose = nil
    done?()
  }
}

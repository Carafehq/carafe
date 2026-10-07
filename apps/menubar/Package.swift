// swift-tools-version:5.9
// Carafe menu-bar app — thin native shell over the carafe CLI.
// Build: swift build   Run (dev): swift run
// Packaging as a signed .app is a later step; this target proves the shape.
import PackageDescription

let package = Package(
  name: "CarafeMenuBar",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(name: "CarafeMenuBar", path: "Sources/CarafeMenuBar"),
    .testTarget(name: "CarafeMenuBarTests", dependencies: ["CarafeMenuBar"]),
  ]
)

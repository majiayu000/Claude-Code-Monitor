// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "KeeplineKit",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "KeeplineKit", targets: ["KeeplineKit"]),
    ],
    targets: [
        .target(name: "KeeplineKit"),
        .testTarget(name: "KeeplineKitTests", dependencies: ["KeeplineKit"]),
    ]
)

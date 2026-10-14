// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ColeoInboxMac",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "ColeoInboxCore", targets: ["ColeoInboxCore"]),
        .executable(name: "ColeoInboxMac", targets: ["ColeoInboxMac"]),
    ],
    targets: [
        .target(name: "ColeoInboxCore"),
        .executableTarget(name: "ColeoInboxMac", dependencies: ["ColeoInboxCore"], resources: [.copy("Resources/modules.json")]),
        .testTarget(
            name: "ColeoInboxCoreTests",
            dependencies: ["ColeoInboxCore"],
            resources: [.copy("Fixtures")]
        ),
        .testTarget(name: "ColeoInboxMacTests", dependencies: ["ColeoInboxMac", "ColeoInboxCore"]),
    ]
)

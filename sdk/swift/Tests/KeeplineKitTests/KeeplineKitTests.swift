import Foundation
import XCTest
@testable import KeeplineKit

final class KeeplineKitTests: XCTestCase {
    func testRejectsNonLoopbackURL() throws {
        XCTAssertThrowsError(
            try KeeplineClientConfiguration(baseURL: URL(string: "https://example.com")!)
        )
    }

    func testAcceptsUnknownRuntimeAndStatus() throws {
        let json = #"{"id":"row","sessionId":"session","runtimeId":"future-agent","title":"Task","directory":"/tmp","status":"paused","lastActiveAt":"2026-08-30T10:00:00.123Z"}"#.data(using: .utf8)!
        let session = try makeKeeplineDecoder().decode(KeeplineSession.self, from: json)
        XCTAssertEqual(session.runtimeID.rawValue, "future-agent")
        XCTAssertEqual(session.status.rawValue, "paused")
        XCTAssertEqual(session.lastActiveAt.timeIntervalSince1970, 1_788_084_000.123, accuracy: 0.001)
    }
}

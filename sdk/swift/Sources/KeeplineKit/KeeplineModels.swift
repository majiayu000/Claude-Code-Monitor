import Foundation

public struct KeeplineRuntimeID: RawRepresentable, Codable, Hashable, Sendable, ExpressibleByStringLiteral {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }
    public static let codex: Self = "codex"
    public static let claudeCode: Self = "claude-code"
}

public struct KeeplineSessionStatus: RawRepresentable, Codable, Hashable, Sendable, ExpressibleByStringLiteral {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }
    public static let running: Self = "running"
    public static let waiting: Self = "waiting"
    public static let idle: Self = "idle"
    public static let lost: Self = "lost"
    public static let completed: Self = "completed"
}

public struct KeeplineRuntime: Codable, Hashable, Sendable {
    public let id: KeeplineRuntimeID
    public let displayName: String
    public let capabilities: [String]
}

public struct KeeplineMetadata: Codable, Hashable, Sendable {
    public let apiVersion: String
    public let serviceVersion: String
    public let instanceId: String
    public let mode: String
    public let capabilities: [String]
    public let runtimes: [KeeplineRuntime]
}

public struct KeeplineSession: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let sessionID: String
    public let runtimeID: KeeplineRuntimeID
    public let title: String
    public let directory: String
    public let status: KeeplineSessionStatus
    public let lastActiveAt: Date
    public let evidenceSummary: String?
    public let completionEvidenceID: String?
    public let completionEvidenceWorkItemID: String?
    public let completionEvidenceSource: String?
    public let processRunning: Bool?

    enum CodingKeys: String, CodingKey {
        case id, title, directory, status, lastActiveAt, evidenceSummary, processRunning
        case completionEvidenceID = "completionEvidenceId"
        case completionEvidenceWorkItemID = "completionEvidenceWorkItemId"
        case completionEvidenceSource
        case sessionID = "sessionId"
        case runtimeID = "runtimeId"
    }
}

public struct ExternalWorkItemInput: Codable, Hashable, Sendable {
    public var title: String
    public var body: String?
    public var projectRoot: String?
    public var kind: String
    public var status: String

    public init(
        title: String,
        body: String? = nil,
        projectRoot: String? = nil,
        kind: String = "todo",
        status: String = "planned"
    ) {
        self.title = title
        self.body = body
        self.projectRoot = projectRoot
        self.kind = kind
        self.status = status
    }
}

public struct KeeplineWorkItem: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let body: String?
    public let projectRoot: String?
    public let kind: String
    public let status: String
    public let externalSource: String?
    public let externalId: String?
    public let createdAt: Date
    public let updatedAt: Date
}

public struct KeeplineSessionLink: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let workItemID: String
    public let agentSessionID: String
    public let linkSource: String
    public let acceptanceStatus: String
    public let acceptedAt: Date?
    public let createdAt: Date
    public let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id, linkSource, acceptanceStatus, acceptedAt, createdAt, updatedAt
        case workItemID = "workItemId"
        case agentSessionID = "agentSessionId"
    }
}

public struct DispatchRequest: Codable, Hashable, Sendable {
    public var runtimeID: KeeplineRuntimeID
    public var cwd: String
    public var prompt: String
    public var terminalApp: String
    public var idempotencyKey: String

    public init(
        runtimeID: KeeplineRuntimeID,
        cwd: String,
        prompt: String,
        terminalApp: String = "auto",
        idempotencyKey: String
    ) {
        self.runtimeID = runtimeID
        self.cwd = cwd
        self.prompt = prompt
        self.terminalApp = terminalApp
        self.idempotencyKey = idempotencyKey
    }

    enum CodingKeys: String, CodingKey {
        case cwd, prompt, terminalApp, idempotencyKey
        case runtimeID = "runtimeId"
    }
}

public struct KeeplineDispatch: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let workItemID: String
    public let runtimeID: KeeplineRuntimeID
    public let cwd: String
    public let state: String
    public let candidateSessionIDs: [String]
    public let linkedAgentSessionID: String?
    public let linkedSessionID: String?
    public let error: String?
    public let launchedAt: Date?
    public let correlationDeadlineAt: Date?
    public let createdAt: Date
    public let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id, cwd, state, error, launchedAt, correlationDeadlineAt, createdAt, updatedAt
        case workItemID = "workItemId"
        case runtimeID = "runtimeId"
        case candidateSessionIDs = "candidateSessionIds"
        case linkedAgentSessionID = "linkedAgentSessionId"
        case linkedSessionID = "linkedSessionId"
    }
}

public enum CompletionReviewDecision: String, Codable, Hashable, Sendable {
    case accepted
    case rejected
}

public struct CompletionReviewRequest: Codable, Hashable, Sendable {
    public var evidenceID: String
    public var decision: CompletionReviewDecision
    public init(evidenceID: String, decision: CompletionReviewDecision) {
        self.evidenceID = evidenceID
        self.decision = decision
    }
    enum CodingKeys: String, CodingKey {
        case decision
        case evidenceID = "evidenceId"
    }
}

public struct CompletionReview: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let workItemID: String
    public let evidenceID: String
    public let decision: CompletionReviewDecision
    public let createdAt: Date
    public let updatedAt: Date
    enum CodingKeys: String, CodingKey {
        case id, decision, createdAt, updatedAt
        case workItemID = "workItemId"
        case evidenceID = "evidenceId"
    }
}

public struct CompletionReviewResult: Codable, Hashable, Sendable {
    public let review: CompletionReview
    public let item: KeeplineWorkItem
}

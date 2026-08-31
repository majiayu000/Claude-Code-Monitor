import Foundation

public struct KeeplineClientConfiguration: Hashable, Sendable {
    public let baseURL: URL
    public let requestTimeout: TimeInterval

    public init(baseURL: URL, requestTimeout: TimeInterval = 5) throws {
        guard baseURL.scheme == "http" || baseURL.scheme == "https" else {
            throw KeeplineError.invalidBaseURL
        }
        let host = baseURL.host?.lowercased()
        guard host == "localhost" || host == "127.0.0.1" || host == "::1" else {
            throw KeeplineError.invalidBaseURL
        }
        guard requestTimeout > 0 else { throw KeeplineError.invalidTimeout }
        self.baseURL = baseURL
        self.requestTimeout = requestTimeout
    }
}

public enum KeeplineError: Error, LocalizedError, Sendable {
    case invalidBaseURL
    case invalidTimeout
    case invalidResponse
    case unauthorized
    case service(status: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .invalidBaseURL: "Keepline must use a loopback HTTP URL."
        case .invalidTimeout: "Keepline request timeout must be positive."
        case .invalidResponse: "Keepline returned an invalid response."
        case .unauthorized: "Keepline local authentication failed."
        case let .service(_, message): message
        }
    }
}

private struct Envelope<Value: Decodable>: Decodable {
    let success: Bool
    let data: Value?
    let error: String?
}

private struct TokenData: Decodable { let token: String }
private struct SessionListData: Decodable { let sessions: [KeeplineSession] }
private struct WorkItemData: Decodable { let item: KeeplineWorkItem }
private struct SessionLinkData: Decodable { let link: KeeplineSessionLink }
private struct DispatchData: Decodable { let dispatch: KeeplineDispatch }
private struct RecoveryPreviewData: Decodable { let preview: KeeplineRecoveryPreview }

func makeKeeplineDecoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: value) { return date }
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid ISO-8601 date")
    }
    return decoder
}

public actor KeeplineClient {
    private let configuration: KeeplineClientConfiguration
    private let session: URLSession
    private var token: String?

    public init(configuration: KeeplineClientConfiguration, session: URLSession = .shared) {
        self.configuration = configuration
        self.session = session
    }

    public func metadata() async throws -> KeeplineMetadata {
        try await send(path: ["meta"], authenticated: false, response: KeeplineMetadata.self)
    }

    public func listSessions() async throws -> [KeeplineSession] {
        let data = try await send(
            path: ["sessions"],
            query: [URLQueryItem(name: "fields", value: "basic")],
            response: SessionListData.self
        )
        return data.sessions
    }

    public func recoveryPreview(sessionID: String) async throws -> KeeplineRecoveryPreview {
        let data = try await send(
            path: ["sessions", sessionID, "recovery-preview"],
            response: RecoveryPreviewData.self
        )
        return data.preview
    }

    public func executeRecovery(
        sessionID: String,
        request: RecoveryExecutionRequest
    ) async throws -> KeeplineRecoveryExecution {
        try await send(
            path: ["sessions", sessionID, "recover"],
            method: "POST",
            body: request,
            response: KeeplineRecoveryExecution.self
        )
    }

    public func upsertExternalWorkItem(
        source: String,
        externalID: String,
        input: ExternalWorkItemInput
    ) async throws -> KeeplineWorkItem {
        let data = try await send(
            path: ["work-items", "external", source, externalID],
            method: "PUT",
            body: input,
            response: WorkItemData.self
        )
        return data.item
    }

    public func linkSession(workItemID: String, sessionID: String) async throws -> KeeplineSessionLink {
        struct Body: Encodable { let sessionId: String; let linkSource = "user" }
        let data = try await send(
            path: ["work-items", workItemID, "session-links"],
            method: "POST",
            body: Body(sessionId: sessionID),
            response: SessionLinkData.self
        )
        return data.link
    }

    public func dispatch(workItemID: String, request: DispatchRequest) async throws -> KeeplineDispatch {
        let data = try await send(
            path: ["work-items", workItemID, "dispatch"],
            method: "POST",
            body: request,
            response: DispatchData.self
        )
        return data.dispatch
    }

    public func dispatch(id: String) async throws -> KeeplineDispatch {
        let data = try await send(
            path: ["dispatches", id],
            response: DispatchData.self
        )
        return data.dispatch
    }

    /// Resolves an ambiguous dispatch to one of its native runtime session IDs.
    public func resolveDispatchSession(id: String, sessionID: String) async throws -> KeeplineDispatch {
        struct Body: Encodable { let sessionId: String }
        let data = try await send(
            path: ["dispatches", id, "resolve-session"],
            method: "POST",
            body: Body(sessionId: sessionID),
            response: DispatchData.self
        )
        return data.dispatch
    }

    public func reviewCompletion(
        workItemID: String,
        request: CompletionReviewRequest
    ) async throws -> CompletionReviewResult {
        try await send(
            path: ["work-items", workItemID, "completion-review"],
            method: "POST",
            body: request,
            response: CompletionReviewResult.self
        )
    }

    private func authenticate() async throws {
        let tokenData = try await send(
            path: ["auth", "local"],
            method: "POST",
            authenticated: false,
            retryAuthentication: false,
            response: TokenData.self
        )
        token = tokenData.token
    }

    private func send<Response: Decodable>(
        path: [String],
        query: [URLQueryItem] = [],
        method: String = "GET",
        authenticated: Bool = true,
        retryAuthentication: Bool = true,
        response: Response.Type
    ) async throws -> Response {
        try await send(
            path: path,
            query: query,
            method: method,
            bodyData: nil,
            authenticated: authenticated,
            retryAuthentication: retryAuthentication,
            response: response
        )
    }

    private func send<Body: Encodable, Response: Decodable>(
        path: [String],
        query: [URLQueryItem] = [],
        method: String,
        body: Body,
        authenticated: Bool = true,
        retryAuthentication: Bool = true,
        response: Response.Type
    ) async throws -> Response {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return try await send(
            path: path,
            query: query,
            method: method,
            bodyData: try encoder.encode(body),
            authenticated: authenticated,
            retryAuthentication: retryAuthentication,
            response: response
        )
    }

    private func send<Response: Decodable>(
        path: [String],
        query: [URLQueryItem],
        method: String,
        bodyData: Data?,
        authenticated: Bool,
        retryAuthentication: Bool,
        response: Response.Type
    ) async throws -> Response {
        if authenticated && token == nil { try await authenticate() }
        var url = configuration.baseURL
        for component in ["api", "v1"] + path {
            url.appendPathComponent(component)
        }
        if !query.isEmpty {
            guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
                throw KeeplineError.invalidBaseURL
            }
            components.queryItems = query
            guard let queryURL = components.url else { throw KeeplineError.invalidBaseURL }
            url = queryURL
        }
        var request = URLRequest(url: url, timeoutInterval: configuration.requestTimeout)
        request.httpMethod = method
        request.httpBody = bodyData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if bodyData != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if authenticated, let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }

        let (data, rawResponse) = try await session.data(for: request)
        guard let http = rawResponse as? HTTPURLResponse else { throw KeeplineError.invalidResponse }
        if http.statusCode == 401 && authenticated && retryAuthentication {
            token = nil
            try await authenticate()
            return try await send(
                path: path,
                query: query,
                method: method,
                bodyData: bodyData,
                authenticated: authenticated,
                retryAuthentication: false,
                response: response
            )
        }
        let decoder = makeKeeplineDecoder()
        let envelope = try? decoder.decode(Envelope<Response>.self, from: data)
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw KeeplineError.unauthorized }
            throw KeeplineError.service(
                status: http.statusCode,
                message: envelope?.error ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            )
        }
        guard let envelope else { throw KeeplineError.invalidResponse }
        guard envelope.success, let value = envelope.data else {
            throw KeeplineError.service(status: http.statusCode, message: envelope.error ?? "Keepline request failed")
        }
        return value
    }
}

/**
 * Guanxi approval signing helper (D-184).
 *
 * One request per invocation: a single JSON object on stdin, a single JSON object on stdout.
 * The private key is a Secure Enclave P-256 key; the login keychain stores only its wrapped
 * representation, behind an access list that trusts this executable alone.
 *
 * Exit codes: 0 success, 1 refused or failed request, 2 usage error. Diagnostics never contain
 * key material and go to stderr.
 */
import CryptoKit
import Darwin
import Foundation
import LocalAuthentication
import Security

// MARK: - Protocol

struct HelperFailure: Error {
    let code: String
    let message: String
    let exitCode: Int32

    init(_ code: String, _ message: String, exitCode: Int32 = 1) {
        self.code = code
        self.message = message
        self.exitCode = exitCode
    }
}

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
        FileHandle.standardError.write(Data("cannot encode the response\n".utf8))
        exit(1)
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func refuse(_ code: String, _ message: String) -> Never {
    emit(["ok": false, "code": code, "message": message])
    FileHandle.standardError.write(Data("\(code): \(message)\n".utf8))
    exit(1)
}

func usage(_ message: String) -> Never {
    emit(["ok": false, "code": "usage", "message": message])
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(2)
}

let approvalSchema = "guanxi.ui-approval/3"
let revocationSchema = "guanxi.ui-revocation/3"
let componentIdPattern = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"

// MARK: - Canonical JSON

enum CanonicalJSONError: Error {
    case unsupported
}

func utf16Less(_ lhs: String, _ rhs: String) -> Bool {
    let left = Array(lhs.utf16)
    let right = Array(rhs.utf16)
    for index in 0 ..< min(left.count, right.count) where left[index] != right[index] {
        return left[index] < right[index]
    }
    return left.count < right.count
}

/// `JSON.stringify` escaping: quote, backslash, the short control escapes and lowercase
/// `\u00xx` for other C0 controls. Non-ASCII stays raw, exactly as JavaScript writes it.
func jsonString(_ value: String) -> String {
    var result = "\""
    var raw: [UInt16] = []

    func flushRaw() {
        guard !raw.isEmpty else { return }
        result += String(decoding: raw, as: UTF16.self)
        raw.removeAll(keepingCapacity: true)
    }

    let units = Array(value.utf16)
    var index = 0
    while index < units.count {
        let unit = units[index]
        switch unit {
        case 0x22:
            flushRaw()
            result += "\\\""
        case 0x5C:
            flushRaw()
            result += "\\\\"
        case 0x08:
            flushRaw()
            result += "\\b"
        case 0x0C:
            flushRaw()
            result += "\\f"
        case 0x0A:
            flushRaw()
            result += "\\n"
        case 0x0D:
            flushRaw()
            result += "\\r"
        case 0x09:
            flushRaw()
            result += "\\t"
        default:
            if unit < 0x20 {
                flushRaw()
                result += String(format: "\\u%04x", unit)
            } else if unit >= 0xD800, unit <= 0xDBFF {
                if index + 1 < units.count, units[index + 1] >= 0xDC00, units[index + 1] <= 0xDFFF {
                    raw.append(unit)
                    raw.append(units[index + 1])
                    index += 1
                } else {
                    flushRaw()
                    result += String(format: "\\u%04x", unit)
                }
            } else if unit >= 0xDC00, unit <= 0xDFFF {
                // A lone low surrogate cannot be written as UTF-8; JavaScript escapes it.
                flushRaw()
                result += String(format: "\\u%04x", unit)
            } else {
                raw.append(unit)
            }
        }
        index += 1
    }
    flushRaw()
    return result + "\""
}

func canonicalJSON(_ value: Any) throws -> String {
    if value is NSNull { return "null" }
    if let string = value as? String { return jsonString(string) }
    if let number = value as? NSNumber {
        if CFGetTypeID(number) == CFBooleanGetTypeID() {
            return number.boolValue ? "true" : "false"
        }
        let double = number.doubleValue
        guard double.isFinite else { throw CanonicalJSONError.unsupported }
        // JavaScript prints integral numbers without a fractional part; payload fields are
        // strings, null and objects, so the representable range is enough here.
        if double == double.rounded(.towardZero), abs(double) <= 9_007_199_254_740_992 {
            return String(Int64(double))
        }
        return number.stringValue
    }
    if let array = value as? [Any] {
        var parts: [String] = []
        parts.reserveCapacity(array.count)
        for item in array { parts.append(try canonicalJSON(item)) }
        return "[\(parts.joined(separator: ","))]"
    }
    if let object = value as? [String: Any] {
        let keys = object.keys.sorted(by: utf16Less)
        var parts: [String] = []
        parts.reserveCapacity(keys.count)
        for key in keys {
            parts.append("\(jsonString(key)):\(try canonicalJSON(object[key] as Any))")
        }
        return "{\(parts.joined(separator: ","))}"
    }
    throw CanonicalJSONError.unsupported
}

func matchesComponentId(_ value: String) -> Bool {
    guard let expression = try? NSRegularExpression(pattern: componentIdPattern) else { return false }
    let range = NSRange(value.startIndex ..< value.endIndex, in: value)
    return expression.firstMatch(in: value, range: range)?.range == range
}

// MARK: - Keys

func keyIdentifier(publicKeyDER: Data) -> String {
    let digest = SHA256.hash(data: publicKeyDER)
    let hex = digest.map { String(format: "%02x", $0) }.joined()
    return "p256:\(String(hex.prefix(32)))"
}

func availableResponse(keyId: String, publicKey: String) -> [String: Any] {
    ["ok": true, "state": "available", "algorithm": "p256", "keyId": keyId, "publicKey": publicKey]
}

// MARK: - Confirmation policy

struct ApprovalKeyAccessPolicy {
    let accessibility: CFString
    let accessFlags: SecAccessControlCreateFlags
    let confirmationReuseDuration: TimeInterval
}

/// The single production source of the Secure Enclave access policy. The test-only probe reads
/// this builder and creates the access control through `makeApprovalAccessControl`, but never
/// creates a key or a keychain item.
func approvalKeyAccessPolicy() -> ApprovalKeyAccessPolicy {
    ApprovalKeyAccessPolicy(
        accessibility: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        accessFlags: [.privateKeyUsage, .userPresence],
        confirmationReuseDuration: 0
    )
}

func makeApprovalAccessControl() throws -> SecAccessControl {
    let policy = approvalKeyAccessPolicy()
    guard let accessControl = SecAccessControlCreateWithFlags(
        nil,
        policy.accessibility,
        policy.accessFlags,
        nil
    ) else {
        throw HelperFailure("keychain_access_unavailable", "Cannot create the Secure Enclave access control")
    }
    return accessControl
}

/// Applies the confirmation policy to a context. Production passes a fresh `LAContext`; the
/// test probe seeds a nonzero reuse value to prove that the explicit zero is applied.
func configureConfirmationContext(_ context: LAContext, reason: String) -> LAContext {
    let policy = approvalKeyAccessPolicy()
    context.localizedReason = reason
    context.touchIDAuthenticationAllowableReuseDuration = policy.confirmationReuseDuration
    return context
}

func makeConfirmationContext(reason: String) -> LAContext {
    configureConfirmationContext(LAContext(), reason: reason)
}

/// The exact source-bound reason shown by the confirmation prompt. The production sign path
/// and the test-only probe use this one builder.
func signingReason(schema: String, id: String, sourceHash: String?) -> String? {
    if schema == approvalSchema {
        guard let sourceHash, !sourceHash.isEmpty else { return nil }
        return "approve the \"\(id)\" component, source \(sourceHash)"
    }
    guard schema == revocationSchema else { return nil }
    return "request changes to the \"\(id)\" component"
}

#if GUANXI_SIGNER_TESTING
func testEnvironment(_ name: String) -> String? {
    guard let value = ProcessInfo.processInfo.environment[name], !value.isEmpty else { return nil }
    return value
}

func testKeyPath() -> String? { testEnvironment("SIGNER_TEST_KEY") }

func testItemPath(_ keyPath: String) -> String { "\(keyPath).item" }

func loadTestKey() throws -> P256.Signing.PrivateKey {
    guard let path = testKeyPath() else {
        throw HelperFailure("test_key_missing", "SIGNER_TEST_KEY is required for the test build")
    }
    do {
        return try P256.Signing.PrivateKey(rawRepresentation: Data(contentsOf: URL(fileURLWithPath: path)))
    } catch {
        throw HelperFailure("test_key_invalid", "SIGNER_TEST_KEY is not a raw P-256 private key")
    }
}

func testAuthenticate(_ reason: String) throws {
    let environment = ProcessInfo.processInfo.environment
    if let log = testEnvironment("SIGNER_TEST_AUTH_LOG") {
        let url = URL(fileURLWithPath: log)
        let line = Data("\(reason)\n".utf8)
        if FileManager.default.fileExists(atPath: log) {
            let handle = try FileHandle(forWritingTo: url)
            try handle.seekToEnd()
            try handle.write(contentsOf: line)
            try handle.close()
        } else {
            try line.write(to: url)
        }
    }
    if environment["SIGNER_TEST_AUTH_DENY"] == "1" {
        throw HelperFailure("signing_denied", "The owner cancelled or failed authentication")
    }
}
#endif

// MARK: - Keychain

/// `SecAccessCreate` and `SecTrustedApplicationCreateFromPath` are deprecated but are still
/// the only supported way to say "only this executable may read the wrapped key blob". The
/// symbols are resolved dynamically so the deprecation warning stays out of the build without
/// suppressing warnings globally; the runtime contract is unchanged.
typealias TrustedApplicationCreateFromPathFn = @convention(c) (UnsafePointer<CChar>?, UnsafeMutablePointer<SecTrustedApplication?>?) -> OSStatus
typealias AccessCreateFn = @convention(c) (CFString?, CFArray?, UnsafeMutablePointer<SecAccess?>?) -> OSStatus

func securityFunction<T>(_ name: String, as type: T.Type) -> T? {
    guard let handle = dlopen("/System/Library/Frameworks/Security.framework/Security", RTLD_LAZY),
          let symbol = dlsym(handle, name) else { return nil }
    return unsafeBitCast(symbol, to: T.self)
}

func makeAccess(description: String) throws -> SecAccess {
    guard let createTrustedApplication = securityFunction(
        "SecTrustedApplicationCreateFromPath",
        as: TrustedApplicationCreateFromPathFn.self
    ), let createAccess = securityFunction("SecAccessCreate", as: AccessCreateFn.self) else {
        throw HelperFailure("keychain_access_unavailable", "The legacy keychain access API is unavailable")
    }
    var application: SecTrustedApplication?
    let applicationStatus = createTrustedApplication(nil, &application)
    guard applicationStatus == errSecSuccess, let trusted = application else {
        throw HelperFailure("keychain_access_unavailable", "Cannot identify this helper for the keychain access list (OSStatus \(applicationStatus))")
    }
    var access: SecAccess?
    let accessStatus = createAccess(description as CFString, [trusted] as CFArray, &access)
    guard accessStatus == errSecSuccess, let created = access else {
        throw HelperFailure("keychain_access_unavailable", "Cannot create the keychain access list (OSStatus \(accessStatus))")
    }
    return created
}

#if GUANXI_SIGNER_TESTING
typealias KeychainOpenFn = @convention(c) (UnsafePointer<CChar>, UnsafeMutablePointer<SecKeychain?>?) -> OSStatus

func openKeychain(_ path: String) throws -> SecKeychain {
    guard let open = securityFunction("SecKeychainOpen", as: KeychainOpenFn.self) else {
        throw HelperFailure("keychain_access_unavailable", "The keychain file API is unavailable")
    }
    var keychain: SecKeychain?
    let status = path.withCString { open($0, &keychain) }
    guard status == errSecSuccess, let opened = keychain else {
        throw HelperFailure("keychain_access_unavailable", "Cannot open the test keychain (OSStatus \(status))")
    }
    return opened
}
#endif

func keychainQuery(service: String, account: String) -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecMatchLimit as String: kSecMatchLimitOne,
    ]
}

#if GUANXI_SIGNER_TESTING
func withKeychain(_ query: [String: Any], path: String?, adding: Bool) throws -> [String: Any] {
    guard let path else { return query }
    var scoped = query
    let keychain = try openKeychain(path)
    // `kSecUseKeychain` selects the destination of an add; searches need an explicit list.
    if adding {
        scoped[kSecUseKeychain as String] = keychain
    } else {
        scoped[kSecMatchSearchList as String] = [keychain] as CFArray
    }
    return scoped
}
#endif

func keychainMetadata(service: String, account: String, keychainPath: String?) throws -> (keyId: String, publicKey: String)? {
    var query = keychainQuery(service: service, account: account)
    query[kSecReturnAttributes as String] = true
    #if GUANXI_SIGNER_TESTING
    query = try withKeychain(query, path: keychainPath, adding: false)
    #endif
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let attributes = result as? [String: Any],
          let keyId = attributes[kSecAttrComment as String] as? String,
          let publicKey = attributes[kSecAttrDescription as String] as? String,
          !keyId.isEmpty, !publicKey.isEmpty else {
        throw HelperFailure("keychain_access_unavailable", "The keychain item has no approval key metadata (OSStatus \(status))")
    }
    return (keyId, publicKey)
}

func addKeychainItem(
    service: String,
    account: String,
    data: Data,
    keyId: String,
    publicKey: String,
    keychainPath: String?
) throws {
    let access = try makeAccess(description: service)
    var query = keychainQuery(service: service, account: account)
    query[kSecValueData as String] = data
    query[kSecAttrAccess as String] = access
    query[kSecAttrComment as String] = keyId
    query[kSecAttrDescription as String] = publicKey
    query[kSecAttrLabel as String] = service
    #if GUANXI_SIGNER_TESTING
    query = try withKeychain(query, path: keychainPath, adding: true)
    #endif
    let status = SecItemAdd(query as CFDictionary, nil)
    if status == errSecDuplicateItem {
        throw HelperFailure("key_exists", "An approval key already exists for this service and account")
    }
    guard status == errSecSuccess else {
        throw HelperFailure("keychain_access_unavailable", "Cannot store the wrapped approval key (OSStatus \(status))")
    }
}

#if !GUANXI_SIGNER_TESTING
func keychainData(service: String, account: String) throws -> Data {
    var query = keychainQuery(service: service, account: account)
    query[kSecReturnData as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
        throw HelperFailure("signing_key_missing", "No approval key is stored for this service and account")
    }
    if status == errSecUserCanceled || status == errSecAuthFailed {
        throw HelperFailure("signing_denied", "The keychain access prompt was denied")
    }
    guard status == errSecSuccess, let data = result as? Data else {
        throw HelperFailure("keychain_access_unavailable", "Cannot read the wrapped approval key (OSStatus \(status))")
    }
    return data
}
#endif

// MARK: - Operations

func operationStatus(service: String, account: String, keychainPath: String?) {
    #if GUANXI_SIGNER_TESTING
    if let keyPath = testKeyPath() {
        if keychainPath == nil {
            guard FileManager.default.fileExists(atPath: testItemPath(keyPath)) else {
                emit(["ok": true, "state": "missing"])
                exit(0)
            }
            do {
                let key = try loadTestKey()
                emit(availableResponse(
                    keyId: keyIdentifier(publicKeyDER: key.publicKey.derRepresentation),
                    publicKey: key.publicKey.derRepresentation.base64EncodedString()
                ))
                exit(0)
            } catch let failure as HelperFailure {
                refuse(failure.code, failure.message)
            } catch {
                refuse("test_key_invalid", "SIGNER_TEST_KEY is not a raw P-256 private key")
            }
        }
    }
    #endif
    do {
        guard let metadata = try keychainMetadata(service: service, account: account, keychainPath: keychainPath) else {
            emit(["ok": true, "state": "missing"])
            exit(0)
        }
        emit(availableResponse(keyId: metadata.keyId, publicKey: metadata.publicKey))
        exit(0)
    } catch let failure as HelperFailure {
        refuse(failure.code, failure.message)
    } catch {
        refuse("keychain_access_unavailable", "Cannot read the approval key metadata")
    }
}

func operationInit(service: String, account: String, keychainPath: String?) {
    #if GUANXI_SIGNER_TESTING
    if let keyPath = testKeyPath(), keychainPath == nil {
        let item = testItemPath(keyPath)
        guard !FileManager.default.fileExists(atPath: item) else {
            refuse("key_exists", "An approval key already exists for this service and account")
        }
        do {
            try Data("signer-test-item\n".utf8).write(to: URL(fileURLWithPath: item))
            let key = try loadTestKey()
            emit(availableResponse(
                keyId: keyIdentifier(publicKeyDER: key.publicKey.derRepresentation),
                publicKey: key.publicKey.derRepresentation.base64EncodedString()
            ))
            exit(0)
        } catch let failure as HelperFailure {
            refuse(failure.code, failure.message)
        } catch {
            refuse("keychain_access_unavailable", "Cannot create the test key item")
        }
    }
    #endif

    do {
        if try keychainMetadata(service: service, account: account, keychainPath: keychainPath) != nil {
            refuse("key_exists", "An approval key already exists for this service and account")
        }
    } catch let failure as HelperFailure {
        refuse(failure.code, failure.message)
    } catch {
        refuse("keychain_access_unavailable", "Cannot read the approval key metadata")
    }

    #if GUANXI_SIGNER_TESTING
    do {
        let key = try loadTestKey()
        let keyId = keyIdentifier(publicKeyDER: key.publicKey.derRepresentation)
        try addKeychainItem(
            service: service,
            account: account,
            data: key.rawRepresentation,
            keyId: keyId,
            publicKey: key.publicKey.derRepresentation.base64EncodedString(),
            keychainPath: keychainPath
        )
        emit(availableResponse(keyId: keyId, publicKey: key.publicKey.derRepresentation.base64EncodedString()))
        exit(0)
    } catch let failure as HelperFailure {
        refuse(failure.code, failure.message)
    } catch {
        refuse("keychain_access_unavailable", "Cannot create the approval key")
    }
    #else
    guard SecureEnclave.isAvailable else {
        refuse("platform_unsupported", "This Mac has no Secure Enclave")
    }
    do {
        let accessControl = try makeApprovalAccessControl()
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: accessControl)
        let keyId = keyIdentifier(publicKeyDER: key.publicKey.derRepresentation)
        try addKeychainItem(
            service: service,
            account: account,
            data: key.dataRepresentation,
            keyId: keyId,
            publicKey: key.publicKey.derRepresentation.base64EncodedString(),
            keychainPath: nil
        )
        emit(availableResponse(keyId: keyId, publicKey: key.publicKey.derRepresentation.base64EncodedString()))
        exit(0)
    } catch let failure as HelperFailure {
        refuse(failure.code, failure.message)
    } catch {
        refuse("keychain_access_unavailable", "Cannot create the Secure Enclave key")
    }
    #endif
}

func operationSign(service: String, account: String, payload: String) {
    let payloadData = Data(payload.utf8)
    guard let object = (try? JSONSerialization.jsonObject(with: payloadData)) as? [String: Any] else {
        refuse("payload_not_canonical", "The payload is not a JSON object")
    }
    guard let canonical = try? canonicalJSON(object), canonical == payload else {
        refuse("payload_not_canonical", "The payload is not canonical JSON")
    }
    guard let schema = object["schema"] as? String, schema == approvalSchema || schema == revocationSchema else {
        refuse("payload_schema", "The payload schema is not an approval or revocation schema")
    }
    guard let id = object["id"] as? String, matchesComponentId(id) else {
        refuse("payload_id", "The payload id is not a component id")
    }

    guard let reason = signingReason(schema: schema, id: id, sourceHash: object["sourceHash"] as? String) else {
        refuse("payload_schema", "An approval payload has no sourceHash")
    }

    #if GUANXI_SIGNER_TESTING
    guard let keyPath = testKeyPath() else {
        refuse("test_key_missing", "SIGNER_TEST_KEY is required for the test build")
    }
    guard FileManager.default.fileExists(atPath: testItemPath(keyPath)) else {
        refuse("signing_key_missing", "No approval key exists for this service and account")
    }
    do {
        try testAuthenticate(reason)
        let key = try loadTestKey()
        let signature = try key.signature(for: payloadData)
        emit([
            "ok": true,
            "keyId": keyIdentifier(publicKeyDER: key.publicKey.derRepresentation),
            "signature": signature.rawRepresentation.base64EncodedString(),
        ])
        exit(0)
    } catch let failure as HelperFailure {
        refuse(failure.code, failure.message)
    } catch {
        refuse("signing_denied", "The owner cancelled or failed authentication")
    }
    #else
    guard SecureEnclave.isAvailable else {
        refuse("platform_unsupported", "This Mac has no Secure Enclave")
    }
    let blob: Data
    do {
        blob = try keychainData(service: service, account: account)
    } catch let failure as HelperFailure {
        refuse(failure.code, failure.message)
    } catch {
        refuse("keychain_access_unavailable", "Cannot read the wrapped approval key")
    }
    let context = makeConfirmationContext(reason: reason)
    do {
        let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: context)
        let signature = try key.signature(for: payloadData)
        emit([
            "ok": true,
            "keyId": keyIdentifier(publicKeyDER: key.publicKey.derRepresentation),
            "signature": signature.rawRepresentation.base64EncodedString(),
        ])
        exit(0)
    } catch let error as LAError {
        _ = error
        refuse("signing_denied", "The owner cancelled or failed authentication")
    } catch {
        let failure = error as NSError
        if failure.domain == "com.apple.LocalAuthentication" {
            refuse("signing_denied", "The owner cancelled or failed authentication")
        }
        refuse("signing_key_invalid", "The Secure Enclave could not load or use the approval key")
    }
    #endif
}

#if GUANXI_SIGNER_TESTING
/// Introspection only: calls the production access-control and confirmation-context builders
/// with a seeded reuse value. It never loads a key, prompts, signs or writes a keychain item.
func operationTestPolicyProbe(payload: String) {
    guard let object = (try? JSONSerialization.jsonObject(with: Data(payload.utf8))) as? [String: Any],
          let schema = object["schema"] as? String,
          let id = object["id"] as? String,
          let reason = signingReason(schema: schema, id: id, sourceHash: object["sourceHash"] as? String) else {
        refuse("payload_schema", "The test policy probe needs an approval or revocation payload")
    }
    do {
        let policy = approvalKeyAccessPolicy()
        _ = try makeApprovalAccessControl()
        let seeded = LAContext()
        seeded.touchIDAuthenticationAllowableReuseDuration = 120
        let context = configureConfirmationContext(seeded, reason: reason)
        emit([
            "ok": true,
            "accessControlCreated": true,
            "accessibilityDeviceOnly": CFEqual(policy.accessibility, kSecAttrAccessibleWhenUnlockedThisDeviceOnly),
            "privateKeyUsage": policy.accessFlags.contains(.privateKeyUsage),
            "userPresence": policy.accessFlags.contains(.userPresence),
            "confirmationReuseDuration": context.touchIDAuthenticationAllowableReuseDuration,
            "localizedReason": context.localizedReason,
        ])
        exit(0)
    } catch let failure as HelperFailure {
        refuse(failure.code, failure.message)
    } catch {
        refuse("keychain_access_unavailable", "Cannot create the confirmation policy")
    }
}
#endif

// MARK: - Main

#if GUANXI_SIGNER_TESTING
guard testKeyPath() != nil else {
    refuse("test_key_missing", "SIGNER_TEST_KEY is required for the test build")
}
#endif

let input = FileHandle.standardInput.readDataToEndOfFile()
guard !input.isEmpty, let request = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any] else {
    usage("expected one JSON request object on stdin")
}
guard let operation = request["op"] as? String else {
    usage("request.op is required")
}
guard let service = request["service"] as? String, !service.isEmpty,
      let account = request["account"] as? String, !account.isEmpty else {
    usage("request.service and request.account are required")
}
let keychainPath = request["keychain"] as? String

switch operation {
#if GUANXI_SIGNER_TESTING
case "test-policy":
    guard let payload = request["payload"] as? String else {
        usage("request.payload is required for test-policy")
    }
    operationTestPolicyProbe(payload: payload)
#endif
case "status":
    operationStatus(service: service, account: account, keychainPath: keychainPath)
case "init":
    operationInit(service: service, account: account, keychainPath: keychainPath)
case "sign":
    guard let payload = request["payload"] as? String else {
        usage("request.payload is required for sign")
    }
    operationSign(service: service, account: account, payload: payload)
default:
    usage("unknown request.op \"\(operation)\"")
}

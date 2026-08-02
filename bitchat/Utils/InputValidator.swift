import Foundation
import BitLogger

/// Comprehensive input validation for BitChat protocol
/// Prevents injection attacks, buffer overflows, and malformed data
struct InputValidator {
    
    // MARK: - Constants
    
    struct Limits {
        static let maxNicknameLength = 50
        /// Public messages share one cross-transport receive policy. The mesh
        /// v1 frame can carry more, but bridge/shared-content paths already
        /// cap text at 16 KiB and receivers historically dropped content above
        /// 16,000 characters. Express the contract in UTF-8 bytes so Unicode
        /// cannot pass validation and later fail binary encoding.
        static let maxPublicMessageBytes = 16_000

        /// `PrivateMessagePacket` is the deployed iOS/Android wire format and
        /// stores the content TLV length in one byte. Keep this compatibility
        /// limit explicit until a versioned extended-length packet ships.
        static let maxPrivateMessageBytes = PrivateMessagePacket.maxContentBytes

        /// Group TLVs use UInt16 lengths. Leave room below the wire maximum for
        /// the other signed fields and encryption envelope.
        static let maxGroupMessageBytes = 60_000
    }
    
    // MARK: - String Content Validation
    
    /// Validates and sanitizes user-provided strings used in UI
    ///
    /// Rejects strings containing control characters to prevent potential security issues
    /// and UI rendering problems. This strict approach ensures data integrity at input time.
    static func validateUserString(_ string: String, maxLength: Int) -> String? {
        guard let trimmed = string.trimmedOrNilIfEmpty, trimmed.count <= maxLength else { return nil }

        // Reject control characters outright instead of rewriting the string.
        // This prevents injection attacks and ensures consistent UI rendering.
        let controlChars = CharacterSet.controlCharacters
        if !trimmed.unicodeScalars.allSatisfy({ !controlChars.contains($0) }) {
            // Log rejection for monitoring, without exposing actual content for privacy
            let controlCharCount = trimmed.unicodeScalars.filter { controlChars.contains($0) }.count
            SecureLogger.debug(
                "Input validation rejected string (length: \(trimmed.count), control chars: \(controlCharCount))",
                category: .security
            )
            return nil
        }

        return trimmed
    }
    
    /// Validates nickname
    static func validateNickname(_ nickname: String) -> String? {
        return validateUserString(nickname, maxLength: Limits.maxNicknameLength)
    }

    /// Trims and validates message text against a UTF-8 byte limit.
    ///
    /// Message wire formats encode byte lengths, while `String.count` counts
    /// extended grapheme clusters. Keeping this check byte-based prevents
    /// multibyte Unicode from being accepted by the UI and rejected later by
    /// a transport encoder.
    static func validateMessage(_ message: String, maxUTF8Bytes: Int) -> String? {
        guard let trimmed = message.trimmedOrNilIfEmpty,
              trimmed.utf8.count <= maxUTF8Bytes else {
            return nil
        }
        return trimmed
    }

    static func validatePublicMessage(_ message: String) -> String? {
        validateMessage(message, maxUTF8Bytes: Limits.maxPublicMessageBytes)
    }

    static func validatePrivateMessage(_ message: String) -> String? {
        validateMessage(message, maxUTF8Bytes: Limits.maxPrivateMessageBytes)
    }

    static func validateGroupMessage(_ message: String) -> String? {
        validateMessage(message, maxUTF8Bytes: Limits.maxGroupMessageBytes)
    }
    
    // MARK: - Protocol Field Validation

    // Note: Message type validation is performed closer to decoding using
    // MessageType/NoisePayloadType enums; keeping validator free of stale lists.

    /// Validates timestamp is reasonable (not too far in past or future)
    /// BCH-01-011: Reduced from ±1 hour to ±5 minutes to limit replay attack window
    static func validateTimestamp(_ timestamp: Date) -> Bool {
        let now = Date()
        // 5 minutes = 300 seconds (industry standard for replay protection)
        let fiveMinutesAgo = now.addingTimeInterval(-300)
        let fiveMinutesFromNow = now.addingTimeInterval(300)
        return timestamp >= fiveMinutesAgo && timestamp <= fiveMinutesFromNow
    }

}

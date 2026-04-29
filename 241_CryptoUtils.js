"use strict";

/**
 * gitCode_Redesign - Cryptography Utilities
 * Provides stable hashing for row-key generation.
 */
const CryptoUtils = {
  /**
   * Generates a stable SHA-256 hash for a given string.
   * Used primarily for Key1/Key2 generation in mapping logic.
   */
  generateHash(input) {
    if (!input) return "";
    
    // GAS native hashing
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(input));
    
    // Convert to hex string
    return digest.map(byte => {
      const v = (byte < 0) ? 256 + byte : byte;
      return v.toString(16).padStart(2, '0');
    }).join('');
  }
};

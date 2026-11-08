/**
 * Integration contract version (docs/INTEGRATION_CONTRACT.md). Additive changes bump the minor
 * version; renaming or removing a reducer, view, field or enum value requires a new major version.
 * The module reports the same value through the `backend_info` view.
 */
export const CONTRACT_VERSION = '1.1.0';

/** Maximum accepted lifetime (exp - iat) of a human user's token once the issuer policy is enforced. */
export const MAX_USER_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

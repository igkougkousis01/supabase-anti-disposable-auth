/**
 * Fixed facts about the Supabase Management API and the hook this tool manages.
 *
 * Everything here is a compile-time constant on purpose. The destination host, the
 * endpoint path and the hook URI are not configuration: an operator has no legitimate
 * reason to redirect this tool's authenticated requests somewhere else, and a hostile
 * one has every reason to want them to. A settable base URL would turn a CLI holding a
 * Management API token into a credential-exfiltration primitive, which is the same
 * reasoning that keeps the blocklist provider list compiled in (see
 * `src/blocklist/provider.ts`).
 *
 * Tests reach the client through dependency injection instead — see
 * `ManagementClientOptions.baseUrl`, which is not wired to any flag or variable.
 */

/**
 * The official Management API origin.
 *
 * Verified against the published OpenAPI document at
 * `https://api.supabase.com/api/v1-json`, whose paths are rooted at `/v1`.
 */
export const MANAGEMENT_API_BASE_URL = 'https://api.supabase.com';

/**
 * The Auth configuration endpoint, relative to the base URL.
 *
 * `GET` requires Auth-configuration read permission (`auth:read` / `auth_config_read`);
 * `PATCH` requires write permission (`auth:write` / `auth_config_write` plus
 * `project_admin_write`).
 */
export const AUTH_CONFIG_PATH_SEGMENTS = ['v1', 'projects', ':ref', 'config', 'auth'] as const;

/**
 * The one URI this tool ever asks Supabase Auth to call.
 *
 * Defined once, here, and imported by the client, the commands, the status report, the
 * tests and the docs generator for `.env.example`. A second copy of this string is a
 * second thing to get wrong, and getting it wrong means Auth calls a function that does
 * not exist and every signup fails.
 *
 * The `pg-functions://<database>/<schema>/<function>` form is Supabase's documented
 * scheme for a Postgres-backed auth hook.
 */
export const BEFORE_USER_CREATED_HOOK_URI = 'pg-functions://postgres/guard/before_user_created';

/**
 * Shape of a Supabase project reference.
 *
 * The published OpenAPI document constrains `ref` to exactly 20 characters matching
 * `^[a-z]+$`. Real project refs may also contain digits, so this pattern is one
 * character class wider than the spec — deliberately, because rejecting a valid ref
 * would make the tool unusable for that project, whereas accepting a ref the API does
 * not recognise merely produces a clean 404.
 *
 * The security property this carries is unchanged either way: the class excludes `/`,
 * `.`, `%`, `?`, `#`, `:` and whitespace, so a ref can never escape its path segment,
 * traverse to another endpoint, or smuggle a query string into an authenticated
 * request.
 */
export const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;

export const PROJECT_REF_LENGTH = 20;

/**
 * 15 seconds, matching `src/blocklist/fetch.ts`.
 *
 * The `hook` commands are foreground commands an operator is watching. A stalled
 * connection that never fails is worse than a clear failure they can rerun, and the
 * post-write verification path in particular must not be able to hang after a PATCH
 * has already been sent.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * 2 MiB.
 *
 * The Auth configuration document is a few kilobytes. This ceiling exists so a broken
 * or hostile endpoint cannot stream unbounded data into a CLI process, and is applied
 * to bytes actually received rather than to the `content-length` a server claims.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Media types the Management API is expected to answer with. */
export const ACCEPTED_CONTENT_TYPES = ['application/json'] as const;

/**
 * Longest server-supplied text ever echoed into a hint.
 *
 * Server messages are useful ("Auth Hooks can only be configured on Team or Enterprise
 * Plans" is exactly what an operator needs to see) but they are attacker-influenced
 * text arriving over the network, so they are sanitised and capped rather than trusted.
 */
export const MAX_SERVER_MESSAGE_LENGTH = 200;

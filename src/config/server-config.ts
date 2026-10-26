/**
 * @fileoverview Server-specific configuration for openlibrary-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { config, parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      'Apply page and identifier batch ceilings instead of rejecting an oversized request.',
    ),
  userAgent: z
    .string()
    .default('openlibrary-mcp-server casey@caseyjhand.com')
    .describe(
      'User-Agent header sent with all Open Library API requests. Open Library blocks bot-style name/version UA strings — use a plain descriptive string with a contact email.',
    ),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

/** Resolve operator settings after framework dotenv loading, before tool schemas are built. */
export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  // Tool schemas are constructed on import; load the framework's .env before fixing their limits.
  void config.environment;
  _config ??= parseEnvConfig(ServerConfigSchema, {
    clampLimits: 'OPENLIBRARY_CLAMP_LIMITS',
    userAgent: 'OPENLIBRARY_USER_AGENT',
  });
  return _config;
}

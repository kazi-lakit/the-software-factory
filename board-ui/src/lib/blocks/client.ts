import { createBlocksClient } from "@seliseblocks/client";
import { blocksConfig } from "./config";
import { handleUnauthorized } from "./auth";

// Single Blocks API entry point for this app's Auth, IAM and Localization
// calls (Board data goes through core's SdkBlocksData, see ../board.ts).
// Cookie mode only: no `accessToken` resolver, so the SDK never sends an
// Authorization header and the browser sends the httpOnly session cookie
// (`credentials: "include"`). `onUnauthorized` renews that cookie after a
// 401 (ported from ACR origin/main apps/web/src/lib/blocks/client.ts).
export const blocksClient = createBlocksClient({
  apiUrl: blocksConfig.apiUrl,
  appDomain: blocksConfig.appDomain,
  onUnauthorized: () => handleUnauthorized(),
  oidc: {
    clientId: blocksConfig.oidcClientId,
    scope: blocksConfig.oidcScope,
    url: blocksConfig.oidcUrl
  },
  xBlocksKey: blocksConfig.xBlocksKey
});

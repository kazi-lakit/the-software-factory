import { BlocksStore, SdkBlocksData, type TokenSource } from "@factory/core";
import { blocksConfig } from "./blocks/config";
import { handleUnauthorized } from "./blocks/auth";

// Cookie mode: get() hands out no token, so SdkBlocksData sends no
// Authorization header and the browser sends the httpOnly session cookie.
// On a 401 SdkBlocksData awaits invalidate() before its one retry, so the
// retry carries the renewed cookie. It is the same path as the SDK's
// onUnauthorized hook: only a rejected renewal ends the session; an
// unavailable one leaves it to the next status check.
// (Token-source wiring ported from ACR apps/web/src/acr/client.ts.)
export const cookieTokenSource: TokenSource = {
  get: async () => "",
  invalidate: () => handleUnauthorized()
};

// The Board's data client: core's BlocksStore over Blocks Data, acting as the owner.
export const boardStore = new BlocksStore(
  new SdkBlocksData({ apiUrl: blocksConfig.apiUrl, projectKey: blocksConfig.xBlocksKey, token: cookieTokenSource }),
  "owner"
);

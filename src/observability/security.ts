// Re-export the Bun-free browser-security helpers from their shared home.
//
// The implementations used to live in this file, but `engine/review.ts`
// (a non-server module) reached in to grab `applyBrowserSecurityHeaders`,
// violating AGENTS.md's "Bun-isolated" rule. The pure helpers now live in
// `src/shared/browser-security.ts`; this file is a re-export shim so existing
// imports (`from "../observability/security"`, `from "../../observability/security"`,
// and `tests/security.test.ts`'s `from "../src/observability/security.ts"`) keep
// compiling without churn.
export {
  type BrowserSecurityProfile,
  applyBrowserSecurityHeaders,
  hasExpectedHost,
  isSameOriginRequest,
  isSameOriginWrite,
  isAuthorizedWrite,
  writeGateResponse,
} from "../shared/browser-security";

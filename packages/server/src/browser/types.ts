/**
 * Browser policy types shared by the pure origin policy and its callers (ADR-0035).
 *
 * The run policy is immutable for the life of a run. Origins are canonical origins as returned
 * by `normalizeOrigin`: `scheme://host[:port]`, lowercase host, IDN in punycode and default
 * ports omitted. `addReadable` on a decision is the only origin mutation the policy function
 * can propose: the caller appends it to the run's readable set and never to the writable set.
 */

/** How much a run may do on the web. */
export type BrowserMode = 'read_only' | 'full'

/** The immutable per-run origin sets. Both arrays contain canonical origins. */
export interface RunBrowserPolicy {
  mode: BrowserMode
  /** Origins the run may load without another grant. */
  readable: string[]
  /** Origins the run may type, submit, upload to and download from in `full` mode. */
  writable: string[]
}

/**
 * One browser action to authorize.
 *
 * `navigate` names a URL, not an origin, because clean-link and model data rules inspect the
 * path and query. Every other action names the origin it acts on. `fromOrigin` is the page the
 * run is on; a clean link can add a new readable origin only from a readable page.
 *
 * `via` and `fromOrigin` are host assertions, not authenticated facts. A route or tool boundary
 * must derive them from its own navigation state and never from model/tool JSON; otherwise a
 * caller can claim `policy` or `clean_link` to bypass the model-data rule.
 */
export type BrowserAction =
  | {
      kind: 'navigate'
      url: string
      via: 'policy' | 'clean_link' | 'model'
      fromOrigin?: string
    }
  | { kind: 'type' | 'submit' | 'upload' | 'download' | 'click'; origin: string }

/** Stable low-cardinality outcomes. Callers log these; tests assert on them. */
export type BrowserDecisionCode =
  | 'allowed'
  /** Malformed action: a missing/unknown `via` at the untyped boundary. */
  | 'invalid_action'
  | 'origin_not_allowed'
  | 'data_url_refused'
  | 'read_only'
  | 'write_not_allowed'
  | 'scheme_refused'
  | 'invalid_url'

/** One pure authorization decision. */
export interface BrowserDecision {
  allowed: boolean
  code: BrowserDecisionCode
  /** Present only when a clean link adds one new readable origin. */
  addReadable?: string
}

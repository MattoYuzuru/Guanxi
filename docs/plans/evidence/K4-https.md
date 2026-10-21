# K4 positive HTTPS evidence

**Status:** independently reviewed, merged locally · **Updated:** 2026-10-22

Source `8803855` adds one synthetic local HTTPS case to the real sandbox envelope.
No production source or default trust setting changes. A cloned test launcher adds a
temporary public issuer certificate to the Node worker's startup trust input. All proxy,
method-policy and client trust-bundle code remains intact. No host trust store is modified.

**New:** 1 test. Independent scoped execution passes1/1, zero skipped,
`check-b8yfmxg4` at clean8803855; author observation `check-qapk2wra`, server typecheck
`check-6aoq4pmo`. Separate GPT review found no blocker; local report
`Guanxi-lanes/reviews/codex-k4-https-20261022.md`.

Assertions cover successful GET/HEAD/OPTIONS with ordinary certificate verification,
read-only POST/PUT/DELETE denied before forwarding, full-access POST success, untrusted
issuer failure and trusted-issuer hostname mismatch failure. Exact upstream method arrays
prove blocked requests reached the local HTTP handler zero times. The positive requests
never use curl's insecure option. Fixtures contain no owner data or external network.

This is Mac/Colima evidence; repaired-source Linux and other platform envelopes remain
unmeasured. Existing OpenSSL/curl and provisioned sandbox prerequisites are required.
Whole-core post-merge regression is pending, separately from this one new case.

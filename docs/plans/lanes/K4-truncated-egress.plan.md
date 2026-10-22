# K4 known-truncated excerpt egress repair

Status: authorized bounded repair · Base: `622addc` · Local synthetic fixtures only.

1. Reproduce the late long-secret prefix through old list/summary and outward v2 reads.
   Retain the original outside U1-page probe; this checkout has no new page API.
2. Add an optional synchronous `scrubTruncatedPrefix` egress port. The actual scrubber uses
   cached private KMP prefix tables for its existing raw/JSON/URI forms, combines complete
   and nonempty boundary-prefix matches with the existing overlap/marker renderer, and
   exposes no values. Ordinary exact `scrub` semantics stay unchanged.
3. Centralize artifact excerpt read projection. Establish original truncation from original
   byteSize/excerptBytes/UTF-8 content before redaction; protect before title/search/snippet
   clipping, bound UTF-8 without splitting markers, and recompute excerptBytes. Missing
   optional capability withholds only an affected truncated excerpt, never returns it raw.
4. Use the projection for list/summary and v2 event reads, including per-frame outward
   rereads and export. Search candidates may use existing FTS but surviving terms/snippets
   must use a newly projected v2 event. Stored payload/hash/FTS/identity remain unchanged.
5. Assert raw/JSON/URI, one-character and overlap suffixes, UTF-8/marker boundaries,
   protected-title-before-clip, zero protected search hits plus useful ordinary results,
   direct read/export/resumed SSE after an earlier read, immutable DB and zero artifact IO.
   Preserve v1 and version negotiation. Focused pure Node + server TypeScript are local light;
   broader server envelope uses shared heavy. No UI/schema/migration/package changes.

Independent author-separated GPT review follows the clean source pin. Root owns integration,
new U1-page probe rerun and full gates; this repair does not close all K4 residual scope.

Independent review follow-up: append-time markers may erase the byte comparison's original
truncation proof. `c2ae12f` conservatively protects those ambiguous stored-marker boundaries;
two short valid prompt/tool regressions and the unchanged outside probe cover the correction.
The separate independent recheck closed at that pin; see the lane handoff for exact evidence.

# Task content staging

**Status:** implemented and fixture-validated. No public 50-fresh/30-Verified corpus has
been staged or executed by this slice.

`inspectTaskDirectory(directory)` returns a versioned manifest of ordinary files beneath
an ordinary directory. Paths use `/` separators and UTF-8 byte sorting. Each file records
its byte length and SHA-256. The revision streams each relative path, NUL and raw 32-byte
file digest into SHA-256. The manifest covers file names and bytes; it does not cover empty
directories or executable bits. It refuses symlinks, nonregular entries, invalid UTF-8 names
and observed source changes. Supply an unambiguous directory path: `.` and `..` components
are refused before traversal, including paths combining a symlink with `..`.

`verifyTaskDirectory({ path, revision })` requires a 64-character content revision and
re-inspects the directory. A historical Git commit or metadata digest is not a substitute
for this task-content revision. `stageTaskDirectory(source, destinationRoot, revision)`
copies matching bytes into a private temporary directory beside the publication target,
verifies the copy, then atomically renames it to `destinationRoot/<revision>`. Identical
existing content is verified and reused; a conflicting destination is refused. The
destination must be outside the source, including through existing links.

New publication directories use `0700` and files `0600`. These are access permissions, not
protection against the owning user changing bytes. An existing destination root's mode is
not rewritten. Consumers must revalidate before use and keep the execution/verifier
boundary independent. Task image preparation must deliberately restore any required
executable bits; staging does not infer them from a source archive.

Concurrent publication uses a per-revision exclusive lock. A crash can leave an unpublished
temporary directory or stale lock; the next caller refuses `publish_busy` rather than
guessing ownership or deleting another publisher's state. No fsync or power-loss durability
claim is made. Cleanup removes only this call's unpublished temporary directory.

The 12 synthetic tests cover deterministic digests, byte changes, bad entries, publication,
idempotence/conflicts, source/destination boundaries and concurrent behavior. A separate
independent review found the source `link/../source` lexical/filesystem mismatch; its separate
fix rejects dot components, and the new regression fails when that guard is removed. These
tests do not validate a real task image, hidden verifier, upstream source license or corpus
freshness. Stock real/paid execution remains disabled.

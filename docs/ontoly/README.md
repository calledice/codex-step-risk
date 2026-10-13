# Portable Ontoly graph

`SoftwareGraph.json` is the Ontoly 1.3.5 snapshot from 2026-10-10 at hash
`0lhq8ug`. The only edits to Ontoly's raw output replace absolute workspace
paths with `.` in `repository.root` and the workspace node's `metadata.root`.
Ontoly diff reports the same 88 nodes, 151 edges, and deterministic hash,
with no added or removed nodes or edges.

To refresh, run `pnpm dlx @0xsarwagya/ontoly-cli@1.3.5 build . --output .ontoly`
from the repository root, then copy `.ontoly/SoftwareGraph.json` here after
sanitizing those two path fields. See `../ONTOLOGY_CURRENT.md` for the readable
architecture summary and evidence limits.

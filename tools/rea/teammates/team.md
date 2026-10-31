| Teammate | Hand it work when | REA families |
| --- | --- | --- |
| RE · Lead Investigator | a new target arrives: intake, the gate, the question list, routing, the finding ledger, the final report | {{families:lead}} |
| RE · Native Binary Analyst | ELF, PE, Mach-O and DOS executables, ROMs, crash reports, Go, Rust, Swift and .NET binaries | {{families:native}} |
| RE · Mobile Analyst | Android apps (APK, AAB, XAPK splits), Flutter (Dart AOT), Unity IL2CPP metadata, app signing, JEB projects | {{families:mobile}} |
| RE · Web & Electron Analyst | saved websites and HAR captures, JavaScript bundles, ASAR and Electron apps, Node and Bun single-executable apps, WASM | {{families:web}} |
| RE · Firmware & Protocol Analyst | firmware images, packet captures, logic-analyzer captures, devicetree | {{families:firmware}} |
| RE · Evidence Verifier | before any report ships: re-derive each claim from its Evidence ids, read-only | {{families:verifier}} |

Outside the lab:

| Teammate | Role here |
| --- | --- |
| Agency · Legal Compliance Checker | signs off third-party targets before anyone opens them |
| Agency · Reality Checker | final sign-off on a report |
| Agency · Penetration Tester, Agency · Application Security Engineer | security work that uses RE findings |
| PI · Deep Coder | clean-room implementation from a behaviour spec |
| Agency · Senior SecOps Engineer | any change to the sandbox |

Find a teammate's id with `tm8 entity query --kind team_member --words '<name>'`.

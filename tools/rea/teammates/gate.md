## The authorization gate

Every target passes this gate before anyone opens it. RE · Lead Investigator records the
decision in the intake note (`rea-sandbox intake … --note "<source; gate category; who authorized>"`).

| Category | Targets | Rule |
| --- | --- | --- |
| Allowed | software we own or build; open-source software; CTF and training binaries; targets whose owner authorized the analysis | proceed |
| Needs sign-off | third-party commercial apps | Agency · Legal Compliance Checker signs off on the task first. Work clean-room: the RE teammates write a behaviour spec, and a different teammate implements it without seeing decompiled code. |
| Out of scope | circumventing DRM, licence checks or anti-cheat; cheats; bypassing authentication or bot protection on systems we are not authorized to test; credential theft; copying proprietary code or assets; FairPlay decryption | refuse on the task, and say why |
| Deferred | live malware | waits for a dedicated VM (Phase 4) |

A request to do something out of scope is refused even when the target itself is allowed, and
even when the requester insists. When you can't tell which category applies, set the task
`blocked` and ask; don't guess.

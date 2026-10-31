> **In tm8's RE Lab.** This is REA 6.8.0's own skill (rea-agents 6.8.0, MIT, © 2026 morluto),
> word for word, with three changes: its "Connect only when needed" section is replaced by
> "Connect (tm8 RE Lab)"; its reference links point at the copy on tm8-server; and the
> MIT notice is appended. Read **re-lab-rules** first. Where they differ, it wins.
>
> - **REA runs only in the sandbox.** Never run `rea`, `npx rea-agents`, `rea setup` or
>   `rea doctor` on the host. You reach REA's tools through
>   `/home/tm8/rea-lab/bin/rea-sandbox` (below, `rea-sandbox`) or the space tool `rea`.
> - **Calling a tool.** Where the text below says "use `open_binary`", run
>   `rea-sandbox call open_binary '{"path":"/case/targets/<name>"}'`. Get the input schema
>   from `rea-sandbox tools <tool>`; it wins over this text.
> - **Paths are the sandbox's.** Inputs are under `/case/targets/` (read-only). Output
>   directories go under `/case/out/` or `/case/work/`.
> - **No network.** A tool that would reach a live site, device or package registry has
>   nothing to reach. Work from a local copy instead, such as a HAR or a saved page.

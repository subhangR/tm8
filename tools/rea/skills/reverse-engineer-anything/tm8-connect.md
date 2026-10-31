## Connect (tm8 RE Lab)

REA 6.8.0 and its engines are already installed. Don't install, register or repair anything;
that is the lab owner's job.

```sh
rea-sandbox scope            # your role, tool families, engines and case
rea-sandbox tools            # the tools you may call
rea-sandbox tools <tool>     # one tool's input schema
rea-sandbox doctor [engine]  # REA's doctor inside your sandbox, if an engine looks missing
```

What each exit status from `rea-sandbox call` means:

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | REA answered | Read the Evidence. |
| 1 | REA answered with an error | Read it, and change the call before you retry. |
| 2 | Bad input, or REA is unavailable | Retry once. If it fails again, set your task `blocked` with the message. |
| 3 | The tool is outside your role or profile | Hand the question to the teammate the message names. |

When REA's guides discuss MCP registration, client restarts or `rea setup`, they don't apply
here. The table above is the recovery path.


# device-test — real-screen tests recorded as tm8 entities

Drives a real screen with callstack's [agent-device](https://github.com/callstack/agent-device)
and records each run as a `c:test_run` entity with its screenshots attached. A test is
something in the graph that a person or an agent can open, not a line in a log.

    platform   the screen                                          on this host
    web        Chromium (Chrome for Testing 156) in a container    runs here
    android    a Limrun emulator, or a device behind a proxy       blocked: no /dev/kvm
    ios        a Limrun simulator, or a Mac behind a proxy         blocked: iOS needs macOS

## Run

As a tm8 tool, from any session in the Space:

    tm8 tool run device-test --target https://tm8-hub.com/ --expect-text "one live graph" \
        --profiles desktop,iphone,pixel --task <task-id>

Or straight from a checkout, with the same flags:

    python3 -I tools/device-test/device_test.py --target https://tm8-hub.com/ --no-record

`--no-record` writes nothing to tm8: screenshots, logs and `report.json` stay in `--out`.
That defaults to `device-test/<UTC time>` under the tool run's directory, or under the current
directory outside a tool run.

`--profiles desktop,iphone,pixel` gives one run per profile at 1280×900, 390×844 and 412×915.
**`iphone` and `pixel` are Chromium at that size with that user agent, not the phone.** They
catch layout breaks. They are not Safari or Android Chrome, and every record says so.

Exit status: `0` passed, `1` failed, `2` error, `3` blocked, `64` bad arguments (nothing is
written). A batch exits with its worst result.

## What a run records

Register the kind once per Space:

    tm8 kind create c:test_run --schema @tools/device-test/test_run.schema.json --icon ▣

Each run is titled like `web · tm8-hub.com · iphone — passed` and moves through
`queued → running → passed | failed | error | blocked`:

    passed    every step ran
    failed    the product failed a step: the page did not load, or the text never appeared.
              `failure` names the step and the spec line; the screenshot before it is kept
    error     the harness failed, not the product: Docker, the image build, a timeout, or no
              JSON from agent-device. It says nothing about the target
    blocked   no device was reachable. `blocker` gives the host evidence and the options.
              Never faked

The other fields are `target`, `revision`, `device`, `viewport`, `provider`, `engine`, `suite`,
`runner` (this file's sha256 and the image tag), the step counts, `screenshots`, `duration_ms`,
`started_at`, `finished_at` and `summary`.

Every screenshot is a file attached to its run. With `--task`, each run is related to the
task, and the verdict is posted there with up to 12 screenshots. `--run <id>` records the first
run into an existing `c:test_run`, such as one queued from the UI.

## The checks

The built-in web check is one replay per profile:

1. Open the target, set the viewport, wait 1.5 s and save `01-loaded.png`.
2. Wait up to 20 s for `--expect-text`.
3. Save the full page as `02-full-page.png`.

On Android and iOS it opens the URL in the device's own browser (Chrome or Safari).

`--suite flow.ad` runs your own agent-device replay script instead. Its grammar is in
agent-device's `website/docs/docs/replay-e2e.md`. The script can use these variables:

- `${TARGET_URL}`
- `${EXPECT_TEXT}`
- `${OUT}`: save screenshots there to have them attached.
- `${APP}`: set by `--app`, for an Android or iOS build the suite installs.

## How a web run is contained

- **The engine image is built once per host.** Its tag is the hash of the Dockerfile embedded in
  `device_test.py`, which `--print-dockerfile` prints. The base is the Playwright
  `v1.64.0-noble` image, pinned by digest. The agent-device 0.21.27 and agent-browser 0.27.1
  tarballs are checked against the sha512 of the bytes that were reviewed, and installed with
  `--ignore-scripts`.
- **The container is locked down:**
  - `--cap-drop ALL` and `no-new-privileges`, running as the caller's uid
  - 3 GB of memory, 2 CPUs and 1024 processes
  - the spec mounted read-only, with only the run's output directory writable
- **The browser can only reach the target.** agent-browser's allow-list admits the target's
  domain and its subdomains. Anything else is refused unless `--allow-domains` adds it. The
  default `--network bridge` cannot reach this host's loopback. Use `--network host` to test a
  local server.
- **Secrets are passed by name**, as `docker run -e NAME`. Their values never appear in argv or
  in a run record.

### Why web runs use a seccomp profile

This host's CPU advertises memory protection keys (`pku`, `ospke`), but they fault under
Hyper-V. Every Chrome 156 child process dies of a protection-key page fault (error-code bit 5).
Web runs therefore use Docker's default seccomp profile with one change: `pkey_alloc` answers
`ENOSPC`. Chrome and V8 then run without keys, as they would on a CPU that has none.

The default profile is embedded in `device_test.py` (Docker 29.7.2), and the tests pin its
sha256. `--print-seccomp` prints the exact profile a web run gets.

## Android and iOS

This host cannot run either one:

- An Android emulator needs KVM. This host is a Hyper-V guest with no `/dev/kvm` and no
  `vmx` or `svm` CPU flag.
- iOS Simulators need macOS with Xcode, and this host runs Linux.

The device therefore comes from somewhere else:

    --provider limrun   Limrun's hosted Android emulators and iOS simulators.
                        Secret limrun_api_key: agent-device creates an instance for the run and
                        deletes it when the run lets it go. Or set the lim_*_instance_* inputs to
                        use an instance you made; agent-device never creates or deletes that one.
    --provider proxy    `agent-device proxy` on a machine that has the device: a Mac for iOS, or
                        a KVM host or a USB phone for Android. Pass --proxy-url and the secret
                        proxy_token. Start the proxy with AGENT_DEVICE_DAEMON_POLICY to confine
                        it to named devices.

A person binds a secret. Agent sessions cannot (`requireHumanSession`):

    printf %s "$KEY" | tm8 tool secret set device-test limrun_api_key --value-stdin

Without a provider or its credential, the run is recorded `blocked`, with the evidence. A
provider that refuses the connection also gives `blocked`.

The Limrun and proxy paths are unit-tested against fakes. They have not yet driven a real
device, because no credential exists in this Space yet.

agent-device also supports BrowserStack, AWS Device Farm and TestMu AI, but this tool does not
yet. Adding one means a branch in `MOBILE_SCRIPT`, `provider_problem` and `provider_env`.

## Tool runs and the Space

A tool run is given `TM8_TOOL_SESSION` but not `TM8_SPACE_ID`, and the CLI refuses
Space-scoped writes without it. So the recorder reads the Space from the tool session entity
(`state.toolRun.spaceId`) before its first write. Follow-up `01a13c8c-1df9` asks tm8 to pass the
Space to tool runs itself.

## Change it

    python3 -I tools/device-test/test_device_test.py
    tm8 tool edit device-test --source @tools/device-test/device_test.py \
        --spec @tools/device-test/tool.json --expect-version <n>

The tests use only the stdlib. They need no Docker and no tm8: subprocess and the recorder are
faked. `tool.json` declares the inputs, and `build_parser` reads each one from the same
`DEVICE_TEST_*` variable, so the two must change together.

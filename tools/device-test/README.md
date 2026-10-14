# device-test — real-screen tests recorded as tm8 entities

Drives a real screen with callstack's [agent-device](https://github.com/callstack/agent-device)
and records each run as a `c:test_run` entity with its screenshots attached. A test is
something in the graph that a person or an agent can open, not a line in a log.

    platform   the screen                                          on this host
    web        Chromium (Chrome for Testing 156) in gVisor         runs here
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
- **Each run gets a kernel of its own.** `--sandbox gvisor`, the default, starts the container
  with gVisor's `runsc` runtime. Chromium has to run with `--no-sandbox`, because its own
  sandbox needs privileges the container does not have. The container is therefore the
  boundary, and under gVisor a browser exploit from an untrusted page reaches gVisor, not this
  host's kernel. `--sandbox runc` uses Docker's default runtime instead. If `runsc` is not
  registered with Docker, the run is an `error` and suggests `--sandbox runc`. On this host a
  gVisor run takes about 30 s per profile, against 10 s under runc.
- **The container is locked down:**
  - `--cap-drop ALL` and `no-new-privileges`, running as the caller's uid
  - 3 GB of memory, 2 CPUs and 1024 processes
  - the spec mounted read-only, with only the run's output directory writable
- **The browser is held to the target.** agent-browser's allow-list admits the target's domain
  and its subdomains. Anything else is refused unless `--allow-domains` adds it, and that
  includes an IP literal such as `http://172.17.0.1/`. The default `--network bridge` cannot reach
  this host's loopback. To test a local server, pass `--network host --sandbox runc`: under
  Docker's host network a gVisor container gets no network at all here (`ENETUNREACH`), so the
  tool refuses that pair before it starts.
- **Secrets are passed by name**, as `docker run -e NAME`. Their values never appear in argv or
  in a run record.

The allow-list does not stop two things, both measured on this host:

- A container on the bridge can open TCP to the host's bridge address (`172.17.0.1`). Ports 22,
  443 and 25432 answered.
- The list matches names, not addresses. `http://localtest.me:8999/` resolves to loopback, and
  the browser connected (`ERR_CONNECTION_REFUSED`) instead of refusing the address.

The allow-list is a browser rule, not a firewall. Closing both gaps needs an egress proxy that
refuses private addresses, on an internal Docker network. That is a follow-up; this tool does
not do it.

### Why runc web runs use a seccomp profile

This host's virtual CPU advertises memory protection keys (`pku`, `ospke`), yet under runc every
Chrome 156 child process dies of a protection-key page fault (error-code bit 5). runc web runs
therefore use Docker's default seccomp profile with one change:
`pkey_alloc` answers `ENOSPC`. Chrome and V8 then run without keys, as they would on a CPU that
has none. gVisor implements the system calls itself and gives Chrome no keys, so gVisor runs need
no profile.

The default profile is embedded in `device_test.py` (Docker 29.7.2), and the tests pin its
sha256. `--print-seccomp` prints the exact profile a web run gets.

## Android and iOS

This host cannot run either one:

- An Android emulator needs KVM. This host is a virtual machine without nested virtualization:
  no `/dev/kvm` and no `vmx` or `svm` CPU flag. It is a QEMU/KVM guest (DMI "Red Hat KVM",
  `kvm-clock`, virtio devices) that advertises Hyper-V enlightenments, which is why
  `systemd-detect-virt` and `lscpu` say "Microsoft". Blocked runs report only what the CPU shows.
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

A remote run takes four steps, and each one names the run's session:

1. `connect` saves the connection. It does not contact the proxy.
2. `open` leases a device. This is where the provider is first reached.
3. `replay` runs the check.
4. `disconnect` releases the device.

A replay cannot lease a device itself. A command under another session name looks for devices
inside the container (`DEVICE_NOT_FOUND`).

The run is recorded `blocked`, with the evidence, when there is no provider, no credential, or a
provider that refuses at step 1 or step 2. The blocker carries agent-device's error code. A
divergence after the lease is the product: `failed`.

The proxy path has run end to end against a real agent-device 0.21.27 proxy with no device
behind it, both in gVisor on this host. Every case was recorded `blocked` at the lease:

    Android             DEVICE_NOT_FOUND: No devices found
    Android, bad token  UNAUTHORIZED: Invalid proxy token
    iOS                 UNSUPPORTED_PLATFORM: Apple tools are only available on macOS

Neither path has driven a real device yet. No Limrun key, Mac or KVM host is in this Space.

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

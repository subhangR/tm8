#!/usr/bin/env -S python3 -I
"""Drive `rea-sandbox mcp` (or any stdio MCP server) through a list of steps, as an MCP client
would, and record each answer.

    tools/rea/mcp-probe.py <out.jsonl> <server argv...> < steps.json

steps.json is a list of {"method": "tools/list"} or
{"method": "tools/call", "name": <tool>, "arguments": {...}}. One JSON line per step
(method, name, wall_s, result or error) goes to out.jsonl, the server's stderr to
out.jsonl.stderr, and a one-line summary per step to stdout.
"""
import json
import subprocess
import sys
import threading
import time


class Client:
    def __init__(self, argv, stderr):
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
                                     text=True, bufsize=1)
        self.pending, self.next_id = {}, 0
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                print("non-JSON from the server:", line[:200], file=sys.stderr)
                continue
            slot = self.pending.get(msg.get("id")) if isinstance(msg, dict) else None
            if slot is not None:
                slot["msg"] = msg
                slot["done"].set()

    def send(self, msg):
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def request(self, method, params, timeout=900):
        self.next_id += 1
        slot = self.pending[self.next_id] = {"done": threading.Event()}
        t0 = time.monotonic()
        self.send({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params})
        answered = slot["done"].wait(timeout)
        del self.pending[self.next_id]
        msg = slot.get("msg") if answered else {"error": "no answer within the client timeout"}
        return msg, round(time.monotonic() - t0, 2)


def main():
    out_path, argv = sys.argv[1], sys.argv[2:]
    steps = json.load(sys.stdin)
    with open(out_path + ".stderr", "w") as err, open(out_path, "w") as out:
        client = Client(argv, err)
        msg, wall = client.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                                  "clientInfo": {"name": "tm8-mcp-probe", "version": "1"}})
        out.write(json.dumps({"method": "initialize", "wall_s": wall, "result": msg.get("result"),
                              "error": msg.get("error")}) + "\n")
        client.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        for step in steps:
            listing = step["method"] == "tools/list"
            params = {} if listing else {"name": step["name"], "arguments": step.get("arguments", {})}
            msg, wall = client.request(step["method"], params)
            rec = {"method": step["method"], "name": step.get("name"), "wall_s": wall,
                   "result": msg.get("result"), "error": msg.get("error")}
            out.write(json.dumps(rec) + "\n")
            out.flush()
            if listing and rec["result"]:
                summary = f"{len(rec['result']['tools'])} tools"
            else:
                summary = json.dumps(rec["result"] or rec["error"])[:300]
            print(f"{step['method']} {step.get('name') or ''} {wall}s -> {summary}", flush=True)
        client.proc.stdin.close()
        try:
            client.proc.wait(60)
        except subprocess.TimeoutExpired:
            client.proc.kill()
    print("server exit", client.proc.returncode)


if __name__ == "__main__":
    main()

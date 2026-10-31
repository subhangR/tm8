#!/usr/bin/env -S python3 -I
"""Build the RE Lab's tm8 teammates as `tm8 entity create team_member --content` JSON.

    tools/rea/teammates/build-teammates.py <rea-sandbox.json> <out-dir>

Each persona is a markdown file here (group.md, lead.md, native.md, ...). Before writing
<out-dir>/<name>.json, it fills these placeholders:

- {{team}}, {{gate}}, {{specialist-work}} and {{load-skills}}, from the .md file of that name;
- {{families}} and {{engines}}, from the persona's own role in rea-sandbox.json;
- {{families:<role>}}, from any role there.

So a persona always states the scope that rea-sandbox actually enforces. The script refuses
to write anything if a placeholder is left over or a role is missing.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL, AGENT_TOOL = "claude-opus-5-5[1m]", "claude-code"

# name -> (rea-sandbox role, tm8 mode, team_members.role label). The group routes like the Lead
# and gets the Lead's REA scope.
TEAMMATES = {
    "group": ("lead", "coordinator", "Reverse-engineering lab"),
    "lead": ("lead", "coordinator", "RE intake, authorization gate, routing and reports"),
    "native": ("native", "worker", "RE: native binaries"),
    "mobile": ("mobile", "worker", "RE: mobile apps"),
    "web": ("web", "worker", "RE: web, Electron and JavaScript"),
    "firmware": ("firmware", "worker", "RE: firmware and protocols"),
    "verifier": ("verifier", "worker", "RE: evidence verification"),
}


def read(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as f:
        return f.read().rstrip("\n")


def engines_text(cfg, role):
    names = cfg["roles"][role].get("engines", [])
    if not names:
        return "none"
    return ", ".join(f"{e} (licensed)" if cfg["engines"].get(e, {}).get("licensed") else e for e in names)


def render(cfg, name, role):
    text = read(f"{name}.md")
    for part in ("team", "gate", "specialist-work", "load-skills"):
        text = text.replace("{{%s}}" % part, read(f"{part}.md"))
    text = text.replace("{{families}}", ", ".join(cfg["roles"][role]["families"]))
    text = text.replace("{{engines}}", engines_text(cfg, role))
    text = re.sub(r"\{\{families:([a-z]+)\}\}", lambda m: ", ".join(cfg["roles"][m.group(1)]["families"]), text)
    left = re.findall(r"\{\{[^}]*\}\}", text)
    if left:
        sys.exit(f"{name}.md: unfilled placeholders {left}")
    return text + "\n"


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    with open(sys.argv[1], encoding="utf-8") as f:
        cfg = json.load(f)
    out = sys.argv[2]
    os.makedirs(out, exist_ok=True)
    for name, (role, mode, label) in TEAMMATES.items():
        if role not in cfg["roles"]:
            sys.exit(f"rea-sandbox.json has no role {role!r}")
        title = "RE Lab" if name == "group" else cfg["roles"][role]["title"]
        content = {"role": label, "identity": render(cfg, name, role), "model": MODEL,
                   "agentTool": AGENT_TOOL, "mode": mode}
        path = os.path.join(out, f"{name}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"title": title, "sandbox_role": role, "content": content}, f, ensure_ascii=False, indent=1)
        print(f"{path}: {title} ({role}, {mode}), identity {len(content['identity'])} chars")


if __name__ == "__main__":
    main()

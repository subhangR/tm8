#!/usr/bin/env -S python3 -I
"""Build the RE Lab's two tm8 space skills as `tm8 entity create skill --content` JSON.

    tools/rea/skills/build-skills.py <rea-share-dir> <out-dir>

<rea-share-dir> holds what sync-skills.sh copied out of the image's rea-agents package
(skills/reverse-engineer-anything/, LICENSE). reverse-engineer-anything is REA's own skill,
checked against the sha256 below, with its "Connect only when needed" section swapped for
tm8-connect.md, its reference links pointed at <rea-share-dir>, tm8-preamble.md on top and
REA's MIT notice at the end. re-lab-rules is SKILL.md here, minus its frontmatter. REA's text
is only read and rewritten as text, never run.
"""
import hashlib
import json
import os
import re
import sys

REA_SKILL_SHA256 = "8818b645c9fd348399a50a8678b91cff20215690adad484e70282ff9f2ef91ee"  # rea-agents 6.8.0
HERE = os.path.dirname(os.path.abspath(__file__))


def split_frontmatter(text):
    m = re.match(r"---\n(.*?)\n---\n+", text, re.S)
    if not m:
        sys.exit("build-skills: no frontmatter")
    fields = {}
    for line in m.group(1).splitlines():
        key, sep, value = line.partition(":")
        if sep and not line.startswith(" "):
            fields[key.strip()] = value.strip()
    return fields, text[m.end():]


def rea_skill(share):
    path = os.path.join(share, "skills", "reverse-engineer-anything", "SKILL.md")
    raw = open(path, "rb").read()
    if hashlib.sha256(raw).hexdigest() != REA_SKILL_SHA256:
        sys.exit(f"build-skills: {path} is not rea-agents 6.8.0's SKILL.md (sha256 mismatch)")
    fields, body = split_frontmatter(raw.decode())
    start, end = body.index("## Connect only when needed\n"), body.index("## Route the target first\n")
    connect = open(os.path.join(HERE, "reverse-engineer-anything", "tm8-connect.md")).read()
    body = body[:start] + connect + body[end:]
    refs = os.path.join(share, "skills", "reverse-engineer-anything", "references") + "/"
    body = body.replace("](references/", "](" + refs).replace("`references/", "`" + refs)
    preamble = open(os.path.join(HERE, "reverse-engineer-anything", "tm8-preamble.md")).read()
    licence = open(os.path.join(share, "LICENSE")).read().strip()
    content = f"{preamble}\n{body.rstrip()}\n\n---\n\nREA's licence:\n\n```text\n{licence}\n```\n"
    description = (fields["description"] + " In tm8: REA 6.8.0's own skill, reached through rea-sandbox;"
                   " read re-lab-rules first.")
    return {"kind": "skill", "name": "reverse-engineer-anything", "description": description,
            "content": content}


def tm8_skill(name):
    fields, body = split_frontmatter(open(os.path.join(HERE, name, "SKILL.md")).read())
    return {"kind": "skill", "name": fields["name"], "description": fields["description"], "content": body}


def main():
    share, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    for skill in (rea_skill(share), tm8_skill("re-lab-rules")):
        path = os.path.join(out, skill["name"] + ".json")
        with open(path, "w") as f:
            json.dump(skill, f, ensure_ascii=False)
        print(f"{path}: {len(skill['content'])} chars")


if __name__ == "__main__":
    main()

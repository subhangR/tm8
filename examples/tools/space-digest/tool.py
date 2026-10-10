#!/usr/bin/env python3
"""Summarise the current space using only the launcher's read-scoped bearer."""
import collections
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def get(path):
    request = urllib.request.Request(
        os.environ["TM8_BASE_URL"].rstrip("/") + path,
        headers={"Authorization": "Bearer " + os.environ["TM8_AGENT_TOKEN"]},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)["data"]


def main():
    session = get("/v2/entities/" + os.environ["TM8_SESSION_ID"])
    space_id = session["spaceId"]
    cursor = int(os.environ["SINCE"])
    initial = cursor
    counts = collections.Counter()
    tasks = {}
    merged_prs = {}
    # Bound the walk; use examinedThrough even when hydration omits items.
    through = initial
    for _ in range(1000):
        page = get("/v2/spaces/" + space_id + "/events?" + urllib.parse.urlencode(
            {"since": cursor, "limit": 200}
        ))
        events = page["items"]
        for event in events:
            counts[event["type"]] += 1
            entity = event.get("entity", {})
            state = entity.get("state", {})
            if event["type"] == "entity.upsert" and entity.get("kind") == "task":
                tasks[entity["id"]] = {"title": entity.get("title", "Task"), "status": state.get("status")}
            if event["type"] == "git.pr_state_changed" and event["state"] == "merged":
                merged_prs[event["prEntityId"]] = f"{event['repo']}#{event['number']}"
        next_cursor = int(page["examinedThrough"])
        through = next_cursor
        if not page["hasMore"]:
            break
        if next_cursor <= cursor:
            raise RuntimeError("Event cursor did not advance")
        cursor = next_cursor
    else:
        raise RuntimeError("Digest exceeds 1000 pages; choose a later --since sequence")
    digest = {"spaceId": space_id, "since": initial, "through": through,
              "eventCount": sum(counts.values()), "events": dict(sorted(counts.items())),
              "tasks": list(tasks.values()), "mergedPullRequests": list(merged_prs.values())}
    if os.environ["FORMAT"] == "json":
        print(json.dumps(digest, ensure_ascii=False))
        return
    print("# Space digest\n")
    print(f"Space: {space_id} · sequences {initial + 1}–{through}\n")
    print(f"Events: {digest['eventCount']}\n")
    for event_type, count in digest["events"].items():
        print(f"- {event_type}: {count}")
    print("\n## Tasks updated\n")
    for task in digest["tasks"]:
        print(f"- {task['title']}: {task['status']}")
    if not tasks:
        print("No task updates.")
    print("\n## Pull requests merged\n")
    for title in digest["mergedPullRequests"]:
        print(f"- {title}")
    if not merged_prs:
        print("No merged pull requests in the event snapshot.")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, RuntimeError, urllib.error.URLError) as error:
        # Never print request headers or the bearer.
        print("space-digest: " + str(error), file=sys.stderr)
        sys.exit(1)

"""Selections freeze exact members AND revision; refresh never widens them."""
from copy import deepcopy

from .api import encoded
from .contracts import hierarchy, reference


def targets(snapshot, refs, branch=False):
    if not snapshot["complete"]:
        raise ValueError("Cannot act on an incomplete Inbox window. Retry the read before selecting IDs.")
    records, threads = {}, {}
    for ref in refs:
        matches = []
        for item in snapshot["items"]:
            if ref in (item["id"], reference(item["id"])):
                matches.append((item, None))
            if item.get("thread"):
                for n in item["thread"]["hierarchy"]["nodes"]:
                    if n["selectable"] and ref in (n["id"], reference(n["id"])) and n["id"] != item["id"]:
                        matches.append((item, n["id"]))
        if len(matches) != 1:
            raise ValueError(f"Selection not loaded or ambiguous: {ref}")
        item, member = matches[0]
        if not item.get("thread"):
            records[item["id"]] = True
            continue
        thread = item["thread"]
        rows, children = hierarchy(thread)
        chosen = set()
        def visit(identifier):
            chosen.add(identifier)
            for child in children[identifier]:
                visit(child)
        if member and not branch:
            chosen.add(member)
        else:
            for root in [member] if member else thread["hierarchy"]["rootIds"]:
                visit(root)
        entry = threads.setdefault(item["id"], dict(threadId=thread["id"], mailbox=thread["mailbox"], revision=thread["revision"], memberIds=[]))
        entry["memberIds"] = list(dict.fromkeys(entry["memberIds"] + [n["id"] for n, _ in rows if n["selectable"] and n["id"] in chosen]))
        if len(entry["memberIds"]) > 1000:
            raise ValueError("Thread action accepts at most 1000 members")
    return {"records": list(records), "threads": threads, "profileId": snapshot["query"]["profileId"]}


async def execute(api, selection):
    result = dict(selectedMemberIds=list(dict.fromkeys(m for t in selection["threads"].values() for m in t["memberIds"])),
                  completedItemIds=[], completedMessageIds=[], skippedMemberIds=[])
    try:
        for identifier, t in selection["threads"].items():
            response = await api.request(f"/api/mail/threads/{encoded(t['threadId'])}/actions",
                                         {"mailbox": t["mailbox"], "revision": t["revision"], "memberIds": t["memberIds"], "action": "read"})
            if response.get("ok") is not True:
                raise ValueError("Invalid thread action response")
            result["completedItemIds"].append(identifier)
            result["completedMessageIds"].extend(response["completedMessageIds"])
            result["skippedMemberIds"].extend(response["skippedMemberIds"])
        for start in range(0, len(selection["records"]), 500):
            batch = selection["records"][start:start + 500]
            await api.request("/api/workbench/attention/bulk", {"profileId": selection["profileId"], "itemKeys": batch, "action": "read"})
            result["completedItemIds"].extend(batch)
    except Exception as exc:
        result["error"] = str(exc)
    return result


class Selection:
    def __init__(self):
        self.entries = {}

    def toggle(self, snapshot, identifier, branch=False):
        plan = targets(snapshot, [identifier], branch)
        members = [(r, {"record": r}) for r in plan["records"]]
        for item_id, t in plan["threads"].items():
            members.extend((m, {"item": item_id, "thread": deepcopy(t), "member": m}) for m in t["memberIds"])
        remove = all(m in self.entries for m, _ in members)
        for m, entry in members:
            if remove:
                self.entries.pop(m, None)
            elif m not in self.entries:
                self.entries[m] = entry

    def plan(self, snapshot):
        if not snapshot["complete"]:
            raise ValueError("Cannot act on incomplete or retained data")
        result = {"records": [], "threads": {}, "profileId": snapshot["query"]["profileId"]}
        for e in self.entries.values():
            if "record" in e:
                result["records"].append(e["record"])
            else:
                t = result["threads"].setdefault(e["item"], {**e["thread"], "memberIds": []})
                if t["revision"] != e["thread"]["revision"]:
                    raise ValueError("Selection spans thread revisions; clear and reselect")
                t["memberIds"].append(e["member"])
        if not self.entries:
            raise ValueError("Select explicit items first")
        if any(len(t["memberIds"]) > 1000 for t in result["threads"].values()):
            raise ValueError("Thread action accepts at most 1000 members; select a smaller set")
        return result

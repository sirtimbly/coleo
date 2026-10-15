"""Task comments with the original CLI's author and reply conventions."""
import os
import subprocess

from rich.console import Group
from rich.markdown import Markdown
from rich.panel import Panel
from rich.text import Text

from .api import encoded
from .presentation import clean


def author():
    identifier = os.getenv("USER") or "unknown"
    name = os.getenv("USER") or "CLI User"
    try:
        email = subprocess.run(["git", "config", "user.email"], capture_output=True, text=True, timeout=5).stdout.strip()
        git_name = subprocess.run(["git", "config", "user.name"], capture_output=True, text=True, timeout=5).stdout.strip()
        identifier, name = email or identifier, git_name or name
    except (OSError, subprocess.TimeoutExpired):
        pass
    return identifier, name


async def run_discussion(api, operation, identifier, message, reply_to, limit, offset):
    if not identifier:
        raise ValueError(f"{operation} requires a task ID")
    path = f"/api/tasks/{encoded(identifier)}/discussions"
    if operation == "discuss":
        if not message or not message.strip():
            raise ValueError("discuss requires a nonempty message")
        author_id, author_name = author()
        body = dict(content=message, authorType="human", authorId=author_id, authorName=author_name, client="cli")
        if reply_to:
            body["parentId"] = reply_to
        result = await api.request(path, body)
        if not isinstance(result.get("comment"), dict) or not isinstance(result["comment"].get("id"), str):
            raise ValueError("Incompatible discussion response; check server state before retrying")
    else:
        if message is not None or reply_to is not None:
            raise ValueError("discussions does not accept a message or --reply-to")
        if not 1 <= limit <= 100 or offset < 0:
            raise ValueError("Discussion limit must be 1–100 and offset must be nonnegative")
        result = await api.request(path, params={"limit": limit, "offset": offset})
        if (not isinstance(result.get("discussions"), list) or type(result.get("totalCount")) is not int
                or any(not isinstance(c, dict) or not isinstance(c.get("content"), str)
                       for c in result["discussions"])):
            raise ValueError("Incompatible discussions response")
    return dict(result, schemaVersion=1, kind="module.discussion" if operation == "discuss" else "module.discussions",
                module="tasks", taskId=identifier)


def render_discussions(result):
    if "comment" in result:
        return Text(f"Comment added: {clean(result['comment']['id'])}")
    return Group(Text(f"Task discussions · {result['totalCount']} total"), *(
        Panel(Markdown(clean(comment["content"])), title=Text(clean(
            comment.get("authorName") or comment.get("authorId", "Unknown"))), subtitle=Text(clean(
            f"{comment.get('id', '')} · {comment.get('createdAt', '')}")))
        for comment in result["discussions"]))

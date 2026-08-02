# Workbench frontend infrastructure

This folder owns reusable application-shell behavior:

- stable resource and projection contracts;
- static contribution registries;
- the single live-update connection and subscription fan-out;
- database-backed profiles, saved views, and layouts;
- shared projection surfaces such as sheets, inboxes, and timelines.

Domain pages should use these services instead of creating their own WebSocket
connections or saving configuration directly to browser storage.


# Image Attachments Flow

The web composer now supports image uploads for both "send to brain" and direct arm prompts.

## Upload path

- The browser posts multipart form data to `POST /api/uploads/images`.
- The API stores the file under `~/.octopai/uploads/`, records metadata in `uploaded_media`, and returns a signed `contentUrl`.
- Signed image delivery is served from `GET /uploads/:id/content?token=...` so harnesses and prompts can reference the image without API auth headers.

## Prompt delivery

- Web-to-arm prompts send `attachments` to `POST /api/arms/:id/prompt`.
- The API checks the arm's `provider/model` modalities through `/api/opencode/providers`.
- `opencode-api` and `opencode-tui` receive native file parts when the selected model supports image input.
- Text-only harnesses, or models without image input, fall back to appending an `ATTACHED IMAGES` section with signed URLs to the prompt text.
- Distributed arms carry the same attachment payload through NATS so remote agents use the same rules as local harnesses.

## Brain and task context

- Web-to-brain messages store attachment metadata in the mail headers (`X-Coleo-Attachments`).
- The brain parses those headers, keeps attachments in task `context.attachments`, and includes them in `get_full_briefing` output.
- This keeps screenshots available even when the initial human request becomes a queued task instead of an immediate direct prompt.

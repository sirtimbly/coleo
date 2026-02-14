# Communicate with the Brain

The Brain is Coleo's central coordinator that receives your messages and orchestrates work across multiple AI agents (arms). Understanding how to communicate effectively with the Brain helps you get the most out of your AI team.

## How Message Processing Works

When you send a message to the Brain, it moves through API-managed channels:

### 1. Message Ingestion

- Human messages enter via Maildir (`mail/sent`) and `/api/brain/message`.
- Arm-to-brain operational messages enter through NATS and are bridged by the API into the brain inbox queue.
- The Brain polls inbox messages from API endpoints (`/api/brain/internal/messages/*`), not from NATS directly.

### 2. Intent Recognition

The Brain uses an LLM (Language Model) to understand what you're asking for. It analyzes your message and categorizes it into one of several intents:

- **new_task** - Create a new work item
- **doc_update** - Update documentation  
- **bug_report** - Report an issue
- **query** - Ask for status or information
- **escalate** - Hand off to manual processing

### 3. Action Execution

Based on intent and queue events, the Brain creates tasks/bugs, updates status, and routes assignments through API + ArmAgent boundaries.

## What You Can Do

### Create Tasks

The most common interaction is creating tasks. Simply describe what you want done:

```
Subject: Fix the login button
Body: The login button on the homepage doesn't respond to clicks. 
Please investigate and fix it.
```

The Brain will:
- Create a task with a unique ID
- Set priority (inferred from your language or defaults to "normal")
- Determine the domain (frontend, backend, docs, etc.)
- Add it to the queue for available arms
- Send you a confirmation email

### Update Documentation

When you want docs updated, just ask:

```
Subject: Update API docs
Body: Please add documentation for the new /users endpoint 
to the README.
```

The Brain creates a specialized task assigned to arms with "docs" domain expertise.

### Direct Arm Communication

You can address specific arms by name:

```
Subject: Check the tests
Body: Hey Alpha, can you run the test suite and report any failures?
```

If the arm is idle, the Brain sends your message directly. If busy, it queues as a task instead.

### Report Bugs

Found an issue? Report it:

```
Subject: Bug: Search is broken
Body: The search feature returns no results even for valid queries.
Error appears in the console.
```

The Brain creates a tracked bug report and can assign debugging work to specialized arms.

### Handle Approvals

When an arm needs permission for something risky (like deleting files), the Brain sends you an approval request. Simply reply:

```
Subject: Re: Approval needed for file deletion
Body: Yes, proceed with deleting the old migration files.
```

Or if you want to deny:

```
Body: No, do not delete those files. They're needed for rollback.
```

### Query Status

Ask about the current state:

```
Subject: Status check
Body: What's everyone working on? Any blockers?
```

The Brain compiles real-time information about all arms, their tasks, and recent activity.


## API-Managed Mailbox (Postmark Gateway)

If you want fully API-driven messaging without running local IMAP/SMTP, you can use Postmark as a gateway.

1. Configure environment variables on the API server:

```bash
export COLEO_POSTMARK_SERVER_TOKEN=postmark-server-token
# Optional inbound protection token
export COLEO_POSTMARK_INBOUND_TOKEN=shared-secret
```

2. Point Postmark inbound webhook to:

```
POST /api/mail/gateway/postmark/inbound
```

Send header `x-coleo-webhook-token` when `COLEO_POSTMARK_INBOUND_TOKEN` is set.

3. Send outbound mail through Coleo:

```
POST /api/mail/gateway/postmark/send
Content-Type: application/json

{
  "from": "brain@your-domain.com",
  "to": "peer@example.com",
  "subject": "Task update",
  "body": "Completed the migration work.",
  "replyTo": "brain@your-domain.com"
}
```

Inbound external email is persisted through the API mail pipeline and remains manageable via `/api/mail/*` endpoints.

## Best Practices

### Be Specific

Good: "Fix the CSS on the login button so it changes color on hover"
Less good: "Fix the login page"

### Include Context

Mention relevant files, error messages, or expected behavior. Arms work better with context.

### Set Priority When Urgent

The Brain infers priority from language like "urgent", "critical", "ASAP", but you can be explicit:

```
Subject: [URGENT] Fix production bug
Body: The payment processing is failing. This is blocking all orders.
Priority: critical
```

### Thread Your Conversations

Reply to existing emails to maintain context. The Brain tracks conversation threads and includes relevant history when assigning follow-up work.

### Use Clear Subject Lines

The subject helps the Brain categorize and route your request appropriately:
- "Bug: ..." for issues
- "Update docs: ..." for documentation
- "Task: ..." for general work

## What Happens Next

After you send a message:

1. **Immediate acknowledgment** - The Brain sends a confirmation that your message was received
2. **Task assignment** - An arm requests next assignment; the Brain responds with the next task/bug
3. **Progress updates** - Arms report status as they work
4. **Completion notification** - You receive a summary when the work is done

The entire cycle typically completes in under a second from message receipt to task creation. Multiple arms can work in parallel while the Brain coordinates and ensures nothing falls through the cracks.

## Troubleshooting

### Message Not Processed

- Check that your message is in the `mail/sent/` directory
- Ensure the Brain is running (`coleo brain start`)
- Check Brain logs for errors

### Arm Not Responding

- The Brain monitors arm health and can detect stuck agents
- It will automatically intervene, restart, or reassign work
- You'll be notified of any interventions

### Need to Escalate

If the Brain can't determine what to do with your message, it will:
- Notify you that the message needs clarification
- Queue it for manual review
- Suggest how to rephrase your request

---

The Brain is designed to be your interface to a team of AI agents. The more you communicate, the better it learns your preferences and work patterns.

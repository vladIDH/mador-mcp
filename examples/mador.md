# How Mador uses this server

[Mador](https://mador.ai) measures how often AI assistants (ChatGPT, Claude, Gemini, Perplexity and others) name a local business when people ask about its area and its category. Customers on a paid plan can connect Mador to Claude or ChatGPT and ask "how am I doing on Mador?" without opening Mador.

This page describes the setup in words. No code, data or configuration of Mador is in this repository.

## Tools

Seven read-only tools, the same names a connected client sees:

| Tool | What it answers |
|---|---|
| `list_projects` | the businesses the account measures, with the latest result |
| `get_status` | the latest measurement in plain words, and what changed since the previous one |
| `get_mentions` | question by question, which assistants name the business and who they name instead |
| `get_competitors` | the businesses named most often for the same area and category |
| `get_questions` | the questions measured, with how often the business is named |
| `get_pages` | the pages written for the business and whether they are published |
| `get_todos` | the open to-dos suggested for the week |

`project_id` is optional when the account has one project. Every tool returns a readable text and the same facts as structured data. Labels are in English because a model reads them; the server instructions tell the model to answer in the customer's language (usually Italian or Spanish).

## Authentication

Claude.ai and ChatGPT need OAuth, so Mador runs its own OAuth 2.1 authorization server on top of its customer area login: public clients with PKCE S256, Dynamic Client Registration and Client ID Metadata Documents, opaque tokens stored as hashes, rotating refresh tokens, and a fixed list of allowed redirect URIs (Claude, ChatGPT, localhost). The MCP endpoint re-reads the connection, the account and the plan on every request, so disconnecting or downgrading takes effect on the next call.

That authorization server is not part of this package (it is planned for a later version). Here it plugs in through `verifyToken`.

## Limits

- 60 tool calls per minute per account, counted in the same database write that logs the call.
- One log line per call: tool, project, outcome, milliseconds.
- `listChanged: false` and a 30-second cap on the route, after the 300-second timeouts described in the README.

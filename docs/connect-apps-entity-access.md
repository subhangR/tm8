# Connected tools in TM8 entity contexts

Connections belong to an account in a Space. Entity attachments choose tools for work about that entity; they do not copy credentials into the graph. Chat and work-session runtimes execute the tools through the same authenticated MCP proxy.

| Entity context | How tools become available | When selection changes apply |
| --- | --- | --- |
| Chat | Its own defaults, readable `about` subjects, their ancestors, teammate and Space defaults; an explicit chat selection overrides defaults | At the next turn; a running turn retains its launch selection |
| Work session | Its own defaults, recorded `about` subjects, task targets and their ancestors, teammate and Space defaults | At launch; resume retains the recorded selection |
| Craft | The Craft’s Connectors picker supplies defaults to its chats and sessions | New sessions and subsequent chat turns that still use defaults |
| Task and teammate | Their Connectors pickers supply defaults to work launched in their context | According to the chat/session rules above |
| Project, collection and other containers | Context attachments and readable ancestor defaults feed work about descendants | According to the chat/session rules above |
| Document, artifact, drawing and other contextual entities | Their Connectors picker supplies defaults to a chat or session about that entity | According to the chat/session rules above |
| Custom entity kinds | The same contextual controls and runtime resolution apply without a hardcoded kind allowlist | According to the chat/session rules above |

An entity does not run a model simply because tools are attached. Its contextual chat or session reads and processes connected data. Webhooks and autonomous event agents are a separate feature.

## Account authority

Resolution checks that the source entity and connector are readable, live and in the same Space. The runtime resolves an account available to its launching human, including an explicitly shared account where permitted. Another member’s private account is never inherited through an entity attachment.

An explicit empty selection disables all connections. Revocation and deselection are enforced at the proxy, not only hidden in the interface. Each successful call records the runtime and its human provenance. Launches without valid human provenance cannot borrow personal accounts.

The `equips` relation can attach MCP defaults to contextual entity kinds. Skills and spells retain their existing task, teammate and work-session source restrictions. Attachments carry no credentials or arbitrary options.

## Provider capabilities

Discovery uses the actual account grant. A listed tool can still require provider-side resource membership, administrative rights, a licensed seat or a supported plan. TM8 surfaces provider refusals instead of reporting a successful operation. Write tools retain their write/destructive annotations. Figma API and Figma’s approved remote MCP client are separate catalog entries and OAuth configurations.

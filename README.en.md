# dsh-connect-minmax

Connects the **MiniMax account signed in on this machine** (MiniMax Code / mcode desktop app) to
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), adding a **MiniMax (local sign-in)**
provider to the model picker — text, images, tool calls and thinking levels all work.

**No API key, and no API key field.** The plugin only reads the sign-in that is already on this machine:
it works because MiniMax Code is signed in, and stops working when that sign-in is gone.

## Install

In the Harness **Plugin Manager**, choose “Install from directory” and point it at this repository
(equivalent to `plugin_manager` `install_bundle` with this absolute directory as `target`).
The model picker then shows the **MiniMax (local sign-in)** group. Restart Harness Desktop if it does not.

## How credentials are obtained

1. **Auth Lease Broker (preferred)** — MiniMax Code exposes a local unix socket
   (`~/.minimax/run/mcode-auth-lease-v1.sock`) that issues short-lived access tokens. The broker refreshes
   them, so the plugin needs no credential lifecycle of its own.
2. **Local credential file (read-only fallback)** — when MiniMax Code is not running, the plugin reads
   `~/.minimax/auth/<env>/<region>/mcode-public/auth.json` and only uses a still-valid token.

The plugin **never writes** to `~/.minimax`, never refreshes the one-time refresh token, and never asks
MiniMax Code to sign the user out. A `401` triggers one re-lease plus one retry; a second failure asks the
user to sign in again in MiniMax Code.

## Models and thinking

| Model | Context | Input | `off` |
| --- | --- | --- | --- |
| `MiniMax-M3` | 512K | text, image | yes |
| `MiniMax-M3.1-Flash` | 512K | text, image | **no** (upstream requires thinking) |
| `MiniMax-M2.7` / `MiniMax-M2.7-highspeed` | 204K | text | yes |

Thinking levels map to MiniMax's native `thinking: {type:'adaptive'}` + `output_config.effort`:
`minimal`/`low` → `low`, `medium` → `medium`, `high`/`xhigh`/`max` passed through; `off` sends no
thinking field at all (and is not offered for models that refuse it).

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `models` | `[]` | enabled model ids; empty = the whole catalog |
| `region` | `auto` | `auto` / `cn` / `global`; `auto` follows the local sign-in |
| `streamIdleTimeoutMs` | `300000` | upstream idle timeout |
| `baseUrl` | empty | override the hosted base URL (no trailing `/v1`; the SDK appends `/v1/messages`) |

## Diagnostics

```bash
node scripts/verify-upstream.mjs          # sign-in state and a minimal request
node scripts/verify-upstream.mjs --full   # plus thinking, tools and streaming
```

The settings card shows the login source (broker lease vs local file), region, expiry, model catalog and the
last failure. Its data comes from `GET /plugins/dsh-connect-minmax/status`.

## Development

```bash
pnpm install
pnpm run check   # typecheck (host + client), vitest, tsdown build
```

See [docs/design.md](./docs/design.md) for the design and [docs/research/](./docs/research) for the
protocol notes and measurements this plugin is based on.

## License

MIT. Third-party notices: [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

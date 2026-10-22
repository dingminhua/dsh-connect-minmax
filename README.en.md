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

Names, order, context tiers and thinking shape mirror MiniMax Code's own catalog
(`~/.minimax/config.yaml` plus the bundled `@mavis/config` catalog):

| Model | Display name | Context | Max output | Input | `off` |
| --- | --- | --- | --- | --- | --- |
| `MiniMax-M3.1-Flash` | M3.1-Flash (subscription) | 512K (1M option) | 128K | text, image, video | **no** (forced) |
| `MiniMax-M3` | M3 | 512K (1M option) | 128K | text, image, video | yes |
| `MiniMax-M2.7` | M2.7 | 204.8K | 131K | text, image | yes |
| `MiniMax-M2.7-highspeed` | M2.7-highspeed | 204.8K | 131K | text, image | **no** (upstream ignores it) |

Thinking levels map to MiniMax's native `thinking: {type:'adaptive'}` + `output_config.effort`:
`low`/`medium`/`high`/`xhigh`/`max` pass through, `off` sends `thinking:{type:'disabled'}`, and
`minimal` is not offered (MiniMax has no level below `low`). MiniMax Code spells its M3 toggle as
`effort: 'on'/'off'`, which the hosted gateway rejects (`invalid reasoning_effort`), so this plugin
only sends the accepted values.

Known gaps: the host only has text/image modalities, so **video input cannot be expressed**; and the
1M context tier is exposed as the `longContext` plugin option instead of a per-model menu entry.

## Icon

`icons/*.png` is the shared `dsh-connect-*` family icon (the same file as workbuddy / trae /
qoder). MiniMax's brand marks are deliberately not used: this plugin reads your own local
sign-in and does not impersonate the official client.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `models` | `[]` | enabled model ids; empty = the whole catalog |
| `regions` | `["cn","global"]` | which regions to register: `cn` → route `minimax`, `global` → route `minimax-global` |
| `streamIdleTimeoutMs` | `300000` | upstream idle timeout |
| `baseUrl` | empty | override the **domestic (CN)** hosted base URL (no trailing `/v1`; the SDK appends `/v1/messages`) |
| `globalBaseUrl` | empty | override the **international (Global)** hosted base URL (same rule) |
| `longContext` | `false` | use the 1M context tier (`M3` / `M3.1-Flash`); upstream bills it as higher usage |

## Diagnostics

```bash
node scripts/verify-upstream.mjs          # sign-in state and a minimal request
node scripts/verify-upstream.mjs --full   # plus thinking, tools and streaming

pnpm build && node scripts/e2e-plugin.mjs           # one real call through the plugin's own adapter
node scripts/e2e-plugin.mjs MiniMax-M3 --tools      # with a tool call
node scripts/verify-upstream.mjs --matrix          # per-model thinking wire forms
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

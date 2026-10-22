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

1. **Auth Lease Broker (preferred, region-checked)** — MiniMax Code exposes a local unix socket
   (`~/.minimax/run/mcode-auth-lease-v1.sock`) that issues short-lived access tokens. The broker refreshes
   them, so the plugin needs no credential lifecycle of its own. **The lease protocol has no region
   parameter**: it only ever serves the account MiniMax Code currently considers active. With both regions
   signed in (this plugin's default shape) the plugin therefore compares the lease's `generation` against
   this region's on-disk record and only uses the lease when they match — otherwise the cn route would be
   handed the global token and fail with `401 invalid access token` on the whole path.
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

## Settings card

The card on the plugin page follows the same shape as its siblings (qoder / workbuddy / trae): two
**region tabs** on top, then **Account / Models / Diagnostics** sub-tabs.

- **Region tabs**: each region is a separate provider (`minimax` / `minimax-global`) with its own
  sign-in, credits and models. The dot answers "can this side be used", the checkbox answers "should
  this side be registered". Both can stay on; different sessions may pick either side. At least one
  region must remain enabled — turning off the last one would leave the plugin with nothing to register.
- **Account**: local sign-in and taken-over copies (deletable), plus credit balance, per-lot expiry and
  the seven-day check-in strip.
- **Models**: choose which models are enabled, switch the 1M context tier, and test a model one by one.
  Testing goes through `prepareCall → stream` — the real path, not a hand-rolled fetch that would
  measure something the user never actually uses.
- **Diagnostics**: what this card **actually read** — region, upstream host, serving account, credential
  source, when credits were read, catalog and enabled model counts, account pool, last error. This page
  has no control that changes settings.

The card can write back the `models` / `regions` / `longContext` config fields and **verifies each write
by reading it back**: the settings surface may report success without the value landing, and without that
check the card would tick a checkbox while the config stayed unchanged. When the host exposes no settings
surface, the whole card degrades to read-only and says so.

**Deliberately absent**: per-model "supports images" / "thinking can be off" toggles. Those are facts
decided upstream (`MiniMax-M2.7` simply cannot take image input), not preferences; making them checkboxes
would hand the user a control that changes nothing — or worse, one that makes the declared capability
disagree with reality.

## Credits and daily check-in

MiniMax Code's account endpoints work and are read-only here; the plugin never decides for you:

| What | Endpoint |
| --- | --- |
| Balance | `POST {matrix}/commerce/get_membership_info` → `op_credit_summary.total_remaining_amount` |
| Per-lot expiry | `GET {cloud}/credit/details?page_number=1&page_size=100` → each `expire_at_ms` |
| Check-in progress | `GET {cloud}/signin/status?timezone_id=Asia/Shanghai` → a seven-day cycle |

Three traps (all handled; evidence in `docs/research/upstream.md` §6.3):

- Read the balance from `op_credit_summary`. The sibling fields `total_remains_credit` /
  `opcredit_balance` are permanently `0` on accounts migrated to the credit pool, so reading them shows
  "0 credits".
- A small `page_size` (3 in testing) makes the ledger endpoint return `50001 internal error`; we ask for 100.
- `timezone_id` is required and must be an IANA name; an offset gets `1406010011`.

**"Claim today" only fires when the button is pressed** — never automatically — and it asks the status
endpoint first: the day cell has four states (not yet / claimable / claimed / no grant), so anything
other than "claimable" means no write request is sent at all.

Credits are cached per route for 60 seconds: the card polls every 10 seconds, and without the cache that
would become six upstream calls per 10 seconds.

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

# Wallie

**A spending allowance for your AI agent.** Fund it once. It pays any x402-priced API
on its own — inside hard limits *you* set, with a kill switch and a receipt for every cent.

`wallie` is a thin alias for [`allowance-kit`](https://www.npmjs.com/package/allowance-kit):
the same CLI and the same SDK, under the name the website [onewallie.com](https://onewallie.com)
uses. `npx wallie` and `npx allowance-kit` are the same tool.

```bash
npx wallie demo          # watch the whole thing work, end to end
npx wallie init          # create the agent's wallet
npx wallie topup 5.00    # fund the allowance
npx wallie dashboard     # live spending, kill switch, approval queue
```

```js
import { payingFetch, createAgent, topUp } from "wallie"; // or from "allowance-kit"
```

Full documentation, the changelog, and the source live in the
[`allowance-kit` repository](https://github.com/fskroes/AllowanceKit).

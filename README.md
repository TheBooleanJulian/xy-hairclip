# xy-hairclip

Number board for the limited edition XYMIKU.39 hairclip (39 pieces). Anyone can open
<https://xy-hairclip.thebooleanjulian.dev> and see which numbers are taken (greyed and
crossed out, with the owner's name). Only xymiku.39 can put a name on a number: the
claim form needs a passcode. Names are written straight into the
[hairclip Google Sheet](https://docs.google.com/spreadsheets/d/1rt2I3dokmsPwD_i4MYnfD0r5ehBLeu7kG-bHOJQqFas/edit).

## How it works

```text
browser ──> Cloudflare Worker (xy-hairclip) ──> Apps Script web app ──> Google Sheet
            public/index.html   /api/*          apps-script/Code.gs      Sheet1, A:B
```

- **`public/index.html`**: the whole frontend. A single file of vanilla HTML/CSS/JS
  styled like xymiku-site. It refreshes every 30 s and whenever the tab regains focus.
- **`src/index.js`**: the Worker. Static files are served from Workers assets; only
  `/api/*` runs code:
  - `GET /api/slots` returns all 39 numbers with `taken` and `name`, cached for 10 s.
  - `POST /api/claim {id, name, passcode}` requires a same-origin request and the
    `ADMIN_PASSCODE` secret (compared in constant time; never forwarded to the
    sheet). It then checks the input (1–39, a name of 1–40 characters). Each IP
    gets 5 tries per minute, which also caps passcode guessing. Without
    `ADMIN_PASSCODE` set, every claim is refused.
- **`apps-script/Code.gs`**: bound to the sheet. Every request must carry the shared
  token. A claim takes a script lock, re-reads the row, and only writes if the
  `Names` cell is empty, so two people can never both get the same number. It
  writes column B only, never Paid/Collected. Each claim is also appended to a
  `Claims log` tab (created on first claim) with a timestamp.

The sheet stays the source of truth. To free a number, clear its `Names` cell. To
reserve one, type anything into it. The site picks up the change within about 30 s.

No npm dependencies. Data lives in the sheet only; there is no database.

## Setup (one-time)

1. **Apps Script.** Open the sheet → *Extensions → Apps Script*. Replace the
   contents of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs) and save.
2. **Token.** In the script editor: *Project Settings → Script Properties → Add*.
   Set `TOKEN` to a long random string (the same value goes into `SHEET_TOKEN` below).
3. **Deploy.** *Deploy → New deployment → Web app*. Set *Execute as* to **Me** and
   *Who has access* to **Anyone**, then authorise. Copy the web app URL (ends in `/exec`).
4. **Worker secrets.**
   ```sh
   npx wrangler secret put APPS_SCRIPT_URL   # the /exec URL
   npx wrangler secret put SHEET_TOKEN       # same value as TOKEN
   npx wrangler secret put ADMIN_PASSCODE    # passcode for the claim form
   ```
   Until the first two are set, the page shows "Number picking opens soon." Without
   `ADMIN_PASSCODE`, claims answer "Claims are closed right now." In the Cloudflare
   dashboard, add these as type **Secret**; plain-text vars there are wiped by the
   next `wrangler deploy`.

When you change `Code.gs` later, use *Deploy → Manage deployments → Edit → New
version*. That keeps the same URL. A *New deployment* gets a new URL, and then
`APPS_SCRIPT_URL` has to be updated.

## Develop and deploy

```sh
npm test                    # node --test, no install needed
cp .dev.vars.example .dev.vars && npx wrangler dev
npx wrangler deploy         # accurova Cloudflare account
```

Deploys go to the Worker `xy-hairclip` on the accurova account, with the custom
domain `xy-hairclip.thebooleanjulian.dev`. Deploy-on-push (Workers Builds) is not connected
yet. To set it up, connect this repo in the Cloudflare dashboard with production
branch `main`.

Branches: `feature/*` → `dev` → PR → `main`.

## License

Dual licensed: [AGPLv3](LICENSE), or a [commercial license](COMMERCIAL-LICENSE.md).

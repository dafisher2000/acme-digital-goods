# acme-digital-goods

A demonstration app, made in the Integra demo factory: a business's storefront, its agent door and its checkout, as one
Cloudflare Worker with its page. **Every transaction here is fully executed at inception, on test funds, for
demonstration only.**

## What is in it

- `src/`: the business. `business.json` describes it, and the page and the goods are its own.
- `integra/`: the kit, which serves the checkout, the agreements, the proof pages and the agent door. It is not
  edited. `integra/interfaces/` is the package the kit and the business share, carried here so that nothing is
  fetched from anywhere but npm's public registry.

## Secrets

The app reads two, and neither is in this repository:

| secret | |
|---|---|
| `SELLER_CREDENTIAL` | **Required.** The seller credential the Integra demo factory gave you. It is the shared demo tenant's. |
| `RPC_URL` | A Base Sepolia node's URL. Unless you have a node, use the public endpoint, https://sepolia.base.org, which `.dev.vars.example` gives. |

## Models

Workers AI runs them through the app's `AI` binding; each is served on the Free plan, and each is a setting in
`wrangler.jsonc`'s `vars`:

| setting | model | |
|---|---|---|
| `SELLER_MODEL` | `@cf/meta/llama-4-scout-17b-16e-instruct` | The seller's agent: when a buyer negotiates, it chooses to accept, counter or decline, and the kit's code sets the price, never below the lowest in `business.json`. With no model, or no usable answer, a plain rule chooses. |
| `ANSWER_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | The work an `answer` offer delivers, done once after the payment settles. |

## Run it

```sh
cp .dev.vars.example .dev.vars   # then put the credential in .dev.vars, which is never committed
npm install
npm run dev
```

## Deploy it to your Cloudflare account

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fdafisher2000%2Facme-digital-goods)

Cloudflare asks for the two secrets in its form, copies this repository into your GitHub account, builds it and
deploys it. The Deploy to Cloudflare panel in the factory has a button that copies the seller credential, to paste
into the form.

Or from here, with `npx wrangler login` done and the credential in `.dev.vars`:

```sh
npm install
npm run deploy:local
```

It builds the app and deploys it as the Worker named in `wrangler.jsonc`, with the secrets in `.dev.vars` (a new Worker
cannot be deployed without its required secret). The app keeps its purchases in a Durable Object with SQLite, which the
first deploy creates.

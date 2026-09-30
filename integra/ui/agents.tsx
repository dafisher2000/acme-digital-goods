// `/agents` (design §2.4, §9): "Connect your agent". The addresses this app publishes, one line for each agent host that
// adds a remote MCP server by its address (R3 §4), and Integra's buyer, for an agent that has no wallet of its own.
import { useSearch } from "wouter";
import { business } from "integra:business";
import { DEMONSTRATION_SENTENCE } from "@demo-factory/interfaces/demonstration";
import { NETWORK, NETWORK_NAME } from "@demo-factory/interfaces/network";
import { ANCHOR_AMOUNT, dollarsToAmount } from "@demo-factory/interfaces/price";
import { SERVICE_ORIGINS } from "@demo-factory/interfaces/services";
import { dollars, dueRule, ORIGIN, usdc } from "./lib.ts";

const slug = business.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const MCP = `${ORIGIN}/mcp`;
const BUYER_MCP = `${SERVICE_ORIGINS.buyer}/mcp`;

function Command({ children }: { children: string }) {
  return (
    <div className="ik-command">
      <pre>{children}</pre>
      <button type="button" className="ik-button ik-quiet" onClick={() => void navigator.clipboard?.writeText(children)}>
        Copy
      </button>
    </div>
  );
}

const HOSTS: { host: string; how: string; command?: (url: string) => string }[] = [
  { host: "Claude (claude.ai, Desktop)", how: "Customize, then Connectors, then Add custom connector, and enter the address." },
  { host: "Claude Code", how: "In a terminal:", command: (url) => `claude mcp add --transport http ${slug} ${url}` },
  { host: "ChatGPT", how: "Settings, Security and login, turn on Developer mode; then add a developer-mode app for the address." },
  { host: "OpenAI Codex CLI", how: "In a terminal:", command: (url) => `codex mcp add ${slug} --url ${url}` },
  { host: "Gemini CLI", how: "In a terminal:", command: (url) => `gemini mcp add --transport http ${slug} ${url}` },
  { host: "VS Code (Copilot)", how: "In .vscode/mcp.json:", command: (url) => JSON.stringify({ servers: { [slug]: { type: "http", url } } }, null, 2) },
  { host: "Cursor", how: "In mcp.json:", command: (url) => JSON.stringify({ mcpServers: { [slug]: { url } } }, null, 2) },
];

export function AgentsPage() {
  const chosen = new URLSearchParams(useSearch()).get("offer");
  return (
    <main className="ik-page" data-integra-page="agents">
      <h1>Connect your agent</h1>
      <p className="ik-lede">
        {business.name} sells to any agent that pays by x402 on {NETWORK_NAME} ({NETWORK}). {DEMONSTRATION_SENTENCE}
      </p>

      <section>
        <h2>This app&apos;s addresses</h2>
        <table className="ik-table">
          <tbody>
            <tr>
              <th>The tools, over MCP</th>
              <td>
                <code>{MCP}</code>
              </td>
            </tr>
            <tr>
              <th>The catalogue (UCP)</th>
              <td>
                <a href="/.well-known/ucp">
                  <code>{ORIGIN}/.well-known/ucp</code>
                </a>
              </td>
            </tr>
            <tr>
              <th>The terms</th>
              <td>
                <a href="/terms.md">
                  <code>{ORIGIN}/terms.md</code>
                </a>{" "}
                and{" "}
                <a href="/.well-known/legal-context.json">
                  <code>/.well-known/legal-context.json</code>
                </a>
              </td>
            </tr>
            <tr>
              <th>In prose, for an agent</th>
              <td>
                <a href="/llms.txt">
                  <code>{ORIGIN}/llms.txt</code>
                </a>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>The offers</h2>
        <p>
          A request to an offer&apos;s address is answered <code>402</code> with the agreement&apos;s link; the payment carries the agreement&apos;s hash. The listed price is shown
          beside the amount paid, at one millionth of a USDC for each cent.
        </p>
        <ul className="ik-offers">
          {business.offers.map((offer) => (
            <li key={offer.id} id={offer.id} className={chosen === offer.id ? "ik-chosen" : undefined} data-integra-offer-line={offer.id}>
              <strong>{offer.name}</strong> · listed {dollars(offer.price)},{" "}
              {offer.payment === "deferred"
                ? `pay later: owed as ${usdc(dollarsToAmount(offer.price))}, due ${dueRule(offer.due)}; paid now only ${usdc(ANCHOR_AMOUNT)}, which anchors the agreement on chain and is not part of the price`
                : `paid ${usdc(dollarsToAmount(offer.price))} · ${offer.payment === "authorise" ? "authorised now, collected later" : "paid now"}`}
              <Command>{`curl -i -X POST ${ORIGIN}/buy/${offer.id}`}</Command>
              <span className="ik-small">
                The test checkout, where a hash that does not match must be refused, is <code>/test/buy/{offer.id}</code>
                {offer.negotiable ? (
                  <>
                    ; the price is open to negotiation at <code>/negotiate/{offer.id}</code>
                  </>
                ) : null}
                .
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>An agent with a wallet of its own</h2>
        <p>Add this app&apos;s MCP address to your agent. It reads the catalogue, checks the agreement&apos;s hash, and pays from its own wallet.</p>
        <ul className="ik-hosts">
          {HOSTS.map((host) => (
            <li key={host.host}>
              <strong>{host.host}.</strong> {host.how}
              {host.command ? <Command>{host.command(MCP)}</Command> : null}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>An agent with no wallet: Integra&apos;s buyer</h2>
        <p>
          Integra&apos;s buyer service pays from a shared test wallet. Add its address to your agent, then ask it to buy from{" "}
          <code>{ORIGIN}</code>. Its tools are <code>start_checkout</code>, <code>check_agreement</code> and <code>pay</code>; the agent reads the agreement and decides whether to pay.
        </p>
        <Command>{BUYER_MCP}</Command>
        <ul className="ik-hosts">
          {HOSTS.filter((host) => host.command).map((host) => (
            <li key={host.host}>
              <strong>{host.host}.</strong> {host.how}
              <Command>{host.command!(BUYER_MCP)}</Command>
            </li>
          ))}
        </ul>
        <p>
          Or instruct it from a page of its own: <a href={SERVICE_ORIGINS.buyer}>{SERVICE_ORIGINS.buyer.replace("https://", "")}</a>.
        </p>
      </section>
    </main>
  );
}

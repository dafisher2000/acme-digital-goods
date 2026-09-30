// The shell (design §2.2, rule 4): it draws the band on every page, routes the kit's pages, and hands the rest to the
// storefront's `App`. The router is wouter, which the storefront's own pages use too.
//
// The storefront is held apart from the shell (design §2.4, "the shell"): a page of it that throws, as it draws or as
// its module loads, shows a short notice where the page was, and the band, with the demonstration sentence (§2.7),
// stays above it; the kit's own pages never depend on it. Without this, React unmounts the whole root when a page
// throws, and the band goes with it.
import { Component, lazy, Suspense, type ReactNode } from "react";
import { Link, Route, Switch, useLocation } from "wouter";
import { AgentsPage } from "./agents.tsx";
import { Band } from "./band.tsx";
import { WatchPage } from "./live.tsx";
import { ProofPage } from "./proof.tsx";

/**
 * The storefront's module, asked for at once whatever the address, beside the shell rather than inside it: a module of
 * the storefront that throws as it loads fails this import alone, and the page that draws it shows the notice, where a
 * static import would stop the shell too. At once, so that the look (`src/theme.css`, which `App.tsx` imports) reaches
 * the kit's pages as it did. A kit page does not need the storefront, so a failure here is told only where it is drawn.
 */
const storefront = import("../../src/App.tsx");
storefront.catch(() => undefined);
const App = lazy(() => storefront);

export function Shell() {
  return (
    <>
      <Band />
      <Switch>
        <Route path="/agents" component={AgentsPage} />
        <Route path="/proof/:hash">{(params) => <ProofPage hash={params.hash} />}</Route>
        <Route path="/watch/:run">{(params) => <WatchPage run={params.run} />}</Route>
        <Route>
          <Storefront />
        </Route>
      </Switch>
    </>
  );
}

/** The storefront's pages, each held by the boundary at its own address. */
function Storefront() {
  const [at] = useLocation();
  return (
    <PageBoundary at={at}>
      <Suspense fallback={null}>
        <App />
      </Suspense>
    </PageBoundary>
  );
}

type Held = { at: string; failed: boolean };

/**
 * The storefront's page, or the notice when it threw. The notice stands until the address changes (a link, the back
 * button) or an edit of the page reloads it (React's refresh remounts a boundary that failed).
 *
 * The error is still reported, as an uncaught error is (`report`): the boundary keeps the band drawn and hides nothing.
 */
class PageBoundary extends Component<{ at: string; children: ReactNode }, Held> {
  state: Held = { at: this.props.at, failed: false };

  static getDerivedStateFromProps(props: { at: string }, state: Held): Partial<Held> | null {
    return props.at === state.at ? null : { at: props.at, failed: false };
  }

  static getDerivedStateFromError(): Partial<Held> {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    report(error);
  }

  render() {
    return this.state.failed ? <PageFailed home={this.state.at !== "/"} /> : this.props.children;
  }
}

/** Whether React's caught error is the boundary's own: `main.tsx` leaves those to it. */
export const isPageBoundary = (boundary: unknown) => boundary instanceof PageBoundary;

/**
 * The error as an uncaught error is reported: to the window's `error` listeners and the browser's console, with the
 * stack it was thrown with. So the Studio's check reads it as it reads an uncaught error (its `pageerror`,
 * `src/worker/browse.ts`): the same file and line of `src/`, through the source map, and the same words to the model.
 */
function report(error: unknown): void {
  if (typeof globalThis.reportError === "function") globalThis.reportError(error);
  else
    setTimeout(() => {
      throw error;
    });
}

/** Where the page was: a short, plain notice. The band stays above it. */
function PageFailed({ home }: { home: boolean }) {
  return (
    <main className="ik-page ik-failed" role="alert" data-integra-page="failed">
      <h1>This page could not be shown</h1>
      <p>Something on it failed as it was drawn.{home && <> <Link href="/">Go to the home page</Link>.</>}</p>
    </main>
  );
}

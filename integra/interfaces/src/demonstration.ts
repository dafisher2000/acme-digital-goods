/**
 * The demonstration sentence (design §2.7), held here and nowhere else.
 *
 * Fisher, 2026-09-29 (late): "we should clearly state that transactions are for demonstration only". Its words are
 * Fisher's to change, and they change here only.
 *
 * Where it appears (design §2.7): the band on every page; every agreement, in its `demonstration` slot; every proof page
 * and every receipt; every checkout's challenge, as the `description` of its `resource`; the description of every tool
 * that buys, at the app's door and at the buyer service's; `/llms.txt`; the buyer service's own page.
 */
export const DEMONSTRATION_SENTENCE =
  "For demonstration only. This transaction runs on a test network with test money, and has no value." as const;

/**
 * What the agreement of an `order` says the seller does, and does not do (design §5), verbatim. An order's goods are
 * the one delivery a demonstration cannot make real.
 */
export const ORDER_DEMONSTRATION_SENTENCE = "The order is recorded and the stock is reduced. Nothing is sent." as const;

/**
 * What the agreement of an offer paid later says the demonstration does not do (design §3.9), and what its proof page
 * says, verbatim. Fisher, 2026-09-29 (late): "our appliance only records transactions at inception".
 */
export const DEFERRED_DEMONSTRATION_SENTENCE =
  "The appliance records this purchase at its inception only: the agreement, and the anchoring payment that carries its hash on chain. Nothing in this demonstration tracks or collects the amount owed later: paying it is the buyer's to do, and the seller's to follow up." as const;

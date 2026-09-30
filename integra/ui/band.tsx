import { Link } from "wouter";
import { DEMONSTRATION_SENTENCE } from "@demo-factory/interfaces/demonstration";

/** On every page: the demonstration sentence (design §2.7). */
export function Band() {
  return (
    <div className="ik-band" role="note" data-integra-band>
      <strong>Integra demonstration</strong>
      <span>{DEMONSTRATION_SENTENCE}</span>
      <Link href="/agents">Connect your agent</Link>
    </div>
  );
}

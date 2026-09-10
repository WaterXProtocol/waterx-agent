/**
 * The local signing protocol, as data.
 *
 * A fourth copy of `SIGNER_PROTOCOL` v1. The other three live in
 * waterx-predict-agent-sdk (`packages/cli`, `packages/runner`,
 * `packages/signer-browser`), held equal to each other by that workspace's
 * `tests/workspace.test.ts`. It is published as *data* precisely so an
 * implementation outside that repo can speak the same wire without depending on
 * it — which is why this package copies the descriptor instead of merging into
 * the workspace to import it.
 *
 * The protocol is domain-neutral: it carries an address and opaque bytes, and
 * returns a signature. Nothing in it knows whether those bytes open a perp
 * position or buy a prediction share, which is what makes one keystore serve
 * both product lines.
 *
 * `test/signer.test.ts` asserts that the request this package actually writes
 * has exactly the keys listed here — that is what makes the descriptor a claim
 * about behaviour rather than a comment — and cross-checks it against the
 * predict workspace when that checkout is present.
 */
export const SIGNER_PROTOCOL = {
  version: 1,
  requests: [
    {
      type: "PERSONAL_MESSAGE",
      fields: ["version", "type", "agentWallet", "messageBase64"],
    },
    {
      type: "TRANSACTION",
      fields: ["version", "type", "agentWallet", "transactionBytesBase64"],
    },
  ],
  response: { fields: ["signature"] },
} as const;

/**
 * One JSON line on the child's stdin.
 *
 * This package writes only `TRANSACTION`. `PERSONAL_MESSAGE` is part of the
 * protocol and is declared so a shared signer stays interchangeable, but the
 * WaterX perp read/write routes are unauthenticated, so there is no login
 * challenge to sign and none is sent.
 */
export type SignerRequest =
  | {
      readonly version: 1;
      readonly type: "PERSONAL_MESSAGE";
      readonly agentWallet: string;
      readonly messageBase64: string;
    }
  | {
      readonly version: 1;
      readonly type: "TRANSACTION";
      readonly agentWallet: string;
      /**
       * Complete transaction bytes, base64. **Complete** is the caller's
       * responsibility and it is not always free: on the unsponsored perp path
       * the backend returns transaction *kind* bytes, and the sender and gas
       * coins are chosen here before anything is handed to a signer. A signer
       * cannot tell a kind from a whole transaction, so a caller that skipped
       * that step would be asking a key holder to sign something that cannot
       * execute.
       */
      readonly transactionBytesBase64: string;
    };

/** What the child writes to stdout, and nothing else. */
export interface SignerResponse {
  readonly signature: string;
}

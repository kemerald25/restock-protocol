// @ts-ignore
import { x402Client, x402HTTPClient } from "@x402/core/client";
// @ts-ignore
import { registerExactEvmScheme } from "@x402/evm/exact/client";
// @ts-ignore
import { encodePaymentSignatureHeader } from "@x402/core/http";

export interface X402Signer {
  address: `0x${string}`;
  signTypedData: (typedData: any) => Promise<`0x${string}`>;
  readContract: (args: any) => Promise<any>;
}

export async function createX402PaymentHeader(
  paymentRequired: any,
  signer: X402Signer
): Promise<string> {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });
  const httpClient = new x402HTTPClient(client);
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  return encodePaymentSignatureHeader(paymentPayload);
}

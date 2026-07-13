// x402 pay-per-query skeleton for the price endpoints.
//
// structure: a fastify preHandler that, when enabled, answers 402 with a
// payment-required payload unless the request carries a valid api key or a
// payment header that the verifier accepts. the verifier is an interface;
// settlement wiring (facilitator, asset, receipts) is intentionally out of
// scope and left to the operator. no token, treasury, or payout logic
// exists here.

import type { FastifyReply, FastifyRequest } from "fastify";
import { api, disclaimer } from "@fletch/config";

export interface PaymentRequirements {
  scheme: string;
  network: string;
  payTo: string;
  maxAmountRequiredUsd: number;
  resource: string;
  description: string;
}

export interface PaymentVerification {
  valid: boolean;
  reason?: string;
}

// implement this and swap it into createX402Middleware to wire settlement.
export interface PaymentVerifier {
  verify(paymentHeader: string, requirements: PaymentRequirements): Promise<PaymentVerification>;
}

// default verifier: rejects everything with an explicit reason. the 402
// path is exercised end to end while settlement stays unwired.
export class UnwiredVerifier implements PaymentVerifier {
  async verify(): Promise<PaymentVerification> {
    return { valid: false, reason: "payment settlement is not wired on this deployment" };
  }
}

export function requirementsFor(resource: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: api.x402.network,
    payTo: api.x402.payTo,
    maxAmountRequiredUsd: api.x402.priceUsdPerQuery,
    resource,
    description: "fletch fair value query",
  };
}

export function createX402Middleware(verifier: PaymentVerifier) {
  return async function x402PreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!api.x402.enabled) return;

    // keyed callers pass through; x402 is for anonymous agent traffic
    const tier = (req as FastifyRequest & { fletchTier?: string }).fletchTier;
    if (tier === "keyed") return;

    const requirements = requirementsFor(req.url);
    const paymentHeader = req.headers["x-payment"];
    if (typeof paymentHeader === "string" && paymentHeader.length > 0) {
      const result = await verifier.verify(paymentHeader, requirements);
      if (result.valid) return;
      await reply.code(402).send({
        error: "payment invalid",
        reason: result.reason ?? "payment could not be verified",
        accepts: [requirements],
        x402Version: 1,
        disclaimer,
      });
      return;
    }

    await reply.code(402).send({
      error: "payment required",
      accepts: [requirements],
      x402Version: 1,
      disclaimer,
    });
  };
}

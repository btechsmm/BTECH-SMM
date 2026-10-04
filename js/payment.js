/**
 * BTECH SMM — Payment Module
 * ----------------------------------------------------------------
 * Defines a stable PaymentService interface. Today it is backed by
 * DemoPaymentProvider (no real money moves). In a later phase a
 * MpesaDarajaProvider will implement the same three methods and be
 * swapped in — pages that call PaymentService.* will not change.
 *
 * FUTURE FLOW (Phase 5):
 *   Customer -> Checkout -> enters M-Pesa phone number -> STK Push
 *   -> customer enters M-Pesa PIN -> Safaricom Daraja -> backend
 *   -> payment confirmation -> order confirmation.
 *
 * DO NOT implement fake M-Pesa transactions here. DO NOT claim a
 * successful payment without a real confirmation once Daraja is
 * connected. No M-Pesa credentials are requested or stored by this
 * module.
 */

import { generateId } from "./utils.js";

/**
 * DemoPaymentProvider simulates a payment attempt so the wallet and
 * checkout UI have something to call. It never represents itself as
 * moving real money.
 */
const DemoPaymentProvider = {
  async initiatePayment({ amount, method = "demo" }) {
    await wait(700);
    return {
      ok: true,
      paymentId: generateId("pay"),
      amount,
      method,
      status: "demo_completed",
      isDemo: true,
    };
  },
  async verifyPayment(paymentId) {
    await wait(300);
    return { ok: true, paymentId, status: "demo_completed", isDemo: true };
  },
  async getPaymentStatus(paymentId) {
    return { paymentId, status: "demo_completed", isDemo: true };
  },
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Public interface. Currently always resolves to DemoPaymentProvider.
 * Later: `const provider = SUPABASE_READY ? MpesaDarajaProvider : DemoPaymentProvider;`
 */
export const PaymentService = {
  initiatePayment: (...args) => DemoPaymentProvider.initiatePayment(...args),
  verifyPayment: (...args) => DemoPaymentProvider.verifyPayment(...args),
  getPaymentStatus: (...args) => DemoPaymentProvider.getPaymentStatus(...args),
  isDemo: true,
};

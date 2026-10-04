/**
 * BTECH SMM — Delivery Progress Helper
 * ----------------------------------------------------------------
 * Calls delix-provider's customer-facing "track-status" action
 * and normalizes both fresh and cached provider responses into
 * the exact shape expected by orders.js.
 */

import { supabase } from "./supabase.js";

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getProviderStatusValue(providerStatus) {
  if (typeof providerStatus === "string") {
    return providerStatus;
  }

  if (
    providerStatus &&
    typeof providerStatus === "object"
  ) {
    return providerStatus.status || "";
  }

  return "";
}

function getProviderRemains(providerStatus) {
  if (
    providerStatus &&
    typeof providerStatus === "object"
  ) {
    return toNumber(providerStatus.remains);
  }

  return null;
}

function getLabel(providerStatus, mappedStatus) {
  const status = String(
    getProviderStatusValue(providerStatus)
  )
    .trim()
    .toLowerCase();

  if (
    status === "completed" ||
    mappedStatus === "completed"
  ) {
    return "Completed";
  }

  if (
    status === "partial" ||
    status.includes("partial")
  ) {
    return "Partially Delivered";
  }

  if (
    status === "processing" ||
    status === "in progress" ||
    status === "progress"
  ) {
    return "In Progress";
  }

  if (
    status === "cancelled" ||
    status === "canceled" ||
    status.includes("cancel")
  ) {
    return "Cancelled by Provider";
  }

  if (mappedStatus === "processing") {
    return "In Progress";
  }

  return "Queued";
}

export async function fetchOrderProgress(
  orderId,
  { force = false } = {}
) {
  try {
    const { data, error } =
      await supabase.functions.invoke(
        "delix-provider",
        {
          body: {
            action: "track-status",
            order_id: orderId,
            force,
          },
        }
      );

    if (!data?.ok) {
      return {
        ok: false,
        error:
          data?.error ||
          (error
            ? "Could not reach the tracking service. Please try again."
            : "Something went wrong. Please try again."),
      };
    }

    const providerStatus = data.providerStatus || {};

    const quantity = toNumber(data.quantity);

    const providerStatusText =
      getProviderStatusValue(providerStatus);

    const providerStatusLower =
      String(providerStatusText)
        .trim()
        .toLowerCase();

    let remains =
      getProviderRemains(providerStatus);

    /*
     * The provider's cached final-status response can return:
     *
     * providerStatus: "Completed"
     *
     * instead of:
     *
     * providerStatus: {
     *   status: "Completed",
     *   remains: "0"
     * }
     *
     * For a completed order, zero remains is the correct
     * interpretation.
     */
    if (
      remains === null &&
      (
        providerStatusLower === "completed" ||
        data.status === "completed" ||
        data.mappedStatus === "completed"
      )
    ) {
      remains = 0;
    }

    /*
     * An order with a provider order ID has actually been
     * submitted to the provider.
     */
    const submitted =
      Boolean(data.providerOrderId);

    let delivered = null;
    let percent = 0;

    /*
     * Calculate progress from quantity and remains.
     */
    if (
      quantity !== null &&
      quantity > 0 &&
      remains !== null
    ) {
      delivered = Math.max(
        0,
        Math.min(
          quantity,
          quantity - remains
        )
      );

      percent = Math.round(
        (delivered / quantity) * 100
      );
    }

    /*
     * Completed + zero remaining = 100%.
     */
    if (
      providerStatusLower === "completed" ||
      data.status === "completed" ||
      data.mappedStatus === "completed"
    ) {
      if (
        quantity !== null &&
        quantity > 0
      ) {
        delivered = quantity;
        remains = 0;
        percent = 100;
      }
    }

    const orderStatus =
      data.status ||
      data.mappedStatus ||
      "pending";

    return {
      ok: true,

      orderId: data.orderId,
      providerOrderId: data.providerOrderId,

      tracked: Boolean(data.tracked),
      refreshed: Boolean(data.refreshed),

      /*
       * Fields consumed by orders.js
       */
      submitted,
      quantity,
      remains,
      delivered,
      percent,

      orderStatus,

      label: getLabel(
        providerStatus,
        data.mappedStatus || orderStatus
      ),

      /*
       * Used by orders.js for the 60-second
       * refresh/cooldown system.
       */
      syncedAt:
        data.providerSyncedAt || null,

      providerStatus,
    };
  } catch {
    return {
      ok: false,
      error:
        "Could not reach the tracking service. Please check your connection and try again.",
    };
  }
}
"use strict";
var __StripeExtExports = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // .build/manifest.js
  var manifest_exports = {};
  __export(manifest_exports, {
    BUILD_TIME: () => BUILD_TIME,
    default: () => manifest_default
  });
  var BUILD_TIME = "2026-10-23 11:06:14.237388 -0400 EDT m=+1.837386168";
  var manifest_default = {
    "$schema": "https://stripe.com/stripe-app.schema.json",
    "allowed_redirect_uris": [
      "https://app.aggregate.finance/api/connectors/stripe/callback",
      "https://staging.aggregate.finance/api/connectors/stripe/callback"
    ],
    "distribution_type": "public",
    "icon": "./icon.png",
    "id": "finance.aggregate.books",
    "name": "Aggregate",
    "permissions": [
      {
        "permission": "balance_read",
        "purpose": "Show your Stripe balance with your bank balances, so cash on hand is complete."
      },
      {
        "permission": "balance_transaction_source_read",
        "purpose": "Read each charge, refund and fee behind your balance, so revenue and fees are booked correctly."
      },
      {
        "permission": "payout_read",
        "purpose": "Match each Stripe payout to the deposit in your bank account."
      },
      {
        "permission": "invoice_read",
        "purpose": "Show what customers owe you and when invoices were paid."
      },
      {
        "permission": "subscription_read",
        "purpose": "Calculate monthly recurring revenue (MRR)."
      },
      {
        "permission": "plan_read",
        "purpose": "Read the tiers of tiered prices, so monthly recurring revenue (MRR) counts them."
      },
      {
        "permission": "coupon_read",
        "purpose": "Leave discounts out of MRR so it matches what customers actually pay."
      },
      {
        "permission": "customer_read",
        "purpose": "Show who paid each charge by the customer's name, instead of an id."
      },
      {
        "permission": "connected_account_read",
        "purpose": "Show your business name on the connection."
      },
      {
        "permission": "event_read",
        "purpose": "Notice new payments, payouts and invoices quickly, so your numbers stay current."
      }
    ],
    "stripe_api_access_type": "oauth",
    "version": "1.0.3"
  };
  return __toCommonJS(manifest_exports);
})();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsibWFuaWZlc3QuanMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEFVVE9HRU5FUkFURUQgLSBETyBOT1QgTU9ESUZZXG5cbi8vIFRpbWVzdGFtcCBjaGFuZ2VzIG9uIGV2ZXJ5IGV4cG9ydCwgZW5zdXJpbmcgdGhlIGRldiBzZXJ2ZXIgZGV0ZWN0cyBhIHJlYnVpbGRcbmV4cG9ydCBjb25zdCBCVUlMRF9USU1FID0gJzIwMjYtMTAtMjMgMTE6MDY6MTQuMjM3Mzg4IC0wNDAwIEVEVCBtPSsxLjgzNzM4NjE2OCc7XG5cbi8vIEFwcCBtYW5pZmVzdCBcdTIwMTQgY29uc3VtZWQgYnkgdGhlIERhc2hib2FyZCB0byBjb25maWd1cmUgdGhlIGFwcFxuZXhwb3J0IGRlZmF1bHQge1xuICBcIiRzY2hlbWFcIjogXCJodHRwczovL3N0cmlwZS5jb20vc3RyaXBlLWFwcC5zY2hlbWEuanNvblwiLFxuICBcImFsbG93ZWRfcmVkaXJlY3RfdXJpc1wiOiBbXG4gICAgXCJodHRwczovL2FwcC5hZ2dyZWdhdGUuZmluYW5jZS9hcGkvY29ubmVjdG9ycy9zdHJpcGUvY2FsbGJhY2tcIixcbiAgICBcImh0dHBzOi8vc3RhZ2luZy5hZ2dyZWdhdGUuZmluYW5jZS9hcGkvY29ubmVjdG9ycy9zdHJpcGUvY2FsbGJhY2tcIlxuICBdLFxuICBcImRpc3RyaWJ1dGlvbl90eXBlXCI6IFwicHVibGljXCIsXG4gIFwiaWNvblwiOiBcIi4vaWNvbi5wbmdcIixcbiAgXCJpZFwiOiBcImZpbmFuY2UuYWdncmVnYXRlLmJvb2tzXCIsXG4gIFwibmFtZVwiOiBcIkFnZ3JlZ2F0ZVwiLFxuICBcInBlcm1pc3Npb25zXCI6IFtcbiAgICB7XG4gICAgICBcInBlcm1pc3Npb25cIjogXCJiYWxhbmNlX3JlYWRcIixcbiAgICAgIFwicHVycG9zZVwiOiBcIlNob3cgeW91ciBTdHJpcGUgYmFsYW5jZSB3aXRoIHlvdXIgYmFuayBiYWxhbmNlcywgc28gY2FzaCBvbiBoYW5kIGlzIGNvbXBsZXRlLlwiXG4gICAgfSxcbiAgICB7XG4gICAgICBcInBlcm1pc3Npb25cIjogXCJiYWxhbmNlX3RyYW5zYWN0aW9uX3NvdXJjZV9yZWFkXCIsXG4gICAgICBcInB1cnBvc2VcIjogXCJSZWFkIGVhY2ggY2hhcmdlLCByZWZ1bmQgYW5kIGZlZSBiZWhpbmQgeW91ciBiYWxhbmNlLCBzbyByZXZlbnVlIGFuZCBmZWVzIGFyZSBib29rZWQgY29ycmVjdGx5LlwiXG4gICAgfSxcbiAgICB7XG4gICAgICBcInBlcm1pc3Npb25cIjogXCJwYXlvdXRfcmVhZFwiLFxuICAgICAgXCJwdXJwb3NlXCI6IFwiTWF0Y2ggZWFjaCBTdHJpcGUgcGF5b3V0IHRvIHRoZSBkZXBvc2l0IGluIHlvdXIgYmFuayBhY2NvdW50LlwiXG4gICAgfSxcbiAgICB7XG4gICAgICBcInBlcm1pc3Npb25cIjogXCJpbnZvaWNlX3JlYWRcIixcbiAgICAgIFwicHVycG9zZVwiOiBcIlNob3cgd2hhdCBjdXN0b21lcnMgb3dlIHlvdSBhbmQgd2hlbiBpbnZvaWNlcyB3ZXJlIHBhaWQuXCJcbiAgICB9LFxuICAgIHtcbiAgICAgIFwicGVybWlzc2lvblwiOiBcInN1YnNjcmlwdGlvbl9yZWFkXCIsXG4gICAgICBcInB1cnBvc2VcIjogXCJDYWxjdWxhdGUgbW9udGhseSByZWN1cnJpbmcgcmV2ZW51ZSAoTVJSKS5cIlxuICAgIH0sXG4gICAge1xuICAgICAgXCJwZXJtaXNzaW9uXCI6IFwicGxhbl9yZWFkXCIsXG4gICAgICBcInB1cnBvc2VcIjogXCJSZWFkIHRoZSB0aWVycyBvZiB0aWVyZWQgcHJpY2VzLCBzbyBtb250aGx5IHJlY3VycmluZyByZXZlbnVlIChNUlIpIGNvdW50cyB0aGVtLlwiXG4gICAgfSxcbiAgICB7XG4gICAgICBcInBlcm1pc3Npb25cIjogXCJjb3Vwb25fcmVhZFwiLFxuICAgICAgXCJwdXJwb3NlXCI6IFwiTGVhdmUgZGlzY291bnRzIG91dCBvZiBNUlIgc28gaXQgbWF0Y2hlcyB3aGF0IGN1c3RvbWVycyBhY3R1YWxseSBwYXkuXCJcbiAgICB9LFxuICAgIHtcbiAgICAgIFwicGVybWlzc2lvblwiOiBcImN1c3RvbWVyX3JlYWRcIixcbiAgICAgIFwicHVycG9zZVwiOiBcIlNob3cgd2hvIHBhaWQgZWFjaCBjaGFyZ2UgYnkgdGhlIGN1c3RvbWVyJ3MgbmFtZSwgaW5zdGVhZCBvZiBhbiBpZC5cIlxuICAgIH0sXG4gICAge1xuICAgICAgXCJwZXJtaXNzaW9uXCI6IFwiY29ubmVjdGVkX2FjY291bnRfcmVhZFwiLFxuICAgICAgXCJwdXJwb3NlXCI6IFwiU2hvdyB5b3VyIGJ1c2luZXNzIG5hbWUgb24gdGhlIGNvbm5lY3Rpb24uXCJcbiAgICB9LFxuICAgIHtcbiAgICAgIFwicGVybWlzc2lvblwiOiBcImV2ZW50X3JlYWRcIixcbiAgICAgIFwicHVycG9zZVwiOiBcIk5vdGljZSBuZXcgcGF5bWVudHMsIHBheW91dHMgYW5kIGludm9pY2VzIHF1aWNrbHksIHNvIHlvdXIgbnVtYmVycyBzdGF5IGN1cnJlbnQuXCJcbiAgICB9XG4gIF0sXG4gIFwic3RyaXBlX2FwaV9hY2Nlc3NfdHlwZVwiOiBcIm9hdXRoXCIsXG4gIFwidmVyc2lvblwiOiBcIjEuMC4zXCJcbn07XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBR08sTUFBTSxhQUFhO0FBRzFCLE1BQU8sbUJBQVE7QUFBQSxJQUNiLFdBQVc7QUFBQSxJQUNYLHlCQUF5QjtBQUFBLE1BQ3ZCO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFBQSxJQUNBLHFCQUFxQjtBQUFBLElBQ3JCLFFBQVE7QUFBQSxJQUNSLE1BQU07QUFBQSxJQUNOLFFBQVE7QUFBQSxJQUNSLGVBQWU7QUFBQSxNQUNiO0FBQUEsUUFDRSxjQUFjO0FBQUEsUUFDZCxXQUFXO0FBQUEsTUFDYjtBQUFBLE1BQ0E7QUFBQSxRQUNFLGNBQWM7QUFBQSxRQUNkLFdBQVc7QUFBQSxNQUNiO0FBQUEsTUFDQTtBQUFBLFFBQ0UsY0FBYztBQUFBLFFBQ2QsV0FBVztBQUFBLE1BQ2I7QUFBQSxNQUNBO0FBQUEsUUFDRSxjQUFjO0FBQUEsUUFDZCxXQUFXO0FBQUEsTUFDYjtBQUFBLE1BQ0E7QUFBQSxRQUNFLGNBQWM7QUFBQSxRQUNkLFdBQVc7QUFBQSxNQUNiO0FBQUEsTUFDQTtBQUFBLFFBQ0UsY0FBYztBQUFBLFFBQ2QsV0FBVztBQUFBLE1BQ2I7QUFBQSxNQUNBO0FBQUEsUUFDRSxjQUFjO0FBQUEsUUFDZCxXQUFXO0FBQUEsTUFDYjtBQUFBLE1BQ0E7QUFBQSxRQUNFLGNBQWM7QUFBQSxRQUNkLFdBQVc7QUFBQSxNQUNiO0FBQUEsTUFDQTtBQUFBLFFBQ0UsY0FBYztBQUFBLFFBQ2QsV0FBVztBQUFBLE1BQ2I7QUFBQSxNQUNBO0FBQUEsUUFDRSxjQUFjO0FBQUEsUUFDZCxXQUFXO0FBQUEsTUFDYjtBQUFBLElBQ0Y7QUFBQSxJQUNBLDBCQUEwQjtBQUFBLElBQzFCLFdBQVc7QUFBQSxFQUNiOyIsCiAgIm5hbWVzIjogW10KfQo=

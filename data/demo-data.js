/**
 * BTECH SMM — Demo Data
 * ----------------------------------------------------------------
 * All service and seed data lives here so nothing is hard-coded
 * across individual HTML pages. In a later phase this module will
 * be replaced by live queries against the Supabase `services`,
 * `providers` and `provider_services` tables — the shape below is
 * intentionally close to that future schema so the swap is a
 * find-and-replace of the data source, not a rewrite of the UI.
 *
 * DEMO DATA ONLY — prices, quantities and descriptions below are
 * placeholders for building the interface and are not live offers.
 */

export const PLATFORMS = [
  { id: "tiktok", label: "TikTok" },
  { id: "instagram", label: "Instagram" },
  { id: "youtube", label: "YouTube" },
  { id: "facebook", label: "Facebook" },
  { id: "x", label: "X" },
  { id: "telegram", label: "Telegram" },
];

export const CATEGORIES = [
  { id: "followers", label: "Followers & Subscribers" },
  { id: "engagement", label: "Likes & Engagement" },
  { id: "views", label: "Views & Plays" },
  { id: "analytics", label: "Analytics & Insights" },
  { id: "management", label: "Management" },
];

export const SERVICES = [
  {
    id: "svc-tt-followers",
    platform: "tiktok",
    category: "followers",
    name: "TikTok Content Promotion",
    description: "Promote a TikTok profile to a wider audience with steady, gradual delivery.",
    pricePer1000: 220,
    min: 100,
    max: 50000,
    featured: true,
  },
  {
    id: "svc-tt-views",
    platform: "tiktok",
    category: "views",
    name: "TikTok Video Views",
    description: "Increase view counts on a specific TikTok video over a controlled delivery window.",
    pricePer1000: 15,
    min: 500,
    max: 500000,
  },
  {
    id: "svc-tt-likes",
    platform: "tiktok",
    category: "engagement",
    name: "TikTok Engagement Boost",
    description: "Add likes to a TikTok post to support existing engagement.",
    pricePer1000: 90,
    min: 50,
    max: 20000,
  },
  {
    id: "svc-ig-campaign",
    platform: "instagram",
    category: "followers",
    name: "Instagram Campaign Promotion",
    description: "Grow an Instagram profile's reach through a structured promotional campaign.",
    pricePer1000: 260,
    min: 100,
    max: 30000,
    featured: true,
  },
  {
    id: "svc-ig-likes",
    platform: "instagram",
    category: "engagement",
    name: "Instagram Post Engagement",
    description: "Add likes to an Instagram post or reel to support existing engagement.",
    pricePer1000: 110,
    min: 50,
    max: 15000,
  },
  {
    id: "svc-ig-views",
    platform: "instagram",
    category: "views",
    name: "Instagram Reel Views",
    description: "Increase view counts on an Instagram reel over a controlled delivery window.",
    pricePer1000: 20,
    min: 500,
    max: 250000,
  },
  {
    id: "svc-yt-promotion",
    platform: "youtube",
    category: "views",
    name: "YouTube Promotion",
    description: "Promote a YouTube video to a wider audience with steady, gradual delivery.",
    pricePer1000: 180,
    min: 500,
    max: 200000,
    featured: true,
  },
  {
    id: "svc-yt-subs",
    platform: "youtube",
    category: "followers",
    name: "YouTube Channel Growth",
    description: "Grow a YouTube channel's subscriber base through a structured campaign.",
    pricePer1000: 340,
    min: 100,
    max: 10000,
  },
  {
    id: "svc-fb-campaign",
    platform: "facebook",
    category: "followers",
    name: "Facebook Campaign Promotion",
    description: "Grow a Facebook page's reach through a structured promotional campaign.",
    pricePer1000: 200,
    min: 100,
    max: 40000,
  },
  {
    id: "svc-fb-engagement",
    platform: "facebook",
    category: "engagement",
    name: "Facebook Post Engagement",
    description: "Add reactions to a Facebook post to support existing engagement.",
    pricePer1000: 95,
    min: 50,
    max: 15000,
  },
  {
    id: "svc-x-followers",
    platform: "x",
    category: "followers",
    name: "X Profile Growth",
    description: "Grow an X (formerly Twitter) profile's reach through a structured campaign.",
    pricePer1000: 300,
    min: 100,
    max: 20000,
  },
  {
    id: "svc-x-engagement",
    platform: "x",
    category: "engagement",
    name: "X Post Engagement",
    description: "Add engagement to a post on X to support existing activity.",
    pricePer1000: 130,
    min: 50,
    max: 10000,
  },
  {
    id: "svc-tg-members",
    platform: "telegram",
    category: "followers",
    name: "Telegram Channel Growth",
    description: "Grow a Telegram channel or group's member base gradually.",
    pricePer1000: 160,
    min: 100,
    max: 50000,
  },
  {
    id: "svc-tg-views",
    platform: "telegram",
    category: "views",
    name: "Telegram Post Views",
    description: "Increase view counts on a Telegram channel post.",
    pricePer1000: 12,
    min: 500,
    max: 300000,
  },
  {
    id: "svc-analytics",
    platform: "instagram",
    category: "analytics",
    name: "Social Media Analytics",
    description: "A monthly report covering growth trends, audience insights and content performance.",
    pricePer1000: 2500,
    min: 1,
    max: 1,
    unit: "report",
  },
  {
    id: "svc-management",
    platform: "facebook",
    category: "management",
    name: "Social Media Management",
    description: "Ongoing content planning and posting support for one connected profile per month.",
    pricePer1000: 8000,
    min: 1,
    max: 1,
    unit: "month",
    featured: true,
  },
];

export const FAQS = [
  {
    q: "What is BTECH SMM?",
    a: "BTECH SMM is a social-media marketing platform that helps creators, brands and businesses plan and track digital growth campaigns from a single dashboard.",
  },
  {
    q: "Is this platform live with real payments yet?",
    a: "The platform is currently in its foundation phase. Accounts, orders and wallet balances you see now are running in demo mode while the underlying account and payment systems are being built.",
  },
  {
    q: "Which platforms are supported?",
    a: "TikTok, Instagram, YouTube, Facebook, X and Telegram are supported, with more platforms planned as the service catalogue grows.",
  },
  {
    q: "How will payments work?",
    a: "M-Pesa via Safaricom Daraja is planned as the primary payment method for the Kenyan market, alongside a wallet system for topping up and spending balance across orders.",
  },
  {
    q: "How do I track an order?",
    a: "Every order gets a status and progress indicator on the Orders page, with a detailed timeline available on each order's details page.",
  },
  {
    q: "Do you support account takeovers or engagement manipulation that breaks platform rules?",
    a: "No. BTECH SMM is built around legitimate, platform-compliant marketing services only.",
  },
];

export const HOW_IT_WORKS = [
  { step: 1, title: "Create an account", text: "Sign up in a few seconds and set up your BTECH SMM profile." },
  { step: 2, title: "Choose a service", text: "Browse services by platform and pick the one that fits your goal." },
  { step: 3, title: "Submit your order", text: "Enter your target link and quantity, then confirm your order." },
  { step: 4, title: "Track your progress", text: "Follow delivery status from your dashboard until it's complete." },
];

export const WHY_BTECH = [
  { title: "Fast Processing", text: "Orders begin processing quickly once confirmed." },
  { title: "Simple Dashboard", text: "Everything you need in one clean, organised view." },
  { title: "Secure Accounts", text: "Your account and order data are handled carefully." },
  { title: "Transparent Pricing", text: "Clear per-unit pricing with no hidden charges." },
  { title: "24/7 Order Tracking", text: "Check the status of any order at any time." },
  { title: "Professional Support", text: "A support team ready to help with any question." },
];

// Note: earlier pre-Supabase versions of this file also exported hardcoded
// SEED_USER / SEED_WALLET / SEED_TRANSACTIONS / SEED_ORDERS /
// SEED_NOTIFICATIONS / SEED_TICKETS fake records for a fully local demo
// mode. They were never imported by any live-data page (dashboard, orders,
// wallet, notifications, support all read from Supabase) and have been
// removed as dead demo business data. SERVICES (offline-fallback catalogue)
// and FAQS (static marketing copy) above are the only exports still used.

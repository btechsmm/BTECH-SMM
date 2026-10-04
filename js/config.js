/**
 * BTECH SMM — Public Config
 * ----------------------------------------------------------------
 * Non-secret, editable configuration values used across the app.
 * Nothing in this file is sensitive — it's safe to ship in frontend code.
 *
 * BUSINESS is the single source of truth for BTECH SMM's official contact
 * details. The footer, WhatsApp button, terms/privacy pages, ambassador
 * badge and verification page all read from here — change them once, here.
 */
export const BUSINESS = Object.freeze({
    name: "BTECH SMM",
    email: "btech.smm1@gmail.com",
    phone: "+254112887428", // customer care / support / WhatsApp, display format
    whatsappNumber: "254112887428", // international format, digits only, for wa.me links
    website: "https://btechsmm.store",
});

export const WHATSAPP_NUMBER = BUSINESS.whatsappNumber;
export const WHATSAPP_DEFAULT_MESSAGE = "Hello BTECH SMM, I need help with my account/order How can i get assisted?";
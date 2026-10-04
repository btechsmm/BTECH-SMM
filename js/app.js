/**
 * BTECH SMM — App entry point (loaded as a module by every page)
 * ----------------------------------------------------------------
 * Kept deliberately tiny. The real bootstrap lives in main.js, which pulls in
 * the Supabase library from a CDN, checks the session and loads the page's data
 * (hundreds of milliseconds, sometimes a second or more).
 *
 * shell.js has no such dependencies, so it runs first and paints the permanent
 * sidebar/top-bar frame immediately. Importing main.js dynamically (rather than
 * statically) is what stops the sidebar waiting behind that slow module graph.
 */

import "./shell.js";

import("./main.js").catch((err) => console.error("BTECH SMM failed to start:", err));

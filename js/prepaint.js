/**
 * BTECH SMM — pre-paint (classic script, NOT a module)
 * ----------------------------------------------------------------
 * Loaded synchronously as the first thing inside <body> on every customer page:
 *     <body ...><script src="js/prepaint.js"></script>
 *
 * Why it exists: every click on the sidebar is a full page load. The real sidebar is built by shell.js, an ES
 * module, which runs only after the page has been parsed, so the new page's FIRST frame had no sidebar. It
 * disappeared and came back (and the layout twitched) on every navigation.
 *
 * What it does, before the browser draws anything:
 *   1. Applies the saved theme (so there is no light flash before dark mode kicks in).
 *   2. Draws the sidebar from the copy shell.js saved on the previous page, and marks the current page's link.
 *
 * It does no network work, never touches auth or data, and does nothing on the first-ever visit (nothing saved
 * yet) or if storage is blocked: shell.js then builds the sidebar exactly as it always did.
 * The storage key must match SIDEBAR_TPL_KEY in shell.js.
 */
(function () {
  try {
    var root = document.documentElement;
    var saved = null;
    try {
      saved = localStorage.getItem("btechsmm:theme");
    } catch (e) {
      /* storage blocked */
    }
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = saved || (prefersDark ? "dark" : "light");

    var body = document.body;
    if (!body || body.dataset.nav !== "customer") return;

    // Same test shell.js uses: Supabase keeps the session in localStorage under sb-<project>-auth-token.
    var signedIn = false;
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (/^sb-.+-auth-token$/.test(k) && localStorage.getItem(k)) {
        signedIn = true;
        break;
      }
    }

    var tpl = localStorage.getItem("btech:sidebar-tpl:v1:" + (signedIn ? "a" : "g"));
    // Only ever our own markup: refuse anything that looks like script.
    if (!tpl || /<script|\son[a-z]+\s*=/i.test(tpl)) return;
    if (document.querySelector(".customer-sidebar")) return;

    body.insertAdjacentHTML("afterbegin", '<aside class="customer-sidebar" aria-label="Sidebar"></aside>');
    var aside = body.firstElementChild;
    aside.innerHTML = tpl;
    aside.__tpl = tpl; // lets shell.js see the sidebar is already correct and leave it alone

    var page = body.dataset.page || "";
    var links = aside.querySelectorAll("[data-nav-key]");
    for (var j = 0; j < links.length; j++) {
      if (links[j].getAttribute("data-nav-key") === page) {
        links[j].classList.add("sidebar-link--active");
        links[j].setAttribute("aria-current", "page");
        break;
      }
    }
  } catch (e) {
    /* never block the page: shell.js is the fallback */
  }
})();

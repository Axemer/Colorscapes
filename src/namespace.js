/* =========================================================
   Namespace
   Every module attaches its public API to window.GS, so plain
   <script> tags stay isolated and order-independent.
   Load this file first.
   ========================================================= */

window.GS = window.GS || {};

/* Shorthand for the many getElementById calls across the UI. */
window.GS.byId = function (id) {
  return document.getElementById(id);
};

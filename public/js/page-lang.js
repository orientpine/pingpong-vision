// The page language before any module runs, from the device setting pp-lang (the tournament app and
// the camera share it). A classic script, not inline: the pages' Content-Security-Policy allows only
// scripts from this origin. An element with data-en (the title, the description, an iframe's title)
// takes its English text from that attribute.
(function () {
  var en = false;
  try {
    en = localStorage.getItem("pp-lang") === "en";
  } catch (e) {}
  document.documentElement.lang = en ? "en" : "ko";
  if (!en) return;
  document.querySelectorAll("[data-en]").forEach(function (el) {
    if (el.tagName === "TITLE") document.title = el.dataset.en;
    else if (el.hasAttribute("content")) el.setAttribute("content", el.dataset.en);
    else el.setAttribute("title", el.dataset.en);
  });
})();

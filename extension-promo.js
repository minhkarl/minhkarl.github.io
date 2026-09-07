(() => {
  const SEEN_KEY = "ofExtensionBadgeSeen";

  const wrap = document.querySelector(".extensionBadgeWrap");
  const badge = document.getElementById("extensionBadge");
  const dot = document.getElementById("extensionBadgeDot");
  const dropdown = document.getElementById("extensionDropdown");
  if (!wrap || !badge || !dot || !dropdown) return;

  try {
    if (localStorage.getItem(SEEN_KEY) === "1") dot.hidden = true;
  } catch (_) {}

  function setOpen(open) {
    dropdown.hidden = !open;
    badge.setAttribute("aria-expanded", String(open));
    if (open) {
      dot.hidden = true;
      try {
        localStorage.setItem(SEEN_KEY, "1");
      } catch (_) {}
    }
  }

  badge.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(dropdown.hidden);
  });

  document.addEventListener("click", (e) => {
    if (!dropdown.hidden && !wrap.contains(e.target)) setOpen(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !dropdown.hidden) setOpen(false);
  });
})();

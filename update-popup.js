(() => {
  const SEEN_KEY = "ofUpdatePopupSeen_v0.34.0-beta1";

  const backdrop = document.getElementById("updatePopupBackdrop");
  const popup = document.getElementById("updatePopup");
  const closeBtn = document.getElementById("updatePopupClose");
  const dismissBtn = document.getElementById("updatePopupDismiss");
  if (!backdrop || !popup || !closeBtn || !dismissBtn) return;

  let alreadySeen = false;
  try {
    alreadySeen = localStorage.getItem(SEEN_KEY) === "1";
  } catch (_) {}
  if (alreadySeen) return;

  function close() {
    backdrop.hidden = true;
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch (_) {}
  }

  backdrop.hidden = false;

  closeBtn.addEventListener("click", close);
  dismissBtn.addEventListener("click", close);

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !backdrop.hidden) close();
  });
})();

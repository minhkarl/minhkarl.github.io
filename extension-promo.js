      (() => {
        const PROMO_VERSION = "1"; // bump to re-show after dismissal for a future announcement
        const DISMISS_KEY = "ofExtensionPromoDismissed";

        const promo = document.getElementById("extensionPromo");
        const closeBtn = document.getElementById("extensionPromoClose");
        const toggleBtn = document.getElementById("extensionPromoToggle");
        const steps = document.getElementById("extensionPromoSteps");
        if (!promo || !closeBtn || !toggleBtn || !steps) return;

        let dismissedVersion = null;
        try {
          dismissedVersion = localStorage.getItem(DISMISS_KEY);
        } catch (_) {}

        if (dismissedVersion === PROMO_VERSION) return;

        setTimeout(() => {
          promo.hidden = false;
        }, 1200);

        closeBtn.addEventListener("click", () => {
          promo.hidden = true;
          try {
            localStorage.setItem(DISMISS_KEY, PROMO_VERSION);
          } catch (_) {}
        });

        toggleBtn.addEventListener("click", () => {
          const expanded = toggleBtn.getAttribute("aria-expanded") === "true";
          toggleBtn.setAttribute("aria-expanded", String(!expanded));
          steps.hidden = expanded;
        });
      })();

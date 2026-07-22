import { useEffect, useState } from "react";

// Light/dark theme stored in localStorage and stamped on <html data-theme>.
export function useTheme() {
  const [dark, setDark] = useState(
    () =>
      (localStorage.getItem("cf_theme") ??
        (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark",
  );
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    localStorage.setItem("cf_theme", dark ? "dark" : "light");
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

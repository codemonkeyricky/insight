import { useEffect, useState } from "react";
import { applyTheme, readTheme, THEME_CHOICES, THEME_EVENT, writeTheme, type ThemeChoice } from "../theme";

const LABELS: Record<ThemeChoice, string> = { system: "System", light: "Light", dark: "Dark" };

/** A segmented control for the colour theme, in the page header. */
export function ThemeSwitch() {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  // Another switch (or the Find palette's Theme command) may change the theme; this one follows it.
  useEffect(() => {
    const sync = () => setChoice(readTheme());
    window.addEventListener(THEME_EVENT, sync);
    return () => window.removeEventListener(THEME_EVENT, sync);
  }, []);
  const pick = (next: ThemeChoice) => {
    setChoice(next);
    writeTheme(next);
    applyTheme(next);
  };
  return (
    <div className="seg theme-switch" role="group" aria-label="Colour theme">
      {THEME_CHOICES.map((t) => (
        <button key={t} type="button" aria-pressed={choice === t} onClick={() => pick(t)}>
          {LABELS[t]}
        </button>
      ))}
    </div>
  );
}

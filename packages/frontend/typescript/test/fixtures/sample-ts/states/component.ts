import { useState } from "react";

export type Mode = "view" | "edit";

export function Panel(): Mode {
  const [mode, setMode] = useState<Mode>("view");
  const toggle = (): void => {
    if (mode === "view") setMode("edit");
  };
  toggle();
  return mode;
}

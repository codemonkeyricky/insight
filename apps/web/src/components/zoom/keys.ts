// Keys that press a control drawn in the map (an SVG button or row): Enter and Space, as a native button takes them.

/** Whether a key press activates a control: Enter, or Space (its key is " "). */
export const keyActivates = (key: string): boolean => key === "Enter" || key === " " || key === "Spacebar";

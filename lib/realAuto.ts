/** Names shared by the automatic-orders runner (in the shell) and the screens that show what it did. */

/** A look by the automation just came back: `detail` is { at: number, result } as POST /real-orders/auto/tick answered. */
export const REAL_AUTO_LOOK = "egx-real-auto-look";
/** Ask the shell to show a toast: `detail` is { seq, title, message, note?, symbol? }. */
export const SHOW_TOAST = "egx-toast";
/** The owner changed whether the screen is kept awake while automatic orders run. */
export const REAL_AUTO_AWAKE = "egx-real-auto-awake";
export const AWAKE_KEY = "egx-auto-awake";

export const LOOK_MS = 30 * 1000;

/**
 * Lobby navigation model (v1.5.1): the pure, DOM-free part of the main menu's left nav, so it can be unit-tested.
 *
 * The main menu has exactly three entries: PLAY, ONLINE (only when the online handler is wired) and SETTINGS.
 * PLAY is the one way into the offline game modes (the gold PLAY button does the same): it opens the mode-select screen.
 */

export type NavId = 'play' | 'online' | 'settings';
/** The two views the lobby itself can show: the home view (gladiator preview) and the Settings panel. */
export type LobbyView = 'play' | 'settings';

export interface NavEntry {
  readonly id: NavId;
  readonly label: string;
}

/** The nav entries in display order. ONLINE is hidden when there is no online handler. */
export function lobbyNavEntries(hasOnline: boolean): readonly NavEntry[] {
  const entries: NavEntry[] = [{ id: 'play', label: 'Play' }];
  if (hasOnline) entries.push({ id: 'online', label: 'Online' });
  entries.push({ id: 'settings', label: 'Settings' });
  return entries;
}

/** What a nav click does. */
export type NavAction =
  /** Leave the lobby for the mode-select screen (same as the gold PLAY button). */
  | { readonly type: 'openModes' }
  /** Leave the lobby for the Online screen. */
  | { readonly type: 'openOnline' }
  /** Stay in the lobby and show this view (`play` = the home view with the gladiator preview). */
  | { readonly type: 'show'; readonly view: LobbyView };

/**
 * Resolve a nav click given the view that is currently showing. There is never a dead button: PLAY on the home view
 * opens the mode select, PLAY while Settings is open returns to the home view, SETTINGS always shows the panel.
 */
export function resolveNavClick(clicked: NavId, active: LobbyView): NavAction {
  if (clicked === 'online') return { type: 'openOnline' };
  if (clicked === 'settings') return { type: 'show', view: 'settings' };
  return active === 'play' ? { type: 'openModes' } : { type: 'show', view: 'play' };
}

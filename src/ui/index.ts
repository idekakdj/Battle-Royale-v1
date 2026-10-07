/**
 * WP-F public surface. Importing anything from `src/ui` through this barrel also
 * pulls in the UI stylesheet (Vite handles the CSS import), so WP-I never needs
 * to touch index.html for styling.
 */

import '../styles/ui.css';
import '../styles/brawl.css';

export { Lobby, type LobbyOptions } from './Lobby';
export { ModeSelect, type ModeSelectOptions } from './ModeSelect';
export { CharacterSelect, type CharacterSelectOptions } from './CharacterSelect';
export { DifficultySelect, type DifficultySelectOptions } from './DifficultySelect';
export { HUD, type KillFeedEntry, type CountdownStep, type SpectateTarget } from './HUD';
export { Results, type MatchResults, type ResultsOptions } from './Results';
export { PauseMenu, type PauseMenuOptions } from './PauseMenu';
export { SettingsPanel, type SettingsPanelOptions } from './SettingsPanel';
export { setPreviewFactory, getPreviewFactory, type PreviewFactory, type PreviewHandle } from './previewHook';
export {
  loadSettings,
  saveSettings,
  loadAnimal,
  saveAnimal,
  loadDifficulty,
  saveDifficulty,
  loadArena,
  saveArena,
  parseArena,
  DEFAULT_ARENA,
  ARENA_KEY,
  SETTINGS_KEY,
  ANIMAL_KEY,
  DIFFICULTY_KEY,
  BRAWL_KEY,
  MODE_KEY,
  loadMode,
  saveMode,
  loadBrawlSetup,
  saveBrawlSetup,
  type GkSettings,
  type GameMode,
} from './storage';

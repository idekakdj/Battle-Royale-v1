/**
 * WP-F public surface. Importing anything from `src/ui` through this barrel also
 * pulls in the UI stylesheet (Vite handles the CSS import), so WP-I never needs
 * to touch index.html for styling.
 */

import '../styles/ui.css';

export { Lobby, type LobbyOptions } from './Lobby';
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
  SETTINGS_KEY,
  ANIMAL_KEY,
  DIFFICULTY_KEY,
  type GkSettings,
} from './storage';

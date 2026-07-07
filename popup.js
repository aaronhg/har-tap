// popup.js — the popup entry point. All the logic lives in the shared core (core/popup-core.js);
// har-tap runs it with no plugins. A downstream consumer can reuse core/ via a git submodule and pass a
// popup plugin here to add extra option inputs + a results panel — see core/popup-core.js for the seams.

import { initPopup } from './core/popup-core.js';

initPopup({ plugins: [] });

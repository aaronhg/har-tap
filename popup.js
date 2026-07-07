// popup.js — the popup entry point. All the logic lives in the shared core (core/popup-core.js);
// har-tap runs it with one bundled plugin (the throttling select). A downstream consumer can reuse
// core/ via a git submodule and pass more popup plugins here — see core/popup-core.js for the seams.

import { initPopup } from './core/popup-core.js';
import { throttlePopup } from './plugins/throttle.js';

initPopup({ plugins: [throttlePopup()] });

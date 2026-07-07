// background.js — the MV3 service worker entry point. The whole capture engine lives in the shared
// core (core/capture-core.js); har-tap wires it up with no plugins, so it's the plain chrome.debugger →
// HAR tool. A downstream consumer can reuse core/ via a git submodule and pass plugins here to layer on
// extra capture behaviour — see core/capture-core.js for the plugin hook surface.

import { createCapture } from './core/capture-core.js';

createCapture({ plugins: [] });

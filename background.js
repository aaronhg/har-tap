// background.js — the MV3 service worker entry point. The whole capture engine lives in the shared
// core (core/capture-core.js); har-tap wires it with one bundled plugin (DevTools-parity network
// throttling). A downstream consumer can reuse core/ via a git submodule and pass more plugins here —
// see core/capture-core.js for the plugin hook surface.

import { createCapture } from './core/capture-core.js';
import { throttleCapture } from './plugins/throttle.js';

createCapture({ plugins: [throttleCapture()] });
